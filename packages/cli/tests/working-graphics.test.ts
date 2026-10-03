import {expect, test} from 'vitest';

import {LOGO_FRAME_MS, drawWorkingGraphics, logoAnimation, logoFrame} from '../src/working-graphics.js';

const providers = ['claude', 'openai', 'qwen', 'deepseek'] as const;

test.each(providers)('test_%s_has_a_looping_animated_gif_built_from_its_frames', (provider) => {
    const gif = Buffer.from(logoAnimation(provider)!, 'base64');
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    // NETSCAPE2.0 application extension with loop count 0 means "loop forever".
    const loop = gif.indexOf('NETSCAPE2.0', 0, 'latin1');
    expect(loop).toBeGreaterThan(0);
    expect(gif.readUInt16LE(loop + 13)).toBe(0);
    // One graphic control block per frame; together their delays keep the PNG loop's length.
    let delay = 0, frames = 0;
    for (let index = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04])); index >= 0; index = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04]), index + 1)) {
        frames++;
        delay += gif.readUInt16LE(index + 4) * 10;
        // Disposal 2 (restore to background) so frames never smear into each other.
        expect((gif[index + 3]! >> 2) & 0b111).toBe(2);
    }
    expect(frames).toBe(30);
    expect(Math.abs(delay - LOGO_FRAME_MS * 30)).toBeLessThan(10);
});

test('test_iterm2_draws_the_animation_once_and_kitty_keeps_frames', () => {
    const placements = [{provider: 'claude' as const, row: 19, column: 0}];
    const iterm = drawWorkingGraphics('iterm2', placements, 7);
    expect(iterm).toContain(`1337;File=inline=1;width=6;height=3;preserveAspectRatio=1:${logoAnimation('claude')}`);
    expect(iterm).not.toContain(logoFrame('claude', 7)!.png);
    expect(drawWorkingGraphics('kitty', placements, 7)).toContain(logoFrame('claude', 7)!.png.slice(0, 64));
    expect(logoAnimation('other')).toBeUndefined();
});
