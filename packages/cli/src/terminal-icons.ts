//! Whether this terminal can draw Nerd Font icons. A terminal cannot be asked which
//! font it uses, so `auto` goes by the terminal: Ghostty and WezTerm carry the Nerd
//! Font symbols themselves, and iTerm2 says in its preferences which font a profile
//! uses. Every other terminal gets emoji, which any font fallback can draw.

import {execFileSync} from 'node:child_process';

import type {Settings} from '@pairlobby/client';

export type IconSet = Exclude<Settings['icons'], 'auto'>;
export type ItermFonts = {name: string; guid: string; normal: string; nonAscii: string | null};

const BUNDLES_NERD_SYMBOLS = ['ghostty', 'WezTerm'];
const NERD_FONT = /Nerd ?Font|NF[MP]?(-|\s|$)/;

/** Every iTerm2 profile's fonts, from the text `defaults read` prints for its profile list. */
export function parseItermProfiles(printed: string): ItermFonts[] {
    return printed.split(/\n {4}\}/).map((block) => {
        const value = (key: string) => new RegExp(`\\n\\s*"?${key}"? = "?([^";\\n]*)"?;`).exec(block)?.[1] ?? '';
        return {name: value('Name'), guid: value('Guid'), normal: value('Normal Font'), nonAscii: value('Use Non-ASCII Font') === '1' ? value('Non Ascii Font') : null};
    }).filter((profile) => profile.guid);
}

function readItermProfiles(): {profiles: ItermFonts[]; defaultGuid: string} {
    try {
        const read = (key: string) => execFileSync('defaults', ['read', 'com.googlecode.iterm2', key], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000});
        return {profiles: parseItermProfiles(read('New Bookmarks')), defaultGuid: read('Default Bookmark Guid').trim()};
    } catch {
        return {profiles: [], defaultGuid: ''};
    }
}

/** The set to draw with: an explicit choice as given, otherwise what this terminal is known to support. */
export function iconSet(setting: Settings['icons'], environment: NodeJS.ProcessEnv = process.env, iterm = readItermProfiles): IconSet {
    if (setting !== 'auto') {
        return setting;
    }
    const terminal = environment['TERM_PROGRAM'] ?? '';
    if (BUNDLES_NERD_SYMBOLS.includes(terminal)) {
        return 'nerd';
    }
    if (terminal === 'iTerm.app') {
        const {profiles, defaultGuid} = iterm();
        const profile = profiles.find((candidate) => candidate.name === environment['ITERM_PROFILE']) ?? profiles.find((candidate) => candidate.guid === defaultGuid);
        if (profile && (NERD_FONT.test(profile.normal) || NERD_FONT.test(profile.nonAscii ?? ''))) {
            return 'nerd';
        }
    }
    return 'emoji';
}
