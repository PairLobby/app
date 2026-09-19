import type {HandoverDocument} from '@pairlobby/protocol';

export function sampleHandover(overrides: Partial<HandoverDocument['metadata']> = {}): HandoverDocument {
    return {
        metadata: {
            goal: 'Finish the invite redemption recovery tests',
            recipient: 'codex',
            mode: 'sequential',
            nextAction: 'Run the crash-injection suite and fix the two failing recovery cases',
            decisions: ['Invite binding happens before membership so a crash leaves a resumable reservation'],
            blockers: [],
            repository: {
                branch: 'feature/room-core',
                commit: '9f2c1ab',
                dirty: true,
                missingPaths: ['packages/room-core/src/scratch.ts'],
                worktreePath: '/Users/dev/Projects/PairLobby'
            },
            tests: {command: 'npm test', result: 'failed', notes: '2 of 41 failing in invite recovery'},
            ...overrides
        },
        body: 'Redemption reserves the invite before membership exists. The two failing cases both assume the reservation is cleared on crash, which it is not.'
    };
}
