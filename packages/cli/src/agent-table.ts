import blessed from 'blessed';
import type {Key} from 'node:readline';
import {AGENT_COLUMNS, plainCell} from './agent-roster.js';
import type {AgentRoster, AgentRow} from './agent-roster.js';
import {copyToClipboard} from './clipboard.js';

type AgentTableOptions = {screen: blessed.Widgets.Screen; close: () => void; refresh: () => Promise<AgentRoster>; copy?: (value: string) => Promise<string>};
type CellMouseEvent = blessed.Widgets.Events.IMouseEventArg & {button?: string};
type CellClick = {id: string; value: string; at: number};

/** A modal snapshot of the room's agents. Cell identity survives scrolling and rerenders. */
export class AgentTable {
    private panel: blessed.Widgets.BoxElement;
    private roster: AgentRoster = {rows: [], at: 0, notes: []};
    private cells: blessed.Widgets.BoxElement[] = [];
    private selected = 0;
    private column = 0;
    private top = 0;
    private firstColumn = 0;
    private lastClick: CellClick | undefined;
    private note = '';
    private revision = 0;
    private refreshing = false;

    constructor(private readonly options: AgentTableOptions) {
        this.panel = blessed.box({parent: options.screen, top: 0, left: 0, right: 0, bottom: 0, border: 'line', mouse: true, hidden: true, tags: false, style: {fg: 'white', bg: 'black', border: {fg: 'cyan'}}});
        this.panel.on('wheelup', () => this.move(-1, 0));
        this.panel.on('wheeldown', () => this.move(1, 0));
    }

    get visible(): boolean {
        return this.panel.visible;
    }

    show(roster: AgentRoster): void {
        this.revision++;
        this.refreshing = false;
        if (!this.visible) {
            this.selected = 0;
            this.column = 0;
            this.top = 0;
            this.firstColumn = 0;
        }
        this.roster = roster;
        this.selected = Math.min(this.selected, Math.max(0, roster.rows.length - 1));
        this.lastClick = undefined;
        this.note = '';
        this.panel.show();
        this.panel.setFront();
        this.render();
    }

    hide(): void {
        this.revision++;
        this.refreshing = false;
        this.lastClick = undefined;
        this.panel.hide();
    }

    key(key: Key): void {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            this.hide();
            this.options.close();
        } else if (key.name === 'up' || key.name === 'down') {
            this.move(key.name === 'up' ? -1 : 1, 0);
        } else if (key.name === 'left' || key.name === 'right') {
            this.move(0, key.name === 'left' ? -1 : 1);
        } else if (key.name === 'tab') {
            this.move(0, key.shift ? -1 : 1);
        } else if (key.name === 'pageup' || key.name === 'pagedown') {
            this.move((key.name === 'pageup' ? -1 : 1) * this.pageSize(), 0);
        } else if (key.name === 'home' || key.name === 'end') {
            this.selected = key.name === 'home' ? 0 : Math.max(0, this.roster.rows.length - 1);
            this.render();
        } else if (key.name === 'enter' || key.name === 'return') {
            void this.copySelected();
        } else if (key.name === 'r') {
            void this.refresh();
        }
    }

    private pageSize(): number {
        return Math.max(1, Number(this.options.screen.height) - 8);
    }

    private move(rows: number, columns: number): void {
        this.selected = Math.max(0, Math.min(this.roster.rows.length - 1, this.selected + rows));
        this.column = Math.max(0, Math.min(AGENT_COLUMNS.length - 1, this.column + columns));
        this.lastClick = undefined;
        this.render();
    }

    private async refresh(): Promise<void> {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;
        const revision = ++this.revision;
        this.note = 'Refreshing…';
        this.render();
        try {
            const id = this.roster.rows[this.selected]?.participantId;
            const roster = await this.options.refresh();
            if (this.visible && revision === this.revision) {
                this.roster = roster;
                this.selected = Math.max(0, roster.rows.findIndex((row) => row.participantId === id));
                this.lastClick = undefined;
                this.note = '';
            }
        } catch {
            if (this.visible && revision === this.revision) {
                this.note = 'Refresh failed; showing the previous snapshot. Press R to retry.';
            }
        } finally {
            if (revision === this.revision) {
                this.refreshing = false;
                this.render();
            }
        }
    }

    private click(row: AgentRow, column: number): void {
        const value = plainCell(row[AGENT_COLUMNS[column]!.key]);
        const id = `${row.participantId}:${AGENT_COLUMNS[column]!.key}`;
        const double = this.lastClick?.id === id && this.lastClick.value === value && Date.now() - this.lastClick.at <= 450;
        this.selected = this.roster.rows.indexOf(row);
        this.column = column;
        this.lastClick = double ? undefined : {id, value, at: Date.now()};
        this.render();
        if (double) {
            void this.copySelected();
        }
    }

    private async copySelected(): Promise<void> {
        const row = this.roster.rows[this.selected];
        const column = AGENT_COLUMNS[this.column]!;
        if (!row) {
            return;
        }
        const revision = this.revision;
        try {
            this.options.screen.program.flush();
            const result = await (this.options.copy ?? copyToClipboard)(plainCell(row[column.key]));
            if (this.visible && revision === this.revision) {
                this.note = `${result}: ${column.label} for ${row.name}`;
                this.render();
            }
        } catch {
            if (this.visible && revision === this.revision) {
                this.note = 'Could not copy this cell.';
                this.render();
            }
        }
    }

    private text(value: string, width: number): string {
        const clean = plainCell(value);
        if (Number(this.panel.strWidth(clean)) <= width) {
            return clean;
        }
        let truncated = '';
        for (const character of clean) {
            if (Number(this.panel.strWidth(truncated + character)) > width - 1) {
                break;
            }
            truncated += character;
        }
        return truncated + '…';
    }

    private box(top: number, left: number, width: number, text: string, selected = false): blessed.Widgets.BoxElement {
        const box = blessed.box({parent: this.panel, top, left, width, height: 1, tags: false, wrap: false, mouse: true, content: this.text(text, width), style: {fg: selected ? 'black' : 'white', bg: selected ? 'cyan' : 'black'}});
        this.cells.push(box);
        return box;
    }

    render(): void {
        if (!this.visible) {
            return;
        }
        for (const cell of this.cells) {
            cell.destroy();
        }
        this.cells = [];
        const width = Math.max(1, Number(this.options.screen.width) - 4);
        const height = Number(this.options.screen.height);
        if (height < 10 || width < 24) {
            this.box(0, 1, width, 'Enlarge terminal · Esc closes');
            this.options.screen.render();
            return;
        }
        this.firstColumn = Math.min(this.firstColumn, this.column);
        while (AGENT_COLUMNS.slice(this.firstColumn, this.column + 1).reduce((sum, column) => sum + Math.min(column.width, width) + 1, -1) > width) {
            this.firstColumn++;
        }
        this.top = Math.min(this.top, this.selected);
        if (this.selected >= this.top + this.pageSize()) {
            this.top = this.selected - this.pageSize() + 1;
        }
        this.box(0, 1, width, `Agents (${this.roster.rows.length}) · snapshot ${new Date(this.roster.at).toISOString()} · column ${this.column + 1}/${AGENT_COLUMNS.length}`);
        this.box(1, 1, width, 'Double-click/Enter copy | Arrows/PgUp/PgDn | R refresh | Esc close');
        let left = 1;
        for (let columnIndex = this.firstColumn; columnIndex < AGENT_COLUMNS.length; columnIndex++) {
            const column = AGENT_COLUMNS[columnIndex]!;
            if (column.width > width - left + 1 && left > 1) {
                break;
            }
            const size = Math.min(column.width, width - left + 1);
            if (size < 3) {
                break;
            }
            this.box(2, left, size, column.label, columnIndex === this.column);
            this.roster.rows.slice(this.top, this.top + this.pageSize()).forEach((row, offset) => {
                const cell = this.box(3 + offset, left, size, row[column.key] + (column.key === 'model' && row.configuredModel ? '*' : ''), this.top + offset === this.selected && columnIndex === this.column);
                cell.on('mousedown', (event: CellMouseEvent) => {
                    if (event.button === 'left') {
                        this.click(row, columnIndex);
                    }
                });
            });
            left += size;
            if (left <= width) {
                for (let top = 2; top < 3 + Math.max(1, Math.min(this.roster.rows.length, this.pageSize())); top++) {
                    this.box(top, left, 1, '│');
                }
            }
            left++;
        }
        if (!this.roster.rows.length) {
            this.box(3, 1, width, 'No agents currently in this room.');
        }
        const row = this.roster.rows[this.selected];
        const column = AGENT_COLUMNS[this.column]!;
        this.box(height - 5, 1, width, row ? `${row.name} · ${column.label}: ${row[column.key]}` : '');
        this.box(height - 4, 1, width, this.note || this.roster.notes[0] || '');
        this.box(height - 3, 1, width, this.roster.notes.slice(1).join(' '));
        this.panel.setFront();
        this.options.screen.render();
        this.options.screen.program.hideCursor();
    }
}
