// Offline UI fixture: no relay, provider, credentials or clipboard writes.
import {ChatTerminal} from '../../packages/cli/dist/chat-terminal.js';
import {format} from '../../packages/cli/dist/chat.js';
const names = new Map([['human', 'hjoncour'], ['codex', 'codex'], ['claude', 'claude']]);
const person = (id) => ({participantId: id, displayName: names.get(id), kind: 'agent', role: 'member', left: false, revoked: false, paused: false, muted: false});
let participants = ['codex', 'claude'].map(person);
const view = new ChatTerminal({names, participantId: 'human', format: (event, highlighted) => format(event, names, 'human', false, highlighted), complete: (line) => [[], line]});
let seq = 0;
let latest;
let queue = {mode: 'sequential', entries: []};
function post(text) {
    latest = {protocolVersion: 1, roomId: 'room', eventId: `message-${++seq}`, seq, senderId: 'human', recipientId: 'codex', replyTo: null, idempotencyKey: null, at: Date.UTC(2026, 8, 28, 12), type: 'message', payload: {text, priority: 'normal'}};
    view.addEvent(latest);
}
function readAll() {
    for (const agent of participants) {
        view.addEvent({...latest, eventId: `receipt-${++seq}`, seq, senderId: agent.participantId, type: 'message.received', payload: {eventId: latest.eventId, stage: 'read', action: 'no_action', reason: 'Nothing further to do'}});
    }
}
function sync(available = true) {
    view.setWorking(queue);
    view.setAgentActivity({participants, requests: [], queue, complete: true, available});
}
post('SHORT message');
readAll();
sync();
view.setPrompt('> ');
view.input.on('line', (line) => {
    if (!line.trim()) {
        return;
    }
    if (line === '/quit') {
        view.close();
        process.exit(0);
    }
    if (line === '/long') {
        post(Array.from({length: 100}, (_, index) => `LONG${String(index).padStart(3, '0')} content belonging to this message`).join('\n'));
        readAll();
    } else if (line === '/failure') {
        view.addEvent({...latest, eventId: `failed-${++seq}`, seq, senderId: 'codex', type: 'message.delivery_failed', payload: {eventId: latest.eventId, stage: 'execution', reason: 'Attempt interrupted'}});
        view.setRequestAlerts([{requestId: latest.eventId, text: 'ATTENTION: unresolved request'}]);
    } else if (line === '/resolve') {
        view.setRequestAlerts([]);
    } else if (line === '/unread') {
        post('NEW unread message');
    } else if (line === '/read') {
        readAll();
    } else if (line === '/busy' || line === '/waiting') {
        queue = {mode: 'sequential', entries: [{requestId: 'request', conversationId: latest.eventId, participantId: 'codex', name: 'codex', runtime: 'codex', state: line === '/busy' ? 'answering' : 'waiting', expiresAt: Date.now() + 90000, ...(line === '/busy' ? {workingAt: Date.now()} : {})}]};
    } else if (line === '/done') {
        queue = {mode: 'sequential', entries: []};
    } else if (line === '/many') {
        for (let index = 0; index < 16; index++) {
            const id = `extra-${index}`;
            names.set(id, `Reader ${String(index).padStart(2, '0')}`);
            participants.push(person(id));
        }
        post('MANY readers');
        readAll();
    }
    sync(line !== '/unknown');
});
view.input.on('SIGINT', () => { view.close(); process.exit(0); });
