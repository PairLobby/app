import {expect, test} from 'vitest';

import {iconSet, parseItermProfiles} from './terminal-icons.js';

const PRINTED = `(
        {
        "Ansi 0 Color" =         {
            "Blue Component" = 0;
        };
        Guid = "38C06AF7-0930-4E5A-8E6E-0E0D857A9212";
        Name = Default;
        "Non Ascii Font" = "JetBrainsMonoNLNFM-Regular 12";
        "Normal Font" = "Monaco 12";
        "Use Non-ASCII Font" = 0;
    },
        {
        Guid = "AAAA";
        Name = "Work Nerd";
        "Normal Font" = "JetBrainsMonoNerdFontMono-Regular 13";
        "Use Non-ASCII Font" = 0;
    }
)`;

test('test_iterm_profiles_are_read_with_their_fonts', () => {
    expect(parseItermProfiles(PRINTED)).toEqual([
        {name: 'Default', guid: '38C06AF7-0930-4E5A-8E6E-0E0D857A9212', normal: 'Monaco 12', nonAscii: null},
        {name: 'Work Nerd', guid: 'AAAA', normal: 'JetBrainsMonoNerdFontMono-Regular 13', nonAscii: null},
    ]);
});

test('test_auto_draws_icons_only_where_the_terminal_has_the_glyphs', () => {
    const iterm = () => ({profiles: parseItermProfiles(PRINTED), defaultGuid: '38C06AF7-0930-4E5A-8E6E-0E0D857A9212'});
    expect(iconSet('auto', {TERM_PROGRAM: 'ghostty'}, iterm)).toBe('nerd');
    expect(iconSet('auto', {TERM_PROGRAM: 'WezTerm'}, iterm)).toBe('nerd');
    expect(iconSet('auto', {TERM_PROGRAM: 'Apple_Terminal'}, iterm)).toBe('emoji');
    expect(iconSet('auto', {}, iterm)).toBe('emoji');
    // A non-ASCII font only counts when the profile uses it.
    expect(iconSet('auto', {TERM_PROGRAM: 'iTerm.app'}, iterm)).toBe('emoji');
    expect(iconSet('auto', {TERM_PROGRAM: 'iTerm.app'}, () => ({profiles: parseItermProfiles(PRINTED.replace('"Use Non-ASCII Font" = 0', '"Use Non-ASCII Font" = 1')), defaultGuid: '38C06AF7-0930-4E5A-8E6E-0E0D857A9212'}))).toBe('nerd');
    expect(iconSet('auto', {TERM_PROGRAM: 'iTerm.app', ITERM_PROFILE: 'Work Nerd'}, iterm)).toBe('nerd');
    expect(iconSet('symbols', {TERM_PROGRAM: 'ghostty'}, iterm)).toBe('symbols');
    expect(iconSet('nerd', {}, iterm)).toBe('nerd');
});
