//! The blessed program shared by every full-screen view, with the terminal it should assume.

import blessed from 'blessed';

type TerminalProgramOptions = {extended: boolean; debug: boolean; terminal?: string};

/**
 * Windows consoles leave TERM unset, and blessed then assumes `windows-ansi`:
 * eight colors, so gray text is drawn black, and no mouse reporting, so hover
 * and click never arrive. The Windows 10+ console and Windows Terminal speak
 * the xterm sequences, so they get the same profile as macOS and Linux.
 */
export function terminalName(platform: string, term: string | undefined): string | undefined {
    return platform === 'win32' && !term ? 'xterm-256color' : undefined;
}

export function createTerminalProgram(): blessed.BlessedProgram {
    // Blessed's legacy compiler cannot parse some modern extended capabilities
    // (e.g. Setulc). Standard terminfo supplies all capabilities used by this UI.
    const options: TerminalProgramOptions = {extended: false, debug: false};
    const terminal = terminalName(process.platform, process.env.TERM);
    if (terminal) {
        options.terminal = terminal;
    }
    return blessed.program(options);
}
