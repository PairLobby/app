import type blessed from 'blessed';
import {stripVTControlCharacters} from 'node:util';

type PopupBounds = {columns: number; rows: number; measure: (text: string) => number};
export type PopupLayout = {width: number; height: number; content: string; scrollable: boolean};
const graphemes = new Intl.Segmenter();

function wrapLine(line: string, width: number, measure: (text: string) => number): string[] {
    const result: string[] = [];
    let current = '';
    for (const {segment} of graphemes.segment(line)) {
        if (current && measure(current + segment) > width) {
            result.push(current);
            current = '';
        }
        current += measure(segment) > width ? '…' : segment;
    }
    result.push(current);
    return result;
}

/** Border + one cell of horizontal padding; no unused minimum-width gutter. */
export function popupLayout(lines: string[], bounds: PopupBounds): PopupLayout {
    const clean = lines.flatMap((line) => stripVTControlCharacters(line).replace(/\r/g, '').split('\n'));
    const maxWidth = Math.max(1, Math.min(64, bounds.columns - 2));
    const maxHeight = Math.max(1, Math.min(12, Math.floor(bounds.rows / 2), bounds.rows - 3));
    let width = Math.min(maxWidth, Math.max(0, ...clean.map(bounds.measure)) + 4);
    let wrapped = clean.flatMap((line) => wrapLine(line, Math.max(1, width - 4), bounds.measure));
    const scrollable = wrapped.length + 2 > maxHeight;
    if (scrollable) {
        clean[0] = `${clean[0] ?? 'Details'} (scroll)`;
        width = Math.min(maxWidth, Math.max(...clean.map(bounds.measure)) + 4);
        wrapped = clean.flatMap((line) => wrapLine(line, Math.max(1, width - 4), bounds.measure));
    }
    return {width, height: Math.min(maxHeight, wrapped.length + 2), content: wrapped.join('\n'), scrollable};
}

export function fitPopup(popup: blessed.Widgets.BoxElement, lines: string[], screen: blessed.Widgets.Screen): void {
    applyPopupLayout(popup, popupLayout(lines, {columns: Number(screen.width), rows: Number(screen.height), measure: (text) => Number(popup.strWidth(text))}));
}

export function applyPopupLayout(popup: blessed.Widgets.BoxElement, layout: PopupLayout): void {
    popup.width = layout.width;
    popup.height = layout.height;
    if (popup.content !== layout.content) {
        popup.setContent(layout.content);
    }
}

/** Keep the label on its message's visible fragment, never on an adjacent message. */
export function visibleMessageRow(top: number, height: number, scroll: number, viewport: number): number | null {
    const bottom = top + height - 1;
    const last = scroll + viewport - 1;
    if (viewport < 1 || bottom < scroll || top > last) {
        return null;
    }
    if (top >= scroll) {
        return top;
    }
    if (bottom <= last) {
        return bottom;
    }
    return scroll + Math.floor((viewport - 1) / 2);
}
