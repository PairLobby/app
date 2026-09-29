import blessed from 'blessed';
import type {Key} from 'node:readline';
import {stripVTControlCharacters} from 'node:util';
import {copyToClipboard} from './clipboard.js';

export type PanelChoice = {label: string; value: string; custom?: boolean};
export type PanelEdit = {kind: 'edit'; initial: string; choices?: PanelChoice[]; hint: string; save: (value: string) => Promise<void>; confirm?: (value: string) => string};
export type PanelMenu = {kind: 'menu'; load: () => Promise<RoomPanelPage>};
export type PanelCommand = {kind: 'command'; confirm: string; run: () => Promise<void>; closeAfterSave?: boolean};
export type RoomPanelRow = {id: string; label: string; value: string; section: string; hint?: string; action?: PanelEdit | PanelMenu | PanelCommand};
export type RoomPanelPage = {id: string; title: string; rows: RoomPanelRow[]; note: string; reload: () => Promise<RoomPanelPage>; closeOnCancel?: boolean};
type RoomPanelOptions = {screen: blessed.Widgets.Screen; close: () => void};
type Editor = {row: RoomPanelRow; value: string; cursor: number; choice: number; typing: boolean; confirmation?: string | undefined; apply: boolean; attempted?: boolean};

/** Room controls own keyboard focus while the chat continues receiving in the background. */
export class RoomPanel {
    private panel: blessed.Widgets.BoxElement;
    private cells: blessed.Widgets.BoxElement[] = [];
    private page: RoomPanelPage | undefined;
    private stack: RoomPanelPage[] = [];
    private selected = 0;
    private top = 0;
    private editor: Editor | undefined;
    private busy = false;
    private note = '';
    private revision = 0;

    constructor(private readonly options: RoomPanelOptions) {
        this.panel = blessed.box({parent: options.screen, top: 0, left: 0, right: 0, bottom: 0, border: 'line', hidden: true, mouse: true, tags: false, style: {fg: 'white', bg: 'black', border: {fg: 'cyan'}}});
        this.panel.on('wheelup', () => this.move(-1));
        this.panel.on('wheeldown', () => this.move(1));
    }

    get visible(): boolean { return this.panel.visible; }

    show(page: RoomPanelPage): void {
        this.revision++;
        this.page = page;
        this.stack = [];
        this.selected = this.top = 0;
        this.editor = undefined;
        this.busy = false;
        this.note = '';
        this.panel.show();
        this.panel.setFront();
        this.render();
    }

    hide(): void {
        this.revision++;
        this.panel.hide();
        this.editor = undefined;
    }

    private move(delta: number): void {
        if (this.busy || !this.page) {
            return;
        }
        if (this.editor) {
            if (this.editor.confirmation) {
                this.editor.apply = delta > 0;
            } else if (!this.editor.typing && this.editor.row.action?.kind === 'edit') {
                this.editor.choice = Math.max(0, Math.min((this.editor.row.action.choices?.length ?? 1) - 1, this.editor.choice + delta));
            }
        } else {
            this.selected = Math.max(0, Math.min(this.page.rows.length - 1, this.selected + delta));
        }
        this.render();
    }

    key(character: string | undefined, key: Key): void {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            if (this.busy) {
                this.hide();
                this.options.close();
                return;
            }
            if (this.editor) {
                if (this.page?.closeOnCancel) {
                    this.hide();
                    this.options.close();
                    return;
                }
                const attempted = this.editor.attempted;
                this.editor = undefined;
                this.note = attempted ? 'Editor closed. Refresh to confirm the current setting.' : 'Cancelled — no change saved.';
            } else if (this.stack.length) {
                this.page = this.stack.pop();
                this.selected = this.top = 0;
                void this.refresh();
            } else {
                this.hide();
                this.options.close();
                return;
            }
            this.render();
            return;
        }
        if (this.busy) {
            return;
        }
        if (Number(this.options.screen.height) < 11 || Number(this.options.screen.width) < 32) {
            return;
        }
        const enter = key.name === 'enter' || key.name === 'return';
        if (this.editor) {
            const editor = this.editor;
            if (enter) {
                void this.submit();
                return;
            }
            if (editor.confirmation || !editor.typing) {
                if (['up', 'left'].includes(key.name ?? '')) {
                    this.move(-1);
                }
                if (['down', 'right', 'tab'].includes(key.name ?? '')) {
                    this.move(1);
                }
                return;
            }
            const chars = Array.from(editor.value);
            if (key.name === 'left') {
                editor.cursor = Math.max(0, editor.cursor - 1);
            } else if (key.name === 'right') {
                editor.cursor = Math.min(chars.length, editor.cursor + 1);
            } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
                editor.cursor = 0;
            } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
                editor.cursor = chars.length;
            } else if (key.ctrl && key.name === 'u') {
                chars.splice(0, editor.cursor);
                editor.cursor = 0;
            } else if (key.ctrl && key.name === 'k') {
                chars.splice(editor.cursor);
            } else if (key.name === 'backspace' && editor.cursor) {
                chars.splice(--editor.cursor, 1);
            } else if (key.name === 'delete') {
                chars.splice(editor.cursor, 1);
            } else if (!key.ctrl && !key.meta && character && !/[\x00-\x1f\x7f]/.test(character)) {
                const added = Array.from(character);
                if (chars.length + added.length <= 8192) {
                    chars.splice(editor.cursor, 0, ...added);
                    editor.cursor += added.length;
                }
            }
            editor.value = chars.join('');
        } else if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
            this.move(key.name === 'up' || key.shift ? -1 : 1);
        } else if (key.name === 'pageup' || key.name === 'pagedown') {
            this.move((key.name === 'pageup' ? -1 : 1) * this.pageSize());
        } else if (key.name === 'home' || key.name === 'end') {
            this.selected = key.name === 'home' ? 0 : Math.max(0, (this.page?.rows.length ?? 1) - 1);
        } else if (key.name === 'r') {
            void this.refresh();
        } else if (enter) {
            void this.activate();
        }
        this.render();
    }

    private async refresh(): Promise<void> {
        if (!this.page || this.busy) {
            return;
        }
        const id = this.page.rows[this.selected]?.id;
        await this.perform(async (current) => {
            const page = await this.page!.reload();
            if (!current()) {
                return;
            }
            this.page = page;
            this.selected = Math.max(0, this.page.rows.findIndex((row) => row.id === id));
        }, 'Refreshed.');
    }

    private async activate(): Promise<void> {
        const row = this.page?.rows[this.selected];
        if (!row) {
            return;
        }
        const action = row.action;
        if (!action) {
            await this.perform(async (current) => {
                const note = await copyToClipboard(row.value);
                if (current()) {
                    this.note = note;
                }
            });
        } else if (action.kind === 'menu') {
            await this.perform(async (current) => {
                const next = await action.load();
                if (!current()) {
                    return;
                }
                this.stack.push(this.page!);
                this.page = next;
                this.selected = this.top = 0;
            });
        } else {
            const value = action.kind === 'edit' ? action.initial : '';
            const matchingChoice = action.kind === 'edit' ? action.choices?.findIndex((choice) => choice.value === value) ?? -1 : -1;
            const customChoice = action.kind === 'edit' ? action.choices?.findIndex((choice) => choice.custom) ?? 0 : 0;
            this.editor = {row, value, cursor: Array.from(value).length, choice: matchingChoice >= 0 ? matchingChoice : Math.max(0, customChoice), typing: action.kind === 'edit' && !action.choices, apply: false, ...(action.kind === 'command' ? {confirmation: action.confirm} : {})};
            this.note = '';
        }
        this.render();
    }

    private async submit(): Promise<void> {
        const editor = this.editor;
        const action = editor?.row.action;
        if (!editor || !action || action.kind === 'menu') {
            return;
        }
        if (editor.confirmation && !editor.apply) {
            if (this.page?.closeOnCancel) {
                this.hide();
                this.options.close();
                return;
            }
            this.editor = undefined;
            this.note = 'Cancelled — no change saved.';
            this.render();
            return;
        }
        if (action.kind === 'edit' && !editor.confirmation) {
            if (!editor.typing && action.choices) {
                const choice = action.choices[editor.choice]!;
                if (choice.custom) {
                    editor.typing = true;
                    this.render();
                    return;
                }
                editor.value = choice.value;
            }
            if (action.confirm) {
                editor.confirmation = action.confirm(editor.value);
                editor.apply = false;
                this.render();
                return;
            }
        }
        await this.perform(async (current) => {
            editor.attempted = true;
            action.kind === 'command' ? await action.run() : await action.save(editor.value);
            if (!current()) {
                return;
            }
            if (action.kind === 'command' && action.closeAfterSave) {
                this.hide();
                this.options.close();
                return;
            }
            this.editor = undefined;
            const page = await this.page!.reload();
            if (!current()) {
                return;
            }
            if (this.stack.at(-1)?.id === page.id) {
                this.stack.pop();
            }
            this.page = page;
            this.selected = Math.min(this.selected, Math.max(0, this.page.rows.length - 1));
        }, 'Saved.');
    }

    private async perform(work: (current: () => boolean) => Promise<void>, success = ''): Promise<void> {
        if (this.busy) {
            return;
        }
        const revision = this.revision;
        const current = () => revision === this.revision && this.visible;
        this.busy = true;
        this.note = 'Loading…';
        this.render();
        try {
            await work(current);
            if (!current()) {
                return;
            }
            if (success) {
                this.note = success;
            } else if (this.note === 'Loading…') {
                this.note = '';
            }
        } catch (error) {
            if (!current()) {
                return;
            }
            this.note = `Error: ${error instanceof Error ? error.message : String(error)}`;
            if (this.editor) {
                this.editor.confirmation = undefined; this.editor.apply = false;
            }
        } finally {
            if (revision === this.revision) {
                this.busy = false; this.render();
            }
        }
    }

    private pageSize(): number { return Math.max(1, Number(this.options.screen.height) - 9); }

    private line(top: number, text: string, selected = false, height = 1): blessed.Widgets.BoxElement {
        const box = blessed.box({parent: this.panel, top, left: 1, right: 1, height, content: stripVTControlCharacters(text), tags: false, wrap: height > 1, mouse: true, style: {fg: selected ? 'black' : 'white', bg: selected ? 'cyan' : 'black'}});
        this.cells.push(box);
        return box;
    }

    render(): void {
        if (!this.visible || !this.page) {
            return;
        }
        for (const cell of this.cells) { cell.destroy(); }
        this.cells = [];
        this.options.screen.program.hideCursor();
        const height = Number(this.options.screen.height);
        const width = Math.max(1, Number(this.options.screen.width) - 4);
        let cursorColumn: number | undefined;
        this.line(0, this.page.title);
        if (height < 11 || width < 28) {
            this.line(1, 'Enlarge terminal · Esc closes');
            this.options.screen.render();
            return;
        }
        this.line(1, this.busy ? 'Request in flight · Esc closes this view' : this.editor ? '↑/↓ select · Enter apply · Esc cancel' : '↑/↓/Tab select · Enter edit/copy · R refresh · Esc back/close');
        if (this.editor) {
            const editor = this.editor;
            this.line(3, editor.row.label);
            const action = editor.row.action;
            if (editor.confirmation) {
                this.line(5, editor.confirmation, false, Math.max(1, Math.min(4, height - 9)));
            } else if (!editor.typing && action?.kind === 'edit' && action.choices) {
                const first = Math.max(0, editor.choice - this.pageSize() + 2);
                action.choices.slice(first, first + Math.max(1, this.pageSize() - 1)).forEach((choice, offset) => {
                    const index = first + offset;
                    const cell = this.line(5 + offset, `${index === editor.choice ? '> ' : '  '}${choice.label}`, index === editor.choice);
                    cell.on('click', () => { editor.choice = index; this.render(); });
                });
            } else {
                const chars = Array.from(editor.value);
                let start = 0;
                while (start < editor.cursor && Number(this.panel.strWidth(chars.slice(start, editor.cursor).join(''))) > width - 3) {
                    start++;
                }
                this.line(5, '> ' + chars.slice(start).join(''), true);
                cursorColumn = Math.min(Number(this.options.screen.width) - 2, 4 + Number(this.panel.strWidth(chars.slice(start, editor.cursor).join(''))));
            }
        } else {
            if (this.selected < this.top) {
                this.top = this.selected;
            }
            if (this.selected >= this.top + this.pageSize()) {
                this.top = this.selected - this.pageSize() + 1;
            }
            const labelWidth = Math.min(24, Math.max(12, Math.floor(width * .35)));
            this.page.rows.slice(this.top, this.top + this.pageSize()).forEach((row, offset) => {
                const index = this.top + offset;
                const label = row.label.length > labelWidth ? row.label.slice(0, labelWidth - 1) + '…' : row.label;
                const cell = this.line(3 + offset, `${row.section.slice(0, 10).padEnd(10)} ${label.padEnd(labelWidth)} │ ${row.value}${row.action ? '  ›' : ''}`, index === this.selected);
                cell.on('click', () => { this.selected = index; this.render(); });
            });
        }
        const row = this.editor?.row ?? this.page.rows[this.selected];
        this.line(height - 5, this.editor?.confirmation ? (this.editor.apply ? '  Cancel     > Apply' : '> Cancel       Apply') : `${row?.section ?? ''}${row ? ' · ' + row.label + ': ' + row.value : ''}`, Boolean(this.editor?.confirmation));
        this.line(height - 4, this.note || (this.editor?.row.action?.kind === 'edit' ? this.editor.row.action.hint : row?.hint || this.page.note), false, 2);
        this.options.screen.render();
        if (cursorColumn !== undefined && !this.busy) {
            this.options.screen.program.cup(6, cursorColumn);
            this.options.screen.program.showCursor();
        }
    }
}
