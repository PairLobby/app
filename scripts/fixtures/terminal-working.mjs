// Offline terminal fixture: no relay credentials, agents, or model calls.
import {ChatTerminal} from '../../packages/cli/dist/chat-terminal.js';
import {format} from '../../packages/cli/dist/chat.js';
const people = [
    ['claude-a', 'Claude reviewer', 'claude'], ['claude-b', 'Claude coder', 'claude'],
    ['codex', 'Codex builder', 'codex'], ['qwen', 'Qwen checker', 'qwen'], ['deepseek', 'DeepSeek helper', 'deepseek']
];
const names = new Map([['human', 'You'], ...people.map(([id, name]) => [id, name])]);
const view = new ChatTerminal({names, participantId: 'human', format: (event) => format(event, names, 'human'), complete: (line) => [[], line]});
view.log('PairLobby working indicators — offline visual test');
const event = {protocolVersion: 1, roomId: 'room', eventId: 'question', seq: 1, senderId: 'human', recipientId: null, recipientIds: people.map(([id]) => id), replyTo: null, idempotencyKey: null, at: Date.now(), type: 'message', payload: {text: 'Review this change together and explain your findings.', priority: 'normal'}};
view.addEvent(event);
for (const [index, [id]] of people.entries()) {
    view.addEvent({...event, eventId: `receipt-${id}`, seq: index + 2, senderId: id, type: 'message.received', payload: {eventId: 'question'}});
}
let entries = people.map(([id, name, runtime]) => ({requestId: `request-${id}`, conversationId: 'question', participantId: id, name, runtime, state: 'answering', expiresAt: Date.now() + 90_000}));
view.setWorking({mode: 'parallel', entries});
view.setTurnStatus('Turns: parallel');
view.setPrompt('> ');
const begin = setTimeout(() => {
    entries = entries.map((entry) => ({...entry, workingAt: Date.now()}));
    view.setWorking({mode: 'parallel', entries});
}, 700);
const end = setTimeout(() => { view.close(); process.exit(0); }, Number(process.env.PAIRLOBBY_TEST_WORKING_DURATION_MS ?? 120_000));
view.input.on('line', (line) => {
    if (line === '/quit') {
        clearTimeout(begin);
        clearTimeout(end);
        view.close();
        process.exit(0);
    }
    if (line === '/expire') {
        entries = entries.map((entry) => ({...entry, expiresAt: Date.now() + 350}));
        view.setWorking({mode: 'parallel', entries});
    } else if (line === '/complete') {
        entries = [];
        view.setWorking({mode: 'parallel', entries});
    } else if (line === '/working') {
        view.showWorking();
    } else {
        view.log('Input received: ' + line);
    }
});
view.input.on('SIGINT', () => { view.close(); process.exit(0); });
