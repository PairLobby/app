import {spawn} from 'node:child_process';

function pipeClipboard(command: string, args: string[], value: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true});
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Clipboard command timed out')); }, 2000);
        child.on('error', (error) => { clearTimeout(timeout); reject(error); });
        child.stdin.on('error', (error) => { clearTimeout(timeout); reject(error); });
        child.on('close', (code) => {
            clearTimeout(timeout);
            code === 0 ? resolve() : reject(new Error('Clipboard command failed'));
        });
        child.stdin.end(value, 'utf8');
    });
}

/** Values go through stdin, never through a shell or command-line interpolation. */
export async function copyToClipboard(value: string): Promise<string> {
    if (!process.env['SSH_TTY'] && !process.env['SSH_CONNECTION']) {
        const commands: [string, string[]][] = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32'
            ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())']]]
            : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
        for (const [command, args] of commands) {
            try {
                await pipeClipboard(command, args, value);
                return 'Copied';
            } catch {
                // Try the next available backend before asking the terminal itself.
            }
        }
    }
    const sequence = `\x1b]52;c;${Buffer.from(value, 'utf8').toString('base64')}\x07`;
    process.stdout.write(process.env['TMUX'] ? `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : sequence);
    return 'Copy request sent to terminal (requires clipboard support)';
}
