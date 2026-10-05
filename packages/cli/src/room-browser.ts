import blessed from 'blessed';
import type {Key} from 'node:readline';
import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore} from '@pairlobby/client';
import type {RoomListEntry} from './render.js';
import {NETWORK_STATE, ROOM_COLUMNS, SESSION_COLUMNS, closeListedRoom, leaveListedSession, loadRoomList, networkRows, roomRows, sessionRows, sortListRows} from './room-list.js';
import type {ListColumn, ListRow, ListSort, NetworkRoom} from './room-list.js';
import {RoomPanel} from './room-panel.js';
import type {RoomPanelPage} from './room-panel.js';
import {plainCell} from './agent-roster.js';
import {receiverConfiguration, startReceiver, stopReceiver} from './receiver.js';
import {copyToClipboard} from './clipboard.js';
import {createTerminalProgram} from './terminal-program.js';

/** A saved session to open, or a room found on the network to join first. */
export type RoomBrowserSelection = {roomId: string; sessionId: string} | {roomId: string; joinAt: string};
/** `discover` finds rooms open on the network; it must stop when its signal aborts. Absent, the list shows saved rooms only. */
export type RoomBrowserOptions = {sort: ListSort; roomId?: string | undefined; sessionId?: string | undefined; notice?: string | undefined; discover?: ((known: ReadonlySet<string>, signal: AbortSignal) => Promise<NetworkRoom[]>) | undefined};
type BrowserKey = Key & {sequence?: string};
type BrowserMouse = blessed.Widgets.Events.IMouseEventArg & {button?: string};

/** A standalone room/session navigator. Only explicit, confirmed actions write to a room. */
export class RoomBrowser {
    private screen: blessed.Widgets.Screen;
    private surface: blessed.Widgets.BoxElement;
    private details: RoomPanel;
    private cells: blessed.Widgets.BoxElement[] = [];
    private entries: RoomListEntry[] = [];
    private network: NetworkRoom[] = [];
    private join: RoomBrowserSelection | undefined;
    private rows: ListRow[] = [];
    private roomId: string | undefined;
    private selected = 0;
    private column = 0;
    private top = 0;
    private firstColumn = 0;
    private roomSort: ListSort;
    private sessionSort: ListSort = {key: 'name', descending: false};
    private loading = false;
    private closed = false;
    private note = '';
    private actionNotice = '';
    private request: AbortController | undefined;
    private finish: ((selection: RoomBrowserSelection | undefined) => void) | undefined;
    private initialSessionId: string | undefined;

    constructor(private readonly store: LocalStore, private readonly options: RoomBrowserOptions) {
        this.screen = blessed.screen({program: createTerminalProgram(), smartCSR: true, fullUnicode: true, title: 'PairLobby rooms', warnings: false});
        this.surface = blessed.box({parent: this.screen, top: 0, left: 0, right: 0, bottom: 0});
        this.roomId = options.roomId;
        this.initialSessionId = options.sessionId;
        this.roomSort = options.sort;
        this.details = new RoomPanel({screen: this.screen, close: () => {
            if (this.join) {
                this.close(this.join);
                return;
            }
            void this.refresh(this.actionNotice);
            this.actionNotice = '';
        }});
        this.screen.on('keypress', (character: string, key: BrowserKey) => this.key(character, key));
        this.screen.on('resize', () => this.details.visible ? this.details.render() : this.render());
        this.screen.program.enableMouse();
    }

    run(): Promise<RoomBrowserSelection | undefined> {
        return new Promise((resolve) => {
            this.finish = resolve;
            void this.refresh(this.options.notice ?? '');
        });
    }

    private close(selection?: RoomBrowserSelection): void {
        this.closed = true;
        this.request?.abort();
        this.details.hide();
        this.screen.destroy();
        process.stdin.pause();
        this.finish?.(selection);
    }

    private key(character: string, key: BrowserKey): void {
        if (this.closed || (key.name === 'return' && key.sequence === '\r')) {
            return;
        }
        if (this.details.visible) {
            this.details.key(character, key);
            return;
        }
        if ((key.ctrl && key.name === 'c') || key.name === 'q') {
            this.close();
            return;
        }
        if (key.name === 'escape' || key.name === 'backspace') {
            if (this.roomId) {
                const id = this.roomId;
                this.roomId = undefined;
                this.column = this.top = this.firstColumn = 0;
                this.rebuildRows(id);
            } else {
                this.close();
            }
            return;
        }
        if (key.name === 'r') {
            void this.refresh();
            return;
        }
        if (this.loading) {
            return;
        }
        if (key.name === 'up' || key.name === 'down') {
            this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + (key.name === 'up' ? -1 : 1)));
        } else if (key.name === 'pageup' || key.name === 'pagedown') {
            this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + (key.name === 'pageup' ? -1 : 1) * this.pageSize()));
        } else if (key.name === 'home' || key.name === 'end') {
            this.selected = key.name === 'home' ? 0 : Math.max(0, this.rows.length - 1);
        } else if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
            this.column = Math.max(0, Math.min(this.columns().length - 1, this.column + (key.name === 'left' || key.shift ? -1 : 1)));
        } else if (key.name === 's') {
            this.sortBy(this.columns()[this.column]!.key);
        } else if (key.name === 'enter' || key.name === 'return') {
            this.openSelected();
            return;
        } else if (key.name === 'c') {
            this.confirmClose();
            return;
        } else if (key.name === 'i') {
            this.showSession();
            return;
        } else if (key.name === 'y') {
            const row = this.rows[this.selected];
            if (row) {
                void copyToClipboard(row.values[this.columns()[this.column]!.key] ?? '').then((message) => { this.note = message; this.render(); }).catch(() => { this.note = 'Copy failed'; this.render(); });
            }
        }
        this.render();
    }

    private columns(): ListColumn[] {
        return this.roomId ? SESSION_COLUMNS : ROOM_COLUMNS;
    }

    private sort(): ListSort {
        return this.roomId ? this.sessionSort : this.roomSort;
    }

    private pageSize(): number {
        return Math.max(1, Number(this.screen.height) - 8);
    }

    private async refresh(notice = ''): Promise<void> {
        this.request?.abort();
        const request = new AbortController();
        this.request = request;
        const selected = this.rows[this.selected]?.id ?? this.initialSessionId;
        this.initialSessionId = undefined;
        this.loading = true;
        this.note = 'Loading room snapshots…';
        this.render();
        try {
            const entries = await loadRoomList(this.store, request.signal);
            if (this.closed || this.request !== request) {
                return;
            }
            this.entries = entries;
            this.network = this.network.filter((found) => !entries.some((entry) => entry.room.roomId === found.room.roomId));
            this.note = notice || 'Snapshot updated. Listing does not join rooms or start agents.';
            this.loading = false;
            this.rebuildRows(selected);
            if (this.options.discover) {
                void this.discover(request);
            }
        } catch (error) {
            if (!this.closed && this.request === request) {
                this.loading = false;
                this.note = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
                this.render();
            }
        }
    }

    /** Looks for rooms open to the network after the saved ones are shown, so the list never waits on it. */
    private async discover(request: AbortController): Promise<void> {
        let found: NetworkRoom[];
        try {
            found = await this.options.discover!(new Set(this.entries.map((entry) => entry.room.roomId)), request.signal);
        } catch {
            return;
        }
        if (this.closed || this.request !== request) {
            return;
        }
        this.network = found;
        if (!this.roomId && !this.details.visible) {
            this.rebuildRows(this.rows[this.selected]?.id);
        }
    }

    private rebuildRows(selectedId?: string): void {
        const room = this.entries.find((entry) => entry.room.roomId === this.roomId);
        if (this.roomId && !room) {
            this.roomId = undefined;
            this.column = this.firstColumn = 0;
        }
        this.rows = sortListRows(room && this.roomId ? sessionRows(this.store, room) : [...roomRows(this.entries), ...networkRows(this.network)], this.sort());
        this.selected = selectedId ? Math.max(0, this.rows.findIndex((row) => row.id === selectedId)) : Math.max(0, Math.min(this.selected, this.rows.length - 1));
        this.render();
    }

    private sortBy(key: string): void {
        const previous = this.sort();
        const sort = {key, descending: previous.key === key ? !previous.descending : false};
        if (this.roomId) {
            this.sessionSort = sort;
        } else {
            this.roomSort = sort;
        }
        this.rebuildRows(this.rows[this.selected]?.id);
    }

    private openSelected(): void {
        const row = this.rows[this.selected];
        if (!row) {
            return;
        }
        const found = this.roomId ? undefined : this.network.find((candidate) => candidate.room.roomId === row.roomId);
        if (found) {
            this.confirmJoin(found);
        } else if (!this.roomId) {
            this.roomId = row.roomId;
            this.selected = this.column = this.top = this.firstColumn = 0;
            this.note = 'Local saved sessions. Enter opens human chat; I inspects a session.';
            this.rebuildRows();
        } else if (row.values['kind'] === 'human' && row.values['state'] !== 'Removed' && this.entries.find((entry) => entry.room.roomId === row.roomId)?.snapshot?.lifecycle === 'open') {
            this.close({roomId: row.roomId, sessionId: row.sessionId!});
        } else {
            this.showSession();
        }
    }

    /** Joining writes to the room, so it is confirmed like every other action here. */
    private confirmJoin(found: NetworkRoom): void {
        const {room, url} = found;
        const page: RoomPanelPage = {id: 'join-network-room', closeOnCancel: true, title: 'Join room on the network', note: `${room.name} (${room.roomId}) at ${url}`, reload: async () => page, rows: [{id: 'confirm', label: 'Join room', value: room.name, section: 'Confirmation', action: {kind: 'command', closeAfterSave: true, confirm: `Join ${room.name} at ${url} as a member? Everyone in the room will see you join, and it stays in this list afterwards.`, run: async () => {
            this.join = {roomId: room.roomId, joinAt: url};
        }}}]};
        this.details.show(page);
        this.details.key(undefined, {name: 'enter'});
    }

    private confirmClose(): void {
        const row = this.rows[this.selected];
        if (!row) {
            return;
        }
        if (row.values['state'] === NETWORK_STATE) {
            this.note = 'This room is not joined yet. Enter joins it.';
            this.render();
            return;
        }
        const session = Boolean(this.roomId);
        const name = row.values['name'];
        const description = session
            ? `Leave ${name} (${row.sessionId})? Its managed receiver will stop. Current tools may continue; saved identity and history are kept for rejoining.`
            : `Close ${name} (${row.roomId}) for everyone? This ends new messages and joins. Retained history stays available under the room's export policy.`;
        const page: RoomPanelPage = {id: 'close-selection', closeOnCancel: true, title: session ? 'Close local session' : 'Close room for everyone', note: description, reload: async () => page, rows: [{id: 'confirm', label: session ? 'Leave session' : 'Close room', value: name ?? '', section: 'Confirm', action: {kind: 'command', confirm: description, closeAfterSave: true, run: async () => {
            if (session) {
                this.actionNotice = await leaveListedSession(this.store, row.roomId, row.sessionId!);
            } else {
                await closeListedRoom(this.store, row.roomId);
                this.actionNotice = 'Room closed for everyone.';
            }
        }}}]};
        this.details.show(page);
        this.details.key(undefined, {name: 'enter'});
    }

    private showSession(): void {
        const page = this.sessionPage();
        if (page) {
            this.details.show(page);
        }
    }

    private sessionPage(sessionId?: string): RoomPanelPage | undefined {
        const row = sessionId ? this.rows.find((candidate) => candidate.id === sessionId) : this.rows[this.selected];
        const entry = this.entries.find((room) => room.room.roomId === row?.roomId);
        const session = entry?.room.sessions.find((candidate) => candidate.sessionId === row?.sessionId);
        if (!row || !entry || !session) {
            this.note = 'Open a room to inspect its local sessions.';
            this.render();
            return;
        }
        const page: RoomPanelPage = {id: 'session-details', title: `Session — ${row.values['name']}`, note: 'These are local saved sessions. Remote agents are listed by /agents inside the room.', reload: async () => {
            this.entries = await loadRoomList(this.store);
            this.rebuildRows(row.id);
            const refreshed = this.sessionPage(row.id);
            if (!refreshed) {
                throw new Error('This saved session no longer exists.');
            }
            return refreshed;
        }, rows: [
            ...SESSION_COLUMNS.map((column) => ({id: column.key, label: column.label, value: row.values[column.key] ?? '', section: 'Session'})),
            {id: 'room-id', label: 'Room ID', value: row.roomId, section: 'Room'},
            {id: 'directory', label: 'Working directory', value: session.cwd, section: 'Local'}
        ]};
        if (receiverConfiguration(this.store, session.sessionId)) {
            page.rows.push({id: 'stop', label: 'Stop receiver', value: 'Keep room membership', section: 'Actions', action: {kind: 'command', closeAfterSave: true, confirm: `Stop ${row.values['name']}? It stays joined. Tools already started may continue.`, run: async () => {
                await stopReceiver(this.store, session.sessionId);
                this.actionNotice = 'Receiver stopped; room membership unchanged.';
            }}});
            page.rows.push({id: 'start', label: 'Start receiver', value: 'Rejoin if needed; process pending work', section: 'Actions', action: {kind: 'command', closeAfterSave: true, confirm: `Start ${row.values['name']}? This rejoins if needed and may process queued requests.`, run: async () => {
                const credential = this.store.credential(row.roomId, session.sessionId);
                if (!credential) {
                    throw new Error('Session credential unavailable.');
                }
                const client = new PairLobbyClient(entry.room.serverUrl);
                try {
                    const snapshot = await client.snapshot(row.roomId, credential);
                    const member = snapshot.participants.find((person) => person.participantId === session.participantId);
                    if (snapshot.lifecycle !== 'open' || !member || member.revoked) {
                        throw new Error('This session cannot restart in a closed room or with a removed membership.');
                    }
                    if (member.left) {
                        await client.rejoin(row.roomId, credential);
                    }
                    await startReceiver(this.store, row.roomId, session.sessionId);
                    this.actionNotice = 'Receiver started.';
                } finally {
                    client.closeLive();
                }
            }}});
        }
        return page;
    }

    private text(value: string, width: number): string {
        const clean = plainCell(value);
        let out = '';
        if (Number(this.surface.strWidth(clean)) <= width) {
            return clean;
        }
        for (const {segment} of new Intl.Segmenter().segment(clean)) {
            if (Number(this.surface.strWidth(out + segment + '…')) > width) {
                break;
            }
            out += segment;
        }
        return out + '…';
    }

    private cell(top: number, left: number, width: number, value: string, selected = false): blessed.Widgets.BoxElement {
        const cell = blessed.box({parent: this.surface, top, left, width, height: 1, tags: false, wrap: false, mouse: true, content: this.text(value, width), style: {fg: selected ? 'black' : 'white', bg: selected ? 'cyan' : 'black'}});
        cell.on('wheelup', () => { this.selected = Math.max(0, this.selected - 1); this.render(); });
        cell.on('wheeldown', () => { this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + 1)); this.render(); });
        this.cells.push(cell);
        return cell;
    }

    private render(): void {
        if (this.closed || this.details.visible) {
            return;
        }
        for (const cell of this.cells) {
            cell.destroy();
        }
        this.cells = [];
        this.screen.program.hideCursor();
        const width = Math.max(1, Number(this.screen.width) - 2);
        const height = Number(this.screen.height);
        const room = this.entries.find((entry) => entry.room.roomId === this.roomId);
        const title = this.roomId ? `Local sessions — ${room?.snapshot?.name ?? room?.room.name ?? this.roomId}` : 'PairLobby rooms';
        this.cell(0, 1, width, `${title} (${this.rows.length}) · sort: ${this.sort().key} ${this.sort().descending ? 'descending' : 'ascending'}`);
        this.cell(1, 1, width, '↑/↓ rows · ←/→/Tab columns · S/header sort · Enter open or join · R refresh');
        this.cell(2, 1, width, 'C close room/session · I session details · Y copy cell · Esc back · Q quit');
        if (height < 10 || width < 28) {
            this.cell(2, 1, width, 'Enlarge terminal · Q quits');
            this.screen.render();
            return;
        }
        const columns = this.columns();
        this.firstColumn = Math.min(this.firstColumn, this.column);
        while (columns.slice(this.firstColumn, this.column + 1).reduce((sum, column) => sum + Math.min(column.width, width) + 1, -1) > width) {
            this.firstColumn++;
        }
        if (this.selected < this.top) {
            this.top = this.selected;
        }
        if (this.selected >= this.top + this.pageSize()) {
            this.top = this.selected - this.pageSize() + 1;
        }
        let left = 1;
        for (let index = this.firstColumn; index < columns.length && left < width; index++) {
            const column = columns[index]!;
            const size = Math.min(column.width, width - left + 1);
            if (size < 3) {
                break;
            }
            const header = this.cell(3, left, size, column.label + (this.sort().key === column.key ? this.sort().descending ? ' ↓' : ' ↑' : ''), index === this.column);
            header.on('mousedown', (event: BrowserMouse) => {
                if (event.button === 'left') {
                    this.column = index;
                    this.sortBy(column.key);
                }
            });
            this.rows.slice(this.top, this.top + this.pageSize()).forEach((row, offset) => {
                const rowIndex = this.top + offset;
                const cell = this.cell(4 + offset, left, size, row.values[column.key] ?? '', rowIndex === this.selected);
                cell.on('mousedown', (event: BrowserMouse) => {
                    if (event.button === 'left') {
                        this.selected = rowIndex;
                        this.column = index;
                        this.render();
                    }
                });
            });
            left += size + 1;
        }
        if (!this.rows.length) {
            this.cell(4, 1, width, this.loading ? 'Loading…' : this.roomId ? 'No local sessions saved for this room.' : 'No saved rooms. Use pairlobby create or pairlobby join.');
        }
        const row = this.rows[this.selected];
        const column = columns[this.column]!;
        this.cell(height - 3, 1, width, row ? `${column.label}: ${row.values[column.key] ?? ''}` : '');
        this.cell(height - 2, 1, width, this.note);
        this.screen.render();
    }
}
