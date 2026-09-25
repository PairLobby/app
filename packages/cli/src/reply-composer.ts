import {stripVTControlCharacters} from 'node:util';
import type {RoomEvent} from '@pairlobby/protocol';

export type ReplyTarget = {eventId: string; senderId: string | null; text: string};
export type ReplySubmission = {target: ReplyTarget; text: string; idempotencyKey?: string; responseTo?: string};

export function messageTarget(event: RoomEvent): ReplyTarget | undefined {
    return event.type === 'message' ? {eventId: event.eventId, senderId: event.senderId, text: event.payload.text} : undefined;
}

export function quotePreview(target: ReplyTarget, names: Map<string, string>): string {
    const name = target.senderId ? names.get(target.senderId) ?? target.senderId : 'room';
    const text = stripVTControlCharacters(target.text).replace(/\s+/gu, ' ').trim();
    const preview = Array.from(text);
    return `> ${stripVTControlCharacters(name)}: ${preview.slice(0, 160).join('')}${preview.length > 160 ? '…' : ''}`;
}

/** Selection stays attached to an event ID while new transcript rows arrive. */
export class ReplyComposer {
    active = false;
    picking = false;
    target: ReplyTarget | undefined;
    private explicit = false;
    private retry: ReplySubmission | undefined;

    sync(line: string, messages: ReplyTarget[]): void {
        if (!/^\/reply(?:\s|$)/u.test(line)) {
            this.clear();
            return;
        }
        this.active = true;
        const explicit = /^\/reply\s+(ev_\S*)/u.exec(line);
        if (explicit) {
            this.explicit = true;
            this.picking = false;
            this.target = messages.find((message) => message.eventId === explicit[1]);
            return;
        }
        if (this.explicit) {
            this.target = undefined;
        }
        this.explicit = false;
        if (!this.target) {
            this.picking = true;
            this.target = messages.at(-1);
        } else if (this.picking && !messages.some((message) => message.eventId === this.target!.eventId)) {
            this.target = messages.at(-1);
        }
    }

    move(direction: -1 | 1, messages: ReplyTarget[]): void {
        if (!this.picking || !messages.length) {
            return;
        }
        const index = messages.findIndex((message) => message.eventId === this.target?.eventId);
        this.target = messages[Math.max(0, Math.min(messages.length - 1, index + direction))];
    }

    choose(): boolean {
        if (!this.target) {
            return false;
        }
        this.picking = false;
        return true;
    }

    answer(line: string): string {
        return line.replace(this.explicit ? /^\/reply\s+ev_\S*\s*/u : /^\/reply\s*/u, '');
    }

    submit(line: string): ReplySubmission | undefined {
        const text = this.answer(line).trim();
        const submission = this.active && !this.picking && this.target && text
            ? this.retry?.target.eventId === this.target.eventId && this.retry.text === text ? this.retry : {target: this.target, text}
            : undefined;
        this.clear();
        return submission;
    }

    restore(submission: ReplySubmission): void {
        this.active = true;
        this.picking = false;
        this.explicit = false;
        this.target = submission.target;
        this.retry = submission;
    }

    clear(): void {
        this.active = false;
        this.picking = false;
        this.explicit = false;
        this.target = undefined;
        this.retry = undefined;
    }
}
