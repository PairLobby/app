// Isolated terminal table fixture: copying writes to a test file, never the user's clipboard.
import blessed from 'blessed';
import {appendFileSync} from 'node:fs';
import {AgentTable} from '../../packages/cli/dist/agent-table.js';
const screen = blessed.screen({program: blessed.program({extended: false, debug: false}), smartCSR: true, fullUnicode: true, warnings: false});
blessed.box({parent: screen, content: 'Background composer: draft stays here', top: 0, left: 0, width: '100%', height: 1});
let rows = Array.from({length: 25}, (_, index) => ({
    participantId: `pt_fixture_${index}`, name: index === 0 ? 'reviewer-with-a-very-long-display-name' : `agent-${index}`, provider: 'OpenAI', status: 'Ready',
    model: 'a-very-long-model-name-with-Ω-and-extra-details', configuredModel: true, conversationId: `conversation-${index}-` + 'x'.repeat(45), invite: 'ABCD-1234', origin: 'This session', lastMessage: '2026-09-27T21:23:45.000Z'
}));
const roster = () => ({rows, at: 1790544225000, notes: ['Model * = configured only.', 'Dates UTC; full values are copied.']});
const table = new AgentTable({screen, close: () => screen.render(), copy: async value => { appendFileSync(process.env.PAIRLOBBY_TEST_COPY, JSON.stringify(value) + '\n'); return 'Copied'; }, refresh: async () => { rows = rows.map(row => ({...row, status: 'Refreshed'})); return roster(); }});
screen.on('keypress', (_, key) => {
    if (table.visible) {
        table.key(key);
    } else if (key.name === 'q') {
        screen.destroy();
        process.exit(0);
    } else if (key.name === 'a') {
        table.show(roster());
    }
});
screen.on('resize', () => table.render());
screen.program.enableMouse();
table.show(roster());
