import blessed from 'blessed';
import {createInterface} from 'node:readline';
import type {Interface, Key} from 'node:readline';
import {PassThrough, Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import type {MessageRequest, RoomEvent, TurnQueue} from '@pairlobby/protocol';
import {ReceiptView} from './receipt-view.js';
import {WorkingStrip} from './working-strip.js';
import {ReplyComposer, messageTarget, quotePreview} from './reply-composer.js';
import type {ReplySubmission, ReplyTarget} from './reply-composer.js';
import {AgentTable} from './agent-table.js';
import type {AgentRoster} from './agent-roster.js';
import {RoomPanel} from './room-panel.js';
import type {RoomPanelPage} from './room-panel.js';
import {applyPopupLayout, fitPopup, visibleMessageRow} from './terminal-layout.js';
import {pasteLine, readClipboard} from './clipboard.js';
import {createTerminalProgram} from './terminal-program.js';
import {statusTable} from './status-table.js';
import type {StatusRow} from './status-table.js';
import {agentActivities, activitySummary} from './agent-activity.js';
import type {AgentActivity, AgentActivityContext} from './agent-activity.js';

type ChatTerminalOptions = {names: Map<string, string>; participantId: string; format: (event: RoomEvent, highlightNames?: boolean, collapsed?: boolean) => string; complete: (line: string) => [string[], string]};
type TranscriptEntry = {text: string; event?: RoomEvent; alertId?: string};
export type RequestAlert = {requestId: string; text: string};
type ScreenKey = Key & {full?: string};
type MessageLayout = {event: RoomEvent; content: blessed.Widgets.TextElement; normalText: string; highlighted: boolean; top: number; height: number; selected: boolean; receipt?: blessed.Widgets.BoxElement; working?: blessed.Widgets.BoxElement};
type ScrollBody = blessed.Widgets.BoxElement & {childBase: number};

class SilentOutput extends Writable {
    isTTY = true;
    columns = 80;
    override _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
        done();
    }
}

/** A diff-rendered terminal transcript: mouse hit targets stay attached to their message. */
export class ChatTerminal {
    readonly input: Interface;
    private screen = blessed.screen({program: createTerminalProgram(), smartCSR: true, fullUnicode: true, title: 'PairLobby', warnings: false});
    private body = blessed.box({parent: this.screen, top: 0, bottom: 3, left: 0, right: 0, scrollable: true, alwaysScroll: true, mouse: true, tags: false, scrollbar: {ch: '│', style: {fg: 'gray'}}});
    private composer = blessed.box({parent: this.screen, bottom: 1, left: 0, right: 0, height: 1, tags: false});
    private hint = blessed.box({parent: this.screen, bottom: 0, left: 0, right: 0, height: 1, tags: false, style: {fg: 'gray'}});
    private turns = blessed.box({parent: this.screen, bottom: 2, left: 0, right: 0, height: 1, tags: false, mouse: true, wrap: false, style: {fg: 'cyan'}});
    private quote = blessed.box({parent: this.screen, bottom: 2, left: 0, right: 0, height: 1, tags: false, wrap: false, hidden: true, style: {fg: 'gray'}});
    private popup = blessed.box({parent: this.screen, right: 1, top: 0, width: 1, height: 1, border: 'line', padding: {left: 1, right: 1}, tags: false, hidden: true, mouse: true, scrollable: true, alwaysScroll: true, wrap: false, style: {fg: 'white', bg: 'black', border: {fg: 'gray'}}});
    private working = new WorkingStrip({screen: this.screen, render: () => this.renderInput(), rebuild: () => this.rebuild(), obscured: () => this.popup.visible, beforeOpen: (pinned) => {
        if (this.pinned && !pinned) {
            return false;
        }
        this.hideDetails(false);
        return true;
    }});
    private entries: TranscriptEntry[] = [];
    private events = new Set<string>();
    private receipts = new ReceiptView();
    private output = new SilentOutput();
    private keyboard = new PassThrough();
    private promptText = '> ';
    private closed = false;
    private suspended = false;
    private pinned = false;
    private detailsId: string | undefined;
    /** Messages the person folded to one line. Display only: copying, replies and status use the whole message. */
    private collapsed = new Set<string>();
    private follow = true;
    private inputChanged: (() => void) | undefined;
    private labels = new Map<string, blessed.Widgets.BoxElement>();
    private messageLayouts: MessageLayout[] = [];
    private latestMessage: RoomEvent | undefined;
    private activityContext: AgentActivityContext | undefined;
    private activityOpen = false;
    private turnText = '';
    private reply = new ReplyComposer();
    private submittedReply: ReplySubmission | undefined;
    private hintText = '';
    private revealReply = false;
    private selecting = false;
    private frameDepth = 0;
    private loadAgents: (() => Promise<AgentRoster>) | undefined;
    private agentTable = new AgentTable({screen: this.screen, close: () => { this.working.resume(); this.rebuild(); }, refresh: () => this.loadAgents ? this.loadAgents() : Promise.reject(new Error('No agent loader'))});
    private roomPanel = new RoomPanel({screen: this.screen, close: () => { this.working.resume(); this.rebuild(); }});

    constructor(private readonly options: ChatTerminalOptions) {
        this.input = createInterface({input: this.keyboard, output: this.output, terminal: true, completer: options.complete});
        this.screen.on('keypress', (character: string, key: ScreenKey) => {
            // Blessed synthesizes "enter" before forwarding the same CR as
            // "return". Handle that physical key once, including modal editors.
            if (key.name === 'return' && key.sequence === '\r') {
                return;
            }
            if (this.suspended || this.closed) {
                return;
            }
            if (this.agentTable.visible) {
                this.agentTable.key(key);
                return;
            }
            if (this.roomPanel.visible) {
                this.roomPanel.key(character, key);
                return;
            }
            if (this.selecting) {
                if (key.name === 'f4' || key.name === 'escape') {
                    this.toggleSelection();
                } else if (key.name === 'pageup' || key.name === 'pagedown') {
                    this.body.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, Number(this.body.height) - 2));
                    this.follow = this.body.getScrollPerc() >= 99;
                    this.renderInput(true);
                }
                return;
            }
            if (key.name === 'f4') {
                this.toggleSelection();
                return;
            }
            if (this.reply.active && key.name === 'escape') {
                const answer = this.reply.answer(this.input.line ?? '');
                this.reply.clear();
                this.replaceInput(answer);
                this.rebuild();
                this.hideDetails();
                this.working.hide();
                return;
            }
            if (this.reply.picking && (key.name === 'up' || key.name === 'down')) {
                this.reply.move(key.name === 'up' ? -1 : 1, this.replyTargets());
                this.revealReply = true;
                this.rebuild();
                return;
            }
            const enter = key.name === 'enter' || key.name === 'return';
            if (this.reply.picking && (enter || key.name === 'tab')) {
                if (this.reply.choose() && this.input.line === '/reply') {
                    this.input.write(' ');
                }
                this.rebuild();
                return;
            }
            if (enter && this.reply.active && this.reply.target && !this.reply.answer(this.input.line ?? '').trim()) {
                this.renderInput();
                return;
            }
            if (key.name === 'pageup' || key.name === 'pagedown') {
                this.body.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, Number(this.body.height) - 2));
                this.follow = this.body.getScrollPerc() >= 99;
                this.hideDetails();
            } else if (key.name === 'f3') {
                this.working.showAll();
            } else if (key.name === 'f2') {
                this.showLatestReceipt();
            } else if (key.name === 'escape') {
                this.hideDetails();
                this.working.hide();
            } else {
                if (key.ctrl && key.name === 'c') {
                    this.input.emit('SIGINT');
                    return;
                }
                this.input.write(character ?? '', key);
                this.syncReply();
                this.inputChanged?.();
            }
            this.renderInput();
        });
        this.input.on('line', (line: string) => {
            this.submittedReply = this.reply.submit(line);
            this.follow = true;
            this.hideDetails();
            setImmediate(() => this.rebuild());
        });
        this.input.once('close', () => this.close());
        this.body.on('wheeldown', () => { this.follow = this.body.getScrollPerc() >= 99; this.hideDetails(); });
        this.body.on('wheelup', () => { this.follow = false; this.hideDetails(); });
        this.body.on('scroll', () => this.positionMessageLabels());
        this.turns.on('mouseover', () => { if (!this.pinned) { this.showActivity(); } });
        this.turns.on('mouseout', () => { if (!this.pinned) { this.hideDetails(); } });
        this.turns.on('click', () => this.showActivity(true));
        this.screen.on('mouse', (event: blessed.Widgets.Events.IMouseEventArg) => {
            if (this.closed || this.suspended || this.selecting || this.agentTable.visible || this.roomPanel.visible) {
                return;
            }
            const contains = (element: blessed.Widgets.BoxElement | undefined): boolean => {
                const bounds = element?.lpos;
                return Boolean(element?.visible && bounds && event.x >= bounds.xi && event.x < bounds.xl && event.y >= bounds.yi && event.y < bounds.yl);
            };
            if (event.action === 'mousedown' && (event as {button?: string}).button === 'right' && process.platform === 'win32') {
                // Mouse reporting takes the right click away from the Windows
                // console, which would otherwise paste; do it for the console.
                void this.pasteClipboard();
                return;
            }
            if (event.action === 'mousemove' && !this.pinned) {
                // Scrolling moves an existing Seen element. Blessed may still
                // consider it hovered, so mouseover alone is insufficient.
                const target = [...this.labels].find(([, label]) => contains(label));
                if (target && this.detailsId !== target[0]) {
                    this.showDetails(target[0]);
                } else if (!target && contains(this.turns) && !this.activityOpen) {
                    this.showActivity();
                } else if (!target && !contains(this.turns) && !contains(this.popup) && (this.detailsId || this.activityOpen)) {
                    this.hideDetails();
                }
                return;
            }
            if (event.action !== 'mousedown' || (!this.detailsId && !this.activityOpen)) {
                return;
            }
            if (!contains(this.popup) && !contains(this.detailsId ? this.labels.get(this.detailsId) : this.turns)) {
                this.hideDetails();
            }
        });
        this.screen.on('resize', () => this.drawFrame(() => {
            this.working.clearGraphics();
            this.output.columns = Number(this.screen.width);
            if (this.selecting) {
                this.selecting = false;
                this.working.resume();
                this.screen.program.enableMouse();
            }
            this.rebuild();
            this.agentTable.render();
            this.roomPanel.render();
        }));
        this.screen.program.enableMouse();
        this.renderInput();
    }

    private async pasteClipboard(): Promise<void> {
        const text = pasteLine(await readClipboard());
        if (!text || this.closed || this.suspended || this.selecting || this.agentTable.visible || this.roomPanel.visible) {
            return;
        }
        this.input.write(text);
        this.syncReply();
        this.inputChanged?.();
        this.renderInput();
    }

    setPrompt(text: string): void {
        this.promptText = stripVTControlCharacters(text);
        this.input.setPrompt(this.promptText);
        this.renderInput();
    }

    async showAgents(load: () => Promise<AgentRoster>): Promise<void> {
        const roster = await load();
        if (this.closed || this.suspended) {
            return;
        }
        if (this.selecting) {
            this.toggleSelection();
        }
        this.hideDetails();
        this.working.hide();
        this.working.suspend();
        this.roomPanel.hide();
        this.loadAgents = load;
        this.agentTable.show(roster);
    }

    async showRoomPanel(load: () => Promise<RoomPanelPage>): Promise<void> {
        const page = await load();
        if (this.closed || this.suspended) {
            return;
        }
        if (this.selecting) {
            this.toggleSelection();
        }
        this.hideDetails();
        this.working.hide();
        this.working.suspend();
        this.agentTable.hide();
        this.roomPanel.show(page);
    }

    onInput(callback: () => void): void {
        this.inputChanged = callback;
    }

    setHint(text: string): void {
        this.hintText = text;
        this.renderInput();
    }

    /** Native terminal selection can coexist with mouse controls through a frozen selection mode. */
    toggleSelection(): void {
        if (this.selecting) {
            this.selecting = false;
            this.working.resume();
            this.screen.program.enableMouse();
            this.rebuild();
            return;
        }
        this.selecting = true;
        this.pinned = false;
        this.detailsId = undefined;
        this.popup.hide();
        this.working.hide();
        this.working.suspend();
        this.screen.program.disableMouse();
        this.renderInput(true);
        this.screen.program.flush();
    }

    takeReply(): ReplySubmission | undefined {
        const submission = this.submittedReply;
        this.submittedReply = undefined;
        return submission;
    }

    restoreReply(submission: ReplySubmission): void {
        // Do not replace a newer draft if a send failed while the user was typing.
        if (!this.input.line) {
            this.reply.restore(submission);
            this.replaceInput(`/reply ${submission.text}`);
            this.rebuild();
        }
    }

    private replyTargets(): ReplyTarget[] {
        return this.entries.flatMap((entry) => entry.event ? messageTarget(entry.event) ?? [] : []);
    }

    private replaceInput(text: string): void {
        this.input.write(null, {ctrl: true, name: 'a'});
        this.input.write(null, {ctrl: true, name: 'k'});
        this.input.write(text);
    }

    private syncReply(): void {
        const before = `${this.reply.active}:${this.reply.picking}:${this.reply.target?.eventId}`;
        this.reply.sync(this.input.line ?? '', this.replyTargets());
        if (`${this.reply.active}:${this.reply.picking}:${this.reply.target?.eventId}` !== before) {
            this.revealReply = Boolean(this.reply.target);
            this.rebuild();
        }
    }

    setWorking(queue: TurnQueue): void {
        this.working.update(queue);
        this.rebuild();
    }

    showWorking(): void {
        this.working.showAll();
    }

    setTurnStatus(text: string): void {
        this.turnText = stripVTControlCharacters(text);
        this.renderInput();
    }

    setAgentActivity(context: AgentActivityContext): void {
        this.activityContext = context;
        this.renderInput();
    }

    activityUnavailable(): void {
        if (this.activityContext) {
            this.activityContext = {...this.activityContext, available: false};
            this.renderInput();
        }
    }

    log(text: string): void {
        this.rememberEntry({text});
        this.rebuild();
    }

    setRequestAlerts(alerts: RequestAlert[]): void {
        const previous = this.entries.filter((entry) => entry.alertId).map((entry) => ({requestId: entry.alertId, text: entry.text}));
        if (JSON.stringify(previous) === JSON.stringify(alerts)) {
            return;
        }
        this.entries = this.entries.filter((entry) => !entry.alertId);
        for (const alert of alerts) {
            this.rememberEntry({text: alert.text, alertId: alert.requestId});
        }
        this.rebuild();
    }

    private rememberEntry(entry: TranscriptEntry): void {
        this.entries.push(entry);
        // Keep buffering bounded even while native selection freezes redraws.
        if (this.entries.length > 1000) {
            this.entries.splice(0, this.entries.length - 1000);
        }
    }

    addEvent(event: RoomEvent): void {
        this.receipts.observe(event);
        if (event.type === 'message' && (!this.latestMessage || event.seq > this.latestMessage.seq)) {
            this.latestMessage = event;
        }
        if (!this.events.has(event.eventId)) {
            this.events.add(event.eventId);
            if (event.type !== 'message.received' && !(event.type === 'conversation.turn_changed' && ['claimed', 'working'].includes(event.payload.action))) {
                this.rememberEntry({text: this.options.format(event), event});
            }
        }
        this.rebuild();
    }

    updateRequest(request: MessageRequest): void {
        const root = request.conversationId ?? request.eventId;
        const before = JSON.stringify([this.receipts.forMessage(root), this.receipts.forParticipant(root, request.to)]);
        this.receipts.observeRequest(request);
        if (JSON.stringify([this.receipts.forMessage(root), this.receipts.forParticipant(root, request.to)]) !== before) {
            this.rebuild();
        }
    }

    private toggleCollapsed(eventId: string): void {
        if (!this.collapsed.delete(eventId)) {
            this.collapsed.add(eventId);
        }
        this.rebuild();
    }

    /**
     * Folds or unfolds messages: one named by its id or sequence number, the latest
     * message when none is named, or every message in the loaded transcript for `all`.
     */
    setCollapsed(collapse: boolean, argument?: string): void {
        const reference = (argument ?? '').trim();
        const messages = this.entries.filter((entry) => entry.event?.type === 'message').map((entry) => entry.event!);
        const chosen = reference === 'all' ? messages : [reference ? messages.findLast((event) => event.eventId === reference || event.seq.toString() === reference) : messages.at(-1)].filter((event): event is RoomEvent => Boolean(event));
        if (!chosen.length) {
            this.log('No matching message in the loaded transcript.');
            return;
        }
        for (const event of chosen) {
            if (collapse) {
                this.collapsed.add(event.eventId);
            } else {
                this.collapsed.delete(event.eventId);
            }
        }
        this.rebuild();
    }

    showLatestReceipt(argument?: string): void {
        const words = (argument ?? '').split(/\s+/).filter(Boolean);
        const full = words.at(-1) === 'full';
        const reference = (full ? words.slice(0, -1) : words)[0];
        const messages = this.entries.filter((entry) => entry.event?.type === 'message');
        const selected = reference
            ? messages.findLast((entry) => entry.event!.eventId === reference || entry.event!.seq.toString() === reference)
            : messages.findLast((entry) => entry.event!.senderId === this.options.participantId) ?? messages.at(-1);
        if (!selected?.event) {
            this.log('No matching message in the loaded transcript.');
            return;
        }
        if (full) {
            this.logFullStatus(selected.event.eventId, selected.event.seq);
            return;
        }
        this.showDetails(selected.event.eventId, true);
    }

    /** The table's values before any clipping, with full dates and time zone, for reading or copying. */
    private logFullStatus(eventId: string, seq: number): void {
        const rows = this.statusRows(eventId);
        const when = (at: number) => new Date(at).toLocaleString(undefined, {timeZoneName: 'short'});
        this.log(`Receipts for message #${seq}:${rows.length ? '' : ' no participant receipt yet.'}`);
        for (const row of rows) {
            const receipt = row.receipt.kind === 'read' ? `Read ${when(row.receipt.at)}` : row.receipt.kind === 'received' ? `Received ${when(row.receipt.at)}` : 'Unconfirmed';
            this.log(`  ${row.name} (${row.id}) — ${receipt} — ${row.action}${row.reason ? ` — ${row.reason}` : ''}`);
        }
    }

    suspend(): void {
        this.agentTable.hide();
        this.roomPanel.hide();
        this.working.suspend();
        this.suspended = true;
        this.screen.program.disableMouse();
        this.screen.program.normalBuffer();
        this.screen.program.showCursor();
    }

    resume(): void {
        this.working.resume();
        this.screen.program.alternateBuffer();
        this.screen.program.enableMouse();
        this.screen.realloc();
        process.stdin.setRawMode?.(true);
        this.suspended = false;
        this.rebuild();
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.working.close();
        this.agentTable.hide();
        this.roomPanel.hide();
        this.closed = true;
        this.input.close();
        this.keyboard.destroy();
        this.output.destroy();
        this.screen.destroy();
    }

    private rebuild(): void {
        if (this.closed || this.suspended || this.selecting || this.agentTable.visible || this.roomPanel.visible) {
            return;
        }
        this.drawFrame(() => this.rebuildContents());
    }

    private rebuildContents(): void {
        const scroll = this.body.getScroll();
        for (const child of [...this.body.children]) {
            child.destroy();
        }
        this.labels.clear();
        this.messageLayouts = [];
        this.reply.sync(this.input.line ?? '', this.replyTargets());
        const workingHeight = this.working.rebuild(this.reply.active ? 3 : 2);
        this.body.bottom = (this.reply.active ? 4 : 3) + workingHeight;
        this.turns.bottom = (this.reply.active ? 3 : 2) + workingHeight;
        const targets = new Map(this.replyTargets().map((target) => [target.eventId, target]));
        let top = 0;
        let selectedTop: number | undefined;
        for (const entry of this.entries) {
            const message = entry.event?.type === 'message' ? entry.event : undefined;
            const isWorking = message && this.working.state.forMessage(message.eventId).length > 0;
            const selected = message && this.reply.target?.eventId === message.eventId;
            const quotedId = message?.quoteOf ?? message?.replyTo;
            if (quotedId) {
                const target = targets.get(quotedId);
                blessed.text({parent: this.body, top, left: 2, right: 9, height: 1, content: target ? quotePreview(target, this.options.names) : '> Original message is not in the loaded history', tags: false, wrap: false, style: {fg: 'gray'}});
                top += 1;
            }
            if (selected) {
                selectedTop = top;
            }
            const receipt = Boolean(message);
            // Only a message with more than one line of text can be folded, and nothing arrives folded.
            const foldable = message ? message.payload.text.split('\n').filter((line) => line.trim()).length > 1 : false;
            const folded = Boolean(message && foldable && this.collapsed.has(message.eventId));
            const text = message ? this.options.format(message, false, folded) : entry.text;
            const content = blessed.text({parent: this.body, top, left: 0, right: (isWorking ? 19 : message ? 9 : 1) + (foldable ? 2 : 0), height: 'shrink', content: selected && this.detailsId !== message?.eventId ? stripVTControlCharacters(text) : text, tags: false, wrap: true, style: selected ? {bg: 'blue', fg: 'white'} : {}});
            const lines = Math.max(1, content.getScreenLines().length);
            content.height = lines;
            const layout: MessageLayout | undefined = message ? {event: message, content, normalText: text, highlighted: false, top, height: lines, selected: Boolean(selected)} : undefined;
            if (layout) {
                this.messageLayouts.push(layout);
            }
            if (isWorking && message) {
                const label = blessed.box({parent: this.body, top, right: 10, width: 7, height: 1, content: 'Working', mouse: true, style: {fg: 'cyan', hover: {underline: true}}});
                this.working.bind(label, message.eventId);
                layout!.working = label;
            }
            if (foldable && message) {
                const toggle = blessed.box({parent: this.body, top, right: isWorking ? 18 : 9, width: 1, height: 1, content: folded ? '▸' : '▾', mouse: true, style: {fg: 'gray', hover: {fg: 'white'}}});
                // The press alone: the rebuild it causes replaces this box before a release could reach it.
                toggle.on('mousedown', () => this.toggleCollapsed(message.eventId));
            }
            if (receipt && message) {
                const label = blessed.box({parent: this.body, top, right: 2, width: 6, height: 1, content: 'Status', mouse: true, style: {fg: 'gray', hover: {fg: 'white', underline: true}}});
                this.labels.set(message.eventId, label);
                layout!.receipt = label;
                label.on('mouseover', () => { if (!this.pinned) { this.showDetails(message.eventId); } });
                label.on('mouseout', () => { if (!this.pinned) { this.hideDetails(); } });
                label.on('mousedown', () => this.showDetails(message.eventId, true));
                label.on('click', () => this.showDetails(message.eventId, true));
            }
            top += lines;
        }
        // Refresh child geometry before calculating the scroll extent.
        this.body.render();
        if (this.revealReply && selectedTop !== undefined) {
            const height = Math.max(1, Number(this.body.height));
            this.body.setScroll(Math.max(0, Math.min(scroll, selectedTop)));
            if (selectedTop >= this.body.getScroll() + height) {
                this.body.setScroll(selectedTop - height + 1);
            }
            this.follow = false;
        } else if (this.follow) {
            this.body.setScrollPerc(100);
        } else {
            this.body.setScroll(scroll);
        }
        this.revealReply = false;
        this.renderInput();
    }

    private showDetails(eventId: string, pinned = false): void {
        if (!this.working.dismissForDetails(pinned)) {
            return;
        }
        if (this.detailsId !== eventId || this.activityOpen) {
            this.popup.setScroll(0);
        }
        this.activityOpen = false;
        this.detailsId = eventId;
        this.pinned = pinned;
        this.renderInput();
    }

    private showActivity(pinned = false): void {
        if (!this.activityContext) {
            return;
        }
        if (!this.working.dismissForDetails(pinned)) {
            return;
        }
        if (!this.activityOpen) {
            this.popup.setScroll(0);
        }
        this.detailsId = undefined;
        this.activityOpen = true;
        this.pinned = pinned;
        this.renderInput();
    }

    private currentActivities(): AgentActivity[] {
        const acknowledged = new Set(this.latestMessage ? this.receipts.forMessage(this.latestMessage.eventId).map((receipt) => receipt.participantId) : []);
        const settled = new Set(this.latestMessage ? this.receipts.participants(this.latestMessage.eventId).filter((id) => {
            const state = this.receipts.forParticipant(this.latestMessage!.eventId, id);
            return state.readAt !== undefined && ['No action needed', 'Declined', 'Done', 'Done · recovered', 'Done · answer linked'].includes(state.action ?? '');
        }) : []);
        return this.activityContext ? agentActivities(this.activityContext, {latestMessage: this.latestMessage, acknowledged, settled}) : [];
    }

    /** One row per participant who should see `eventId`, shared by the popup and `/seen full`. */
    private statusRows(eventId: string): StatusRow[] {
        const message = this.entries.find((entry) => entry.event?.eventId === eventId)?.event;
        const receipts = this.receipts.forMessage(eventId);
        const participants = new Set([...this.receipts.participants(eventId), ...(this.activityContext?.participants.filter((person) => !person.left && !person.revoked && person.role !== 'guest' && person.participantId !== message?.senderId && person.joinedAt <= (message?.at ?? Infinity)).map((person) => person.participantId) ?? [])]);
        return [...participants].map((id) => {
            const receipt = receipts.find((item) => item.participantId === id);
            const stage = this.receipts.forParticipant(eventId, id);
            const addressed = message?.type === 'message' && !message.replyTo && (message.recipientId === id || message.recipientIds?.includes(id));
            return {
                id,
                name: this.options.names.get(id) ?? id,
                // A bare time means the client received it; "Read" means the agent declared reading it.
                receipt: stage.readAt !== undefined ? {kind: 'read', at: stage.readAt} : receipt ? {kind: 'received', at: receipt.acknowledgedAt} : {kind: 'unconfirmed'},
                action: stage.action ?? (addressed ? 'Queued' : 'No response requested'),
                reason: stage.reason,
            };
        });
    }

    private paintDetails(): void {
        if (this.activityOpen) {
            const descriptions = {idle: 'Idle · explicitly no further action', clear: 'No queued room task · reading not implied', failed: 'Failed task needs attention', unread: 'Latest transport receipt unconfirmed', working: 'Working', preparing: 'Preparing an answer', waiting: 'Waiting · pending request', stalled: 'Stalled request', paused: 'Paused', muted: 'Muted', unknown: 'Status unavailable'};
            fitPopup(this.popup, ['Agent activity', ...this.currentActivities().map((agent) => `${agent.name} — ${descriptions[agent.state]}`)], this.screen);
            this.popup.top = Math.max(0, Number(this.turns.atop) - Number(this.popup.height));
            this.popup.show();
            this.popup.setFront();
            return;
        }
        const eventId = this.detailsId;
        if (!eventId) {
            return;
        }
        const rows = this.statusRows(eventId);
        applyPopupLayout(this.popup, statusTable(rows, {columns: Number(this.screen.width), rows: Number(this.screen.height), measure: (text) => Number(this.popup.strWidth(text))}));
        const anchor = this.labels.get(eventId);
        this.popup.top = Math.max(0, Math.min(anchor?.visible ? Number(anchor.atop) + 1 : Number(this.screen.height) - 3, Number(this.screen.height) - Number(this.popup.height) - 3));
        this.popup.show();
        this.popup.setFront();
    }

    private hideDetails(render = true): void {
        this.pinned = false;
        this.detailsId = undefined;
        this.activityOpen = false;
        this.popup.hide();
        if (render) {
            this.renderInput();
        }
    }

    private positionMessageLabels(): void {
        const scroll = (this.body as ScrollBody).childBase ?? 0;
        for (const layout of this.messageLayouts) {
            const row = visibleMessageRow(layout.top, layout.height, scroll, Number(this.body.height));
            for (const label of [layout.receipt, layout.working]) {
                if (!label) {
                    continue;
                }
                if (row === null) {
                    label.hide();
                } else {
                    label.top = row;
                    label.show();
                }
            }
        }
    }

    private paintMessageHighlights(): void {
        for (const layout of this.messageLayouts) {
            const highlighted = layout.event.eventId === this.detailsId;
            if (highlighted === layout.highlighted) {
                continue;
            }
            layout.highlighted = highlighted;
            layout.content.style.bg = layout.selected ? 'blue' : highlighted ? '#252a30' : 'default';
            const text = highlighted ? this.options.format(layout.event, true, this.collapsed.has(layout.event.eventId)) : layout.normalText;
            const rendered = layout.selected && !highlighted ? stripVTControlCharacters(text) : text;
            if (layout.content.content !== rendered) {
                layout.content.setContent(rendered);
            }
        }
    }

    private renderInput(force = false): void {
        if (this.closed || this.suspended || this.agentTable.visible || this.roomPanel.visible || (this.selecting && !force)) {
            return;
        }
        this.drawFrame(() => this.renderInputContents());
    }

    /** Text, native images and the final cursor position form one terminal frame. */
    private drawFrame(draw: () => void): void {
        const outer = this.frameDepth === 0;
        this.frameDepth += 1;
        if (outer) {
            this.screen.program.flush();
            process.stdout.write('\u001b[?2026h');
            this.screen.program.hideCursor();
        }
        try {
            draw();
        } finally {
            this.frameDepth -= 1;
            if (outer) {
                this.screen.program.flush();
                process.stdout.write('\u001b[?2026l');
            }
        }
    }

    private renderInputContents(): void {
        const line = this.input.line ?? '';
        const cursor = this.input.cursor ?? line.length;
        const width = Math.max(1, Number(this.screen.width) - this.promptText.length - 2);
        const start = Math.max(0, cursor - width);
        if (this.reply.active) {
            this.quote.setContent(this.reply.target ? quotePreview(this.reply.target, this.options.names) : 'No message selected');
            this.quote.show();
        } else {
            this.quote.hide();
        }
        this.hint.setContent(this.selecting ? 'Select text: drag · use terminal Copy (⌘C on macOS) · F4/Esc resume' : this.reply.active
            ? this.reply.picking ? '↑/↓ choose a message · Enter/Tab select · Esc cancel' : 'Enter sends your reply · Delete /reply or Esc to cancel'
            : this.hintText || 'Hover/click Status · F2 Status · F3 Working · F4 Select/copy · PgUp/PgDn scroll');
        this.composer.setContent(this.promptText + line.slice(start, start + width));
        const summary = this.activityContext ? activitySummary(this.currentActivities()) : '';
        const mode = this.activityContext?.queue?.mode;
        this.turns.setContent(summary ? `${mode ? `Turns: ${mode} | ` : ''}${summary}` : this.turnText);
        this.paintMessageHighlights();
        this.positionMessageLabels();
        this.paintDetails();
        this.working.paint();
        this.screen.render();
        this.working.drawGraphics();
        if (this.selecting) {
            this.screen.program.hideCursor();
            return;
        }
        const column = Number(this.composer.strWidth(this.promptText + line.slice(start, cursor)));
        this.screen.program.cup(Number(this.screen.height) - 2, Math.min(Number(this.screen.width) - 1, column));
        this.screen.program.showCursor();
    }
}
