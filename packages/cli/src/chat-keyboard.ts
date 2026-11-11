import {Transform} from 'node:stream';
import type {Readable, TransformCallback} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import type {Key} from 'node:readline';

type EnhancedKey = {character: string | undefined; key: Key};
type KeyboardSource = Readable & {isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown};

/** Kitty/CSI-u and xterm modifyOtherKeys spellings, decoded before blessed's legacy parser. */
export function enhancedKey(sequence: string): EnhancedKey | null {
    const csi = /^\x1b\[(\d+)(?:;(\d+)(?::[123])?)?u$/.exec(sequence);
    const xterm = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence);
    if (!csi && !xterm) {
        return null;
    }
    const point = Number(csi?.[1] ?? xterm?.[2]);
    const modifiers = Number(csi?.[2] ?? xterm?.[1] ?? 1) - 1;
    if (point > 0x10ffff || point >= 57344 && point <= 63743) {
        return null;
    }
    const text = String.fromCodePoint(point);
    const name = point === 13 ? 'enter' : point === 10 ? 'linefeed' : point === 9 ? 'tab' : point === 27 ? 'escape' : point === 127 ? 'backspace' : text.toLowerCase();
    const key: Key = {name, sequence, shift: Boolean(modifiers & 1), meta: Boolean(modifiers & (2 | 8)), ctrl: Boolean(modifiers & 4)};
    return {key, character: point >= 32 && point !== 127 && !key.ctrl && !key.meta ? text : undefined};
}

/** Keeps the original stdin/raw-mode owner, while recognizing modified Return and split escape sequences. */
export class ChatKeyboard extends Transform {
    private decoder = new StringDecoder('utf8');
    private pending = '';
    private escapeTimer: NodeJS.Timeout | undefined;

    constructor(private readonly source: KeyboardSource = process.stdin) {
        super();
        source.pipe(this);
    }

    get isTTY(): boolean {
        return Boolean(this.source.isTTY);
    }

    get isRaw(): boolean {
        return Boolean(this.source.isRaw);
    }

    setRawMode(mode: boolean): this {
        this.source.setRawMode?.(mode);
        return this;
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        clearTimeout(this.escapeTimer);
        let text = this.pending + this.decoder.write(chunk);
        this.pending = '';
        while (text) {
            const escape = text.indexOf('\x1b');
            if (escape < 0) {
                this.push(text);
                break;
            }
            if (escape > 0) {
                this.push(text.slice(0, escape));
                text = text.slice(escape);
            }
            if (text.startsWith('\x1b\r') || text.startsWith('\x1b\n')) {
                this.emit('keypress', undefined, {name: 'enter', meta: true, sequence: text.slice(0, 2)});
                text = text.slice(2);
                continue;
            }
            const sequence = /^\x1b\[(?:\d+(?:;\d+(?::[123])?)?u|27;\d+;\d+~)/.exec(text)?.[0];
            const decoded = sequence ? enhancedKey(sequence) : null;
            if (sequence && decoded) {
                // Kitty event type 3 is key release, not a second insertion or submission.
                if (!/:3u$/.test(sequence)) {
                    this.emit('keypress', decoded.character, decoded.key);
                }
                text = text.slice(sequence.length);
                continue;
            }
            if (text.length <= 24 && /^\x1b(?:\[(?:\d*(?:;\d*(?::\d*)?)?(?:;\d*)?)?)?$/.test(text)) {
                this.pending = text;
                this.escapeTimer = setTimeout(() => {
                    this.push(this.pending);
                    this.pending = '';
                }, 35);
                break;
            }
            const next = text.indexOf('\x1b', 1);
            this.push(next < 0 ? text : text.slice(0, next));
            text = next < 0 ? '' : text.slice(next);
        }
        done();
    }

    override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
        clearTimeout(this.escapeTimer);
        this.source.unpipe(this);
        done(error);
    }
}
