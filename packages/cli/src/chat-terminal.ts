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

type ChatTerminalOptions = {names: Map<string, string>; participantId: string; format: (event: RoomEvent) => string; complete: (line: string) => [string[], string]};
type TranscriptEntry = {text: string; event?: RoomEvent};
type ScreenKey = Key & {full?: string};
type TerminalProgramOptions = {extended: boolean; debug: boolean};

function createTerminalProgram(): blessed.BlessedProgram {
    // Blessed's legacy compiler cannot parse some modern extended capabilities
    // (e.g. Setulc). Standard terminfo supplies all capabilities used by this UI.
    const options: TerminalProgramOptions = {extended: false, debug: false};
    return blessed.program(options);
}

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
    private turns = blessed.box({parent: this.screen, bottom: 2, left: 0, right: 0, height: 1, tags: false, style: {fg: 'cyan'}});
    private quote = blessed.box({parent: this.screen, bottom: 2, left: 0, right: 0, height: 1, tags: false, wrap: false, hidden: true, style: {fg: 'gray'}});
    private popup = blessed.box({parent: this.screen, right: 1, top: 0, width: 58, height: 8, border: 'line', padding: {left: 1, right: 1}, tags: false, hidden: true, mouse: true, style: {fg: 'white', bg: 'black', border: {fg: 'gray'}}});
    private working = new WorkingStrip({screen: this.screen, render: () => this.renderInput(), rebuild: () => this.rebuild(), obscured: () => this.popup.visible});
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
    private follow = true;
    private inputChanged: (() => void) | undefined;
    private labels = new Map<string, blessed.Widgets.BoxElement>();
    private reply = new ReplyComposer();
    private submittedReply: ReplySubmission | undefined;
    private hintText = '';
    private revealReply = false;

    constructor(private readonly options: ChatTerminalOptions) {
        this.input = createInterface({input: this.keyboard, output: this.output, terminal: true, completer: options.complete});
        this.screen.on('keypress', (character: string, key: ScreenKey) => {
            if (this.suspended || this.closed) {
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
        this.screen.on('mouse', (event: blessed.Widgets.Events.IMouseEventArg) => {
            if (event.action !== 'mousedown' || !this.detailsId || this.closed || this.suspended) {
                return;
            }
            const contains = (element: blessed.Widgets.BoxElement | undefined): boolean => {
                const bounds = element?.lpos;
                return Boolean(element?.visible && bounds && event.x >= bounds.xi && event.x < bounds.xl && event.y >= bounds.yi && event.y < bounds.yl);
            };
            if (!contains(this.popup) && !contains(this.labels.get(this.detailsId))) {
                this.hideDetails();
            }
        });
        this.screen.on('resize', () => {
            this.working.clearGraphics();
            this.output.columns = Number(this.screen.width);
            this.rebuild();
        });
        this.screen.program.enableMouse();
        this.renderInput();
    }

    setPrompt(text: string): void {
        this.promptText = stripVTControlCharacters(text);
        this.input.setPrompt(this.promptText);
        this.renderInput();
    }

    onInput(callback: () => void): void {
        this.inputChanged = callback;
    }

    setHint(text: string): void {
        this.hintText = text;
        this.renderInput();
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
        this.turns.setContent(stripVTControlCharacters(text));
        this.renderInput();
    }

    log(text: string): void {
        this.entries.push({text});
        this.rebuild();
    }

    addEvent(event: RoomEvent): void {
        this.receipts.observe(event);
        if (!this.events.has(event.eventId)) {
            this.events.add(event.eventId);
            if (event.type !== 'message.received' && !(event.type === 'conversation.turn_changed' && ['claimed', 'working'].includes(event.payload.action))) {
                this.entries.push({text: this.options.format(event), event});
            }
        }
        this.rebuild();
    }

    updateRequest(request: MessageRequest): void {
        const before = this.receipts.forMessage(request.eventId).length;
        this.receipts.observeRequest(request);
        if (this.receipts.forMessage(request.eventId).length !== before) {
            this.rebuild();
        }
    }

    showLatestReceipt(reference?: string): void {
        const messages = this.entries.filter((entry) => entry.event?.type === 'message');
        const selected = reference
            ? messages.findLast((entry) => entry.event!.eventId === reference || entry.event!.seq.toString() === reference)
            : messages.findLast((entry) => entry.event!.senderId === this.options.participantId) ?? messages.at(-1);
        if (!selected?.event) {
            this.log('No matching message in the loaded transcript.');
            return;
        }
        this.pinned = true;
        this.showDetails(selected.event.eventId);
    }

    suspend(): void {
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
        this.closed = true;
        this.input.close();
        this.keyboard.destroy();
        this.output.destroy();
        this.screen.destroy();
    }

    private rebuild(): void {
        if (this.closed || this.suspended) {
            return;
        }
        const scroll = this.body.getScroll();
        for (const child of [...this.body.children]) {
            child.destroy();
        }
        this.labels.clear();
        // Keep terminal memory bounded; the durable transcript remains on the relay.
        if (this.entries.length > 1000) {
            this.entries.splice(0, this.entries.length - 1000);
        }
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
            const receipt = message && this.receipts.forMessage(message.eventId).length > 0;
            const content = blessed.text({parent: this.body, top, left: 0, right: isWorking ? 19 : message ? 9 : 1, height: 'shrink', content: selected ? stripVTControlCharacters(entry.text) : entry.text, tags: false, wrap: true, style: selected ? {bg: 'blue', fg: 'white'} : {}});
            const lines = Math.max(1, content.getScreenLines().length);
            content.height = lines;
            if (isWorking && message) {
                const label = blessed.box({parent: this.body, top, right: 8, width: 7, height: 1, content: 'Working', mouse: true, style: {fg: 'cyan', hover: {underline: true}}});
                this.working.bind(label, message.eventId);
            }
            if (receipt && message) {
                const label = blessed.box({parent: this.body, top, right: 2, width: 4, height: 1, content: 'Seen', mouse: true, style: {fg: 'gray', hover: {fg: 'white', underline: true}}});
                this.labels.set(message.eventId, label);
                label.on('mouseover', () => { if (!this.pinned) { this.showDetails(message.eventId); } });
                label.on('mouseout', () => { if (!this.pinned) { this.hideDetails(); } });
                label.on('mousedown', () => { this.pinned = true; this.showDetails(message.eventId); });
                label.on('click', () => { this.pinned = true; this.showDetails(message.eventId); });
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
        if (this.detailsId) {
            this.showDetails(this.detailsId);
        }
        this.renderInput();
    }

    private showDetails(eventId: string): void {
        this.detailsId = eventId;
        const receipts = this.receipts.forMessage(eventId);
        this.popup.width = Math.max(10, Math.min(58, Number(this.screen.width) - 2));
        const contentWidth = Number(this.popup.width) - 4;
        const width = (text: string) => Number(this.popup.strWidth(text));
        const lines = receipts.map((receipt) => {
            const acknowledgement = `Acknowledged ${new Date(receipt.acknowledgedAt).toLocaleString()}`;
            const name = stripVTControlCharacters(this.options.names.get(receipt.participantId) ?? receipt.participantId);
            const nameWidth = Math.max(1, contentWidth - width(acknowledgement) - 2);
            let displayedName = name;
            if (width(name) > nameWidth) {
                displayedName = '';
                for (const {segment} of new Intl.Segmenter().segment(name)) {
                    if (width(displayedName + segment + '…') > nameWidth) {
                        break;
                    }
                    displayedName += segment;
                }
                displayedName += '…';
            }
            return displayedName + ' '.repeat(Math.max(1, contentWidth - width(displayedName) - width(acknowledgement))) + acknowledgement;
        });
        this.popup.height = Math.max(3, Math.min(Number(this.screen.height) - 4, Math.max(4, receipts.length + 3)));
        const anchor = this.labels.get(eventId);
        this.popup.top = Math.max(0, Math.min(anchor ? Number(anchor.atop) + 1 : Number(this.screen.height) - 3, Number(this.screen.height) - Number(this.popup.height) - 3));
        this.popup.setContent(`Confirmed receipts\n${lines.length ? lines.join('\n') : 'No acknowledgement yet.'}`);
        this.popup.show();
        this.popup.setFront();
        this.renderInput();
    }

    private hideDetails(): void {
        this.pinned = false;
        this.detailsId = undefined;
        this.popup.hide();
        this.renderInput();
    }

    private renderInput(): void {
        if (this.closed || this.suspended) {
            return;
        }
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
        this.hint.setContent(this.reply.active
            ? this.reply.picking ? '↑/↓ choose a message · Enter/Tab select · Esc cancel' : 'Enter sends your reply · Delete /reply or Esc to cancel'
            : this.hintText || 'Hover/click Seen · F2 Seen · F3 Working · PgUp/PgDn scroll');
        this.composer.setContent(this.promptText + line.slice(start, start + width));
        this.working.paint();
        this.screen.render();
        this.working.drawGraphics();
        const column = Number(this.composer.strWidth(this.promptText + line.slice(start, cursor)));
        this.screen.program.cup(Number(this.screen.height) - 2, Math.min(Number(this.screen.width) - 1, column));
        this.screen.program.showCursor();
    }
}
