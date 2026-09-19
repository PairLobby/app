// Real terminal renderer fixture; no relay, credentials, or model requests.
import {ChatTerminal} from '../../packages/cli/dist/chat-terminal.js';
import {format} from '../../packages/cli/dist/chat.js';
const names = new Map([['pt_human', 'hjoncour'], ['pt_codex', 'codex'], ['pt_claude', 'claude']]);
const view = new ChatTerminal({names, participantId: 'pt_human', format: (event) => format(event, names, 'pt_human'), complete: (line) => [[], line]});
view.setPrompt('> ');
view.setHint('Hover Seen or press F2. Escape dismisses details.');
view.log('PairLobby receipt layout test');
const event = {protocolVersion: 1, roomId: 'rm_test', eventId: 'ev_test', seq: 1, senderId: 'pt_human', recipientId: 'pt_codex', replyTo: null, idempotencyKey: null, at: Date.UTC(2026, 8, 19, 21, 42), type: 'message', payload: {text: 'hey @codex', priority: 'normal'}};
view.addEvent(event);
view.addEvent({...event, eventId: 'ev_long', seq: 2, senderId: 'pt_claude', recipientId: null, payload: {text: 'A longer message wraps while leaving room for the receipt column. Hello 👋 — keeping the original conversation readable across terminal sizes.', priority: 'normal'}});
const timer = setTimeout(() => view.addEvent({...event, eventId: 'ev_ack', seq: 3, senderId: 'pt_codex', at: event.at + 3000, type: 'message.received', payload: {eventId: event.eventId}}), 1200);
view.input.on('line', (line) => {
    if (line === '/quit') {
        clearTimeout(timer);
        view.close();
        process.exit(0);
    }
    if (line === '/fill') {
        for (let index = 0; index < 40; index++) {
            view.log(`History row ${index}`);
        }
    } else if (line === '/seen') {
        view.showLatestReceipt();
    } else {
        view.log('Input received: ' + line);
    }
});
view.input.on('SIGINT', () => { view.close(); process.exit(0); });
