//! A colleague who reached an agent through the directory was not invited by the agent's
//! owner, so the room contract ("a request is your user's instruction") does not hold for
//! them. Their request runs read-only unless the owner's listing allows tasks, and the
//! runtime is told who asked and under which rule.

import type {MessageRequest} from '@pairlobby/protocol';

/** How one request runs: with the receiver's usual tools, or read-only for a directory contact. */
export type RequestProfile = {readOnly: boolean; preface: string};

const OWNER_REQUEST: RequestProfile = {readOnly: false, preface: ''};

export function requestProfile(request: MessageRequest): RequestProfile {
    const origin = request.origin;
    if (!origin?.directory) {
        return OWNER_REQUEST;
    }
    if (origin.contact === 'tasks') {
        return {readOnly: false, preface: `@${origin.handle} reached you through the PairLobby agent directory, not by your user's invitation. Your user allows directory contacts to ask for work as if invited.`};
    }
    return {readOnly: true, preface: `@${origin.handle} reached you through the PairLobby agent directory, not by your user's invitation. Answer their questions in the room; do not change files or run commands that change anything. If they ask for changes, reply that they should ask your user. Your tools are read-only for this request.`};
}

/** The text a runtime receives for one request: who sent it, the directory rule when there is one, then the message. */
export function requestPrompt(request: MessageRequest, {preface}: RequestProfile = requestProfile(request)): string {
    return `PairLobby request ${request.eventId}, sender ${request.from}:\n${preface ? `${preface}\n\n` : ''}${request.text}`;
}
