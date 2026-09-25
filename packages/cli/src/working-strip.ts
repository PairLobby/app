import blessed from 'blessed';
import {stripVTControlCharacters} from 'node:util';
import type {TurnEntry, TurnQueue} from '@pairlobby/protocol';
import {WorkingView, PROVIDER_LABELS} from './working-view.js';
import type {WorkingGroup} from './working-view.js';
import {LOGO_FRAME_MS, clearWorkingGraphics, drawWorkingGraphics, graphicsMode, logoColor, logoFrame} from './working-graphics.js';
import type {LogoPlacement} from './working-graphics.js';

type WorkingStripOptions = {screen: blessed.Widgets.Screen; render: () => void; rebuild: () => void; obscured: () => boolean};
type Badge = {group: WorkingGroup; box: blessed.Widgets.BoxElement; icon: blessed.Widgets.BoxElement; label: blessed.Widgets.BoxElement; compact: boolean};

export class WorkingStrip {
    readonly state = new WorkingView();
    private bar: blessed.Widgets.BoxElement;
    private popup: blessed.Widgets.BoxElement;
    private badges: Badge[] = [];
    private targets = new Set<blessed.Widgets.BoxElement>();
    private timer: NodeJS.Timeout | undefined;
    private selection: string | undefined;
    private pinned = false;
    private frame = 0;
    private signature = '';
    private graphics = graphicsMode();
    private placements: LogoPlacement[] = [];
    private suspended = false;

    constructor(private readonly options: WorkingStripOptions) {
        this.bar = blessed.box({parent: options.screen, bottom: 2, left: 0, right: 0, height: 3, hidden: true});
        this.popup = blessed.box({parent: options.screen, top: 0, right: 1, width: 56, height: 5, border: 'line', padding: {left: 1, right: 1}, mouse: true, hidden: true, tags: false, style: {fg: 'white', bg: 'black', border: {fg: 'cyan'}}});
        options.screen.on('mouse', (event: blessed.Widgets.Events.IMouseEventArg) => {
            if (event.action !== 'mousedown' || !this.selection) {
                return;
            }
            const hit = [this.popup, ...this.targets].some((box) => {
                const position = box.lpos;
                return box.visible && position && event.x >= position.xi && event.x < position.xl && event.y >= position.yi && event.y < position.yl;
            });
            if (!hit) {
                this.hide();
            }
        });
    }

    update(queue: TurnQueue): void {
        this.state.update(queue);
    }

    bind(box: blessed.Widgets.BoxElement, selection: string): void {
        this.targets.add(box);
        box.on('mouseover', () => {
            if (!this.pinned) {
                this.selection = selection;
                this.options.render();
            }
        });
        box.on('mouseout', () => { if (!this.pinned) { this.hide(); } });
        box.on('click', () => {
            this.selection = selection;
            this.pinned = true;
            this.options.render();
        });
    }

    showAll(): void {
        this.selection = 'all';
        this.pinned = true;
        this.options.render();
    }

    hide(): void {
        this.selection = undefined;
        this.pinned = false;
        this.popup.hide();
        this.options.render();
    }

    clearGraphics(): void {
        if (this.placements.length) {
            this.options.screen.program.flush();
            process.stdout.write(clearWorkingGraphics(this.graphics, this.placements));
            this.placements = [];
        }
    }

    suspend(): void {
        this.clearGraphics();
        this.suspended = true;
    }

    resume(): void {
        this.suspended = false;
    }

    close(): void {
        this.suspend();
        if (this.timer) {
            clearInterval(this.timer);
        }
    }

    private activeSignature(): string {
        return this.state.active().map((entry) => entry.requestId).sort().join(',');
    }

    rebuild(bottom: number): number {
        this.clearGraphics();
        this.targets.clear();
        for (const child of [...this.bar.children]) {
            child.destroy();
        }
        this.badges = [];
        const groups = this.state.groups();
        this.signature = this.activeSignature();
        if (!groups.length) {
            this.bar.hide();
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = undefined;
            }
            return 0;
        }
        const width = Math.max(1, Math.floor(Number(this.options.screen.width) / groups.length));
        const compact = width < 10 || Number(this.options.screen.height) < 14;
        this.bar.bottom = bottom;
        this.bar.height = compact ? 1 : 3;
        this.bar.show();
        groups.forEach((group, index) => {
            const box = blessed.box({parent: this.bar, top: 0, left: index * width, width, height: compact ? 1 : 3, mouse: true});
            const icon = blessed.box({parent: box, top: 0, left: 0, width: compact ? 1 : 6, height: compact ? 1 : 3, tags: false, style: {fg: logoColor(group.provider)}});
            const label = blessed.box({parent: box, top: compact ? 0 : 1, left: compact ? 2 : 7, right: 0, height: 1, tags: false, wrap: false, style: {fg: 'cyan'}});
            this.badges.push({group, box, icon, label, compact});
            this.bind(box, `provider:${group.provider}`);
        });
        if (!this.timer) {
            this.timer = setInterval(() => {
                if (this.suspended) {
                    return;
                }
                this.frame += 1;
                if (this.signature !== this.activeSignature()) {
                    this.options.rebuild();
                } else {
                    this.options.render();
                }
            }, LOGO_FRAME_MS);
            this.timer.unref();
        }
        return compact ? 1 : 3;
    }

    paint(): void {
        for (const badge of this.badges) {
            const frame = logoFrame(badge.group.provider, this.frame);
            const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'][this.frame % 8]!;
            badge.icon.setContent(badge.compact || !frame ? spinner : this.graphics === 'cells' ? frame.cells : '');
            badge.label.setContent(`${PROVIDER_LABELS[badge.group.provider]} ×${badge.group.count}`);
        }
        if (this.selection) {
            const entries = this.selection === 'all' ? this.state.active() : this.selection.startsWith('provider:')
                ? this.state.groups().find((group) => `provider:${group.provider}` === this.selection)?.entries ?? []
                : this.state.forMessage(this.selection);
            const people = new Map<string, TurnEntry[]>();
            for (const entry of entries) {
                people.set(entry.participantId, [...(people.get(entry.participantId) ?? []), entry]);
            }
            const lines = [...people].map(([id, requests]) => {
                const name = requests[0]!.name;
                const duplicate = entries.some((entry) => entry.participantId !== id && entry.name === name);
                const seconds = Math.max(0, Math.floor((Date.now() - Math.min(...requests.map((entry) => entry.workingAt!))) / 1000));
                return `${stripVTControlCharacters(name)}${duplicate ? ` (${id.slice(-6)})` : ''} — ${seconds}s${requests.length > 1 ? ` · ${requests.length} requests` : ''}`;
            });
            this.popup.width = Math.max(12, Math.min(56, Number(this.options.screen.width) - 2));
            this.popup.height = Math.max(4, Math.min(Number(this.options.screen.height) - 5, lines.length + 3));
            this.popup.top = Math.max(0, Number(this.options.screen.height) - Number(this.bar.bottom) - Number(this.bar.height) - Number(this.popup.height) - 1);
            this.popup.setContent(`Working on an answer\n${lines.length ? lines.join('\n') : 'No agents are currently declaring work.'}`);
            this.popup.show();
            this.popup.setFront();
        }
    }

    drawGraphics(): void {
        if (this.suspended || this.options.obscured() || this.popup.visible) {
            this.clearGraphics();
            return;
        }
        const placements = this.badges.filter((badge) => !badge.compact && badge.group.provider !== 'other').map((badge) => ({provider: badge.group.provider, row: Number(badge.icon.atop), column: Number(badge.icon.aleft)}));
        if (this.graphics !== 'cells' && placements.length) {
            this.options.screen.program.flush();
            process.stdout.write((this.graphics === 'iterm2' ? clearWorkingGraphics(this.graphics, this.placements) : '') + drawWorkingGraphics(this.graphics, placements, this.frame));
            this.placements = placements;
        }
    }
}
