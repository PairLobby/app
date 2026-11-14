import {ProtocolError} from '@pairlobby/protocol';
import type {FileReceiptRequest, FileRecord, FileRetention, FileRetentionRequest} from '@pairlobby/protocol';

import type {RoomView} from './state.js';

export type FileReceiptDecision = {file: FileRecord; remove: boolean; remaining: number};

export function resolveFileRetention(request: FileRetentionRequest, now: number): FileRetention {
    return request.mode === 'temporary' ? {mode: 'temporary', expiresAt: now + request.ttlMs} : {mode: request.mode};
}

export function fileExpired(file: FileRecord, now: number): boolean {
    return file.retention?.mode === 'temporary' && file.retention.expiresAt <= now;
}

export function attachFile(file: FileRecord, view: RoomView, eventId: string, now: number): FileRecord {
    if (fileExpired(file, now)) {
        throw new ProtocolError('invalid_request', 'this temporary file has expired; upload it again');
    }
    if (file.retention?.mode !== 'until-received') {
        return {...file, eventId};
    }
    const receiptRecipients = view.participants.filter((participant) => participant.participantId !== file.uploaderId && participant.revokedAt === null && participant.leftAt === null).map((participant) => participant.participantId);
    if (!receiptRecipients.length) {
        throw new ProtocolError('invalid_request', 'delete-on-receipt needs another member in the room before sending');
    }
    return {...file, eventId, receiptRecipients, receivedBy: []};
}

/** A file receipt is an explicit confirmation of a complete, verified download, separate from message receipts. */
export function receiveFile(file: FileRecord, participantId: string, receipt: FileReceiptRequest): FileReceiptDecision {
    if (file.eventId === null || receipt.sha256 !== file.sha256 || receipt.size !== file.size) {
        throw new ProtocolError('invalid_request', 'confirm the size and SHA-256 of the complete attached file');
    }
    const recipients = file.receiptRecipients ?? [];
    const receivedBy = new Set(file.receivedBy ?? []);
    if (recipients.includes(participantId)) {
        receivedBy.add(participantId);
    }
    const remaining = recipients.filter((id) => !receivedBy.has(id)).length;
    return {file: {...file, receivedBy: [...receivedBy]}, remove: file.retention?.mode === 'until-received' && recipients.length > 0 && remaining === 0, remaining};
}
