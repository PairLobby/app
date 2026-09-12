//! Handover rules. A revision is immutable once offered; an amendment is the
//! next revision; acceptance names an exact revision so a stale one can never be
//! accepted by accident.

import {ProtocolError} from '@pairlobby/protocol';
import type {HandoverDocument, HandoverRecord, ParticipantRecord} from '@pairlobby/protocol';

import {assertRecipientExists} from './authorize.js';
import type {CoreContext, RoomView} from './state.js';

interface OfferPayload {
    handoverId: string;
    revision: number;
    document: HandoverDocument;
}

interface ResolvePayload {
    handoverId: string;
    revision: number;
}

export function applyHandoverOffered(view: RoomView, sender: ParticipantRecord, payload: OfferPayload, recipientId: string | null, ctx: CoreContext): HandoverRecord {
    if (recipientId === null) throw new ProtocolError('invalid_request', 'a handover must name its recipient');
    const recipient = assertRecipientExists(view, recipientId);
    if (recipient.participantId === sender.participantId) throw new ProtocolError('invalid_request', 'a handover cannot be offered to its own sender');
    const existing = view.handovers.find((handover) => handover.handoverId === payload.handoverId);
    if (!existing) {
        if (payload.revision !== 1) throw new ProtocolError('stale_handover_revision', 'a new handover must start at revision 1', {currentRevision: 0});
        return {
            handoverId: payload.handoverId,
            roomId: view.room.roomId,
            senderId: sender.participantId,
            recipientId,
            revision: 1,
            document: payload.document,
            state: 'offered',
            offeredEventId: '',
            resolvedEventId: null,
            resolvedAt: null,
        };
    }
    if (existing.senderId !== sender.participantId) throw new ProtocolError('unauthorized', 'only the original sender may amend this handover');
    if (existing.state === 'accepted') throw new ProtocolError('handover_already_resolved', 'this handover was already accepted and cannot be amended');
    if (payload.revision !== existing.revision + 1) throw new ProtocolError('stale_handover_revision', `the next revision of this handover is ${existing.revision + 1}`, {currentRevision: existing.revision});
    return {...existing, recipientId, revision: payload.revision, document: payload.document, state: 'offered', resolvedEventId: null, resolvedAt: null};
}

export function applyHandoverAccepted(view: RoomView, actor: ParticipantRecord, payload: ResolvePayload): HandoverRecord {
    const handover = requireResolvable(view, actor, payload);
    return {...handover, state: 'accepted'};
}

export function applyHandoverDeclined(view: RoomView, actor: ParticipantRecord, payload: ResolvePayload): HandoverRecord {
    const handover = requireResolvable(view, actor, payload);
    return {...handover, state: 'declined'};
}

function requireResolvable(view: RoomView, actor: ParticipantRecord, payload: ResolvePayload): HandoverRecord {
    const handover = view.handovers.find((candidate) => candidate.handoverId === payload.handoverId);
    if (!handover) throw new ProtocolError('invalid_request', 'no such handover in this room');
    if (handover.recipientId !== actor.participantId) throw new ProtocolError('unauthorized', 'only the named recipient may resolve this handover');
    // Resolution is terminal for its revision. Reversing a decline needs the sender
    // to amend, so the sender never discovers a handover they were told was refused.
    if (handover.state !== 'offered') throw new ProtocolError('handover_already_resolved', `this handover revision was already ${handover.state}; ask the sender to amend it`);
    if (payload.revision !== handover.revision) throw new ProtocolError('stale_handover_revision', `this handover is at revision ${handover.revision}`, {currentRevision: handover.revision});
    return handover;
}
