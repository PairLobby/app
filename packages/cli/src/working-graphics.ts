import logos from './working-logos.json' with {type: 'json'};
import type {LogoProvider} from './working-view.js';

export type GraphicsMode = 'cells' | 'iterm2' | 'kitty';
export type LogoPlacement = {provider: LogoProvider; row: number; column: number};
type LogoFrame = {png: string; cells: string};

export function graphicsMode(environment: NodeJS.ProcessEnv = process.env): GraphicsMode {
    const override = environment['PAIRLOBBY_GRAPHICS'];
    if (override === 'cells' || override === 'iterm2' || override === 'kitty') {
        return override;
    }
    if (environment['TMUX'] || environment['STY']) {
        return 'cells';
    }
    if (environment['TERM_PROGRAM'] === 'iTerm.app') {
        return 'iterm2';
    }
    if (environment['TERM_PROGRAM'] === 'ghostty' || environment['KITTY_WINDOW_ID']) {
        return 'kitty';
    }
    return 'cells';
}

export function logoFrame(provider: LogoProvider, frame: number): LogoFrame | undefined {
    if (provider === 'other') {
        return undefined;
    }
    const frames = logos.providers[provider].frames;
    return frames[frame % frames.length];
}

export function logoColor(provider: LogoProvider): string {
    return provider === 'other' ? 'cyan' : logos.providers[provider].color;
}

export const LOGO_FRAME_MS = logos.frameMs;
const IMAGE_IDS: Record<LogoProvider, number> = {claude: 5262337, openai: 5262338, qwen: 5262339, deepseek: 5262340, other: 5262341};

/** Only delete images owned by this view. Never clear another application's images. */
export function clearWorkingGraphics(mode: GraphicsMode, placements: LogoPlacement[]): string {
    if (mode === 'cells' || !placements.length) {
        return '';
    }
    let sequence = '\u001b7';
    for (const placement of placements) {
        if (mode === 'kitty') {
            sequence += `\u001b_Ga=d,d=I,i=${IMAGE_IDS[placement.provider]},q=2;\u001b\\`;
        } else {
            for (let y = 0; y < 3; y++) {
                sequence += `\u001b[${placement.row + y + 1};${placement.column + 1}H\u001b[6X`;
            }
        }
    }
    return sequence + '\u001b8';
}

export function drawWorkingGraphics(mode: GraphicsMode, placements: LogoPlacement[], frame: number): string {
    if (mode === 'cells' || !placements.length) {
        return '';
    }
    let sequence = '\u001b7';
    for (const placement of placements) {
        const image = logoFrame(placement.provider, frame);
        if (!image) {
            continue;
        }
        sequence += `\u001b[${placement.row + 1};${placement.column + 1}H`;
        if (mode === 'iterm2') {
            sequence += `\u001b]1337;File=inline=1;width=6;height=3;preserveAspectRatio=1:${image.png}\u0007`;
        } else {
            sequence += `\u001b_Ga=d,d=I,i=${IMAGE_IDS[placement.provider]},q=2;\u001b\\`;
            for (let offset = 0; offset < image.png.length; offset += 4096) {
                const more = offset + 4096 < image.png.length ? 1 : 0;
                const control = offset === 0 ? `a=T,f=100,t=d,i=${IMAGE_IDS[placement.provider]},c=6,r=3,C=1,q=2,m=${more}` : `m=${more},q=2`;
                sequence += `\u001b_G${control};${image.png.slice(offset, offset + 4096)}\u001b\\`;
            }
        }
    }
    return sequence + '\u001b8';
}
