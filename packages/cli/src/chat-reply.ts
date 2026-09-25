import {ProtocolError, newId} from '@pairlobby/protocol';
import type {MessageRequest, SendEventResponse} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';
import type {ReplySubmission} from './reply-composer.js';

type ChatReplyContext = {client: PairLobbyClient; roomId: string; credential: string; participantId: string; quotedMessagesSupported: boolean};

export async function sendChatReply(submission: ReplySubmission, context: ChatReplyContext): Promise<SendEventResponse> {
    const {client, roomId, credential, participantId} = context;
    if (submission.responseTo) {
        return client.reply(roomId, credential, submission.responseTo, submission.text);
    }
    let request: MessageRequest | undefined;
    if (!submission.idempotencyKey) {
        try {
            request = await client.request(roomId, credential, submission.target.eventId);
        } catch (error) {
            if (!(error instanceof ProtocolError) || error.code !== 'invalid_request') {
                throw error;
            }
        }
    }
    if (request?.to === participantId && request.requiresReply && !request.responseEventId) {
        submission.responseTo = request.eventId;
        return client.reply(roomId, credential, request.eventId, submission.text);
    }
    submission.idempotencyKey ??= newId('event');
    if (!context.quotedMessagesSupported) {
        throw new ProtocolError('unsupported_capability', 'Update this relay to send quoted follow-ups.');
    }
    const recipientId = submission.target.senderId;
    return client.send(roomId, credential, {
        type: 'message', payload: {text: submission.text, priority: 'normal'},
        quoteOf: submission.target.eventId, idempotencyKey: submission.idempotencyKey,
        ...(recipientId && recipientId !== participantId ? {recipientId} : {allRecipients: true})
    });
}
