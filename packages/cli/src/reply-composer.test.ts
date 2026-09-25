import {expect, test} from 'vitest';
import {ReplyComposer, quotePreview} from './reply-composer.js';

const first = {eventId: 'ev_first', senderId: 'pt_agent', text: 'First message'};
const second = {...first, eventId: 'ev_second', text: 'Second message'};
const third = {...first, eventId: 'ev_third', text: 'Third message'};

test('navigation selects stable message IDs, bounds the cursor, and waits for confirmation', () => {
    const composer = new ReplyComposer();
    composer.sync('/reply', [first, second]);
    expect(composer.target).toEqual(second);
    expect(composer.picking).toBe(true);
    composer.move(-1, [first, second]);
    composer.move(-1, [first, second]);
    expect(composer.target).toEqual(first);
    composer.sync('/reply', [first, second, third]);
    expect(composer.target).toEqual(first);
    composer.move(1, [first, second, third]);
    expect(composer.choose()).toBe(true);
    composer.sync('/reply My answer', [first, second, third]);
    expect(composer.submit('/reply My answer')).toEqual({target: second, text: 'My answer'});
    expect(composer.active).toBe(false);
});

test('deleting or editing the command clears its quote and cannot submit a stale target', () => {
    const composer = new ReplyComposer();
    composer.sync('/reply', [first]);
    composer.choose();
    composer.sync('My answer', [first]);
    expect(composer.target).toBeUndefined();
    expect(composer.submit('My answer')).toBeUndefined();
    composer.sync('/replying', [first]);
    expect(composer.active).toBe(false);
    composer.sync('/reply', []);
    expect(composer.choose()).toBe(false);
    expect(composer.submit('/reply')).toBeUndefined();
});

test('an explicit ID selects its own text and edits never keep the previous explicit quote', () => {
    const composer = new ReplyComposer();
    composer.sync('/reply ev_first answer', [first, second]);
    expect(composer.target).toEqual(first);
    expect(composer.submit('/reply ev_first answer')).toEqual({target: first, text: 'answer'});
    composer.sync('/reply ev_missing answer', [first]);
    expect(composer.target).toBeUndefined();
    expect(composer.picking).toBe(false);
    composer.sync('/reply', [first]);
    expect(composer.picking).toBe(true);
});

test('a selected target survives new arrivals and UI retention while a failed draft can be restored', () => {
    const composer = new ReplyComposer();
    composer.sync('/reply', [first]);
    composer.choose();
    composer.sync('/reply draft', [second, third]);
    expect(composer.target).toEqual(first);
    const submission = composer.submit('/reply draft')!;
    composer.restore(submission);
    expect(composer.target).toEqual(first);
    expect(composer.answer('/reply draft')).toBe('draft');
});

test('quote previews are short, single-line and do not execute terminal escape sequences', () => {
    const preview = quotePreview({...first, text: 'hello\u001b[2J\nworld ' + 'x'.repeat(200)}, new Map([['pt_agent', 'Claude']]));
    expect(preview).toContain('> Claude: hello world');
    expect(preview).not.toMatch(/[\u001b\n]/u);
    expect(preview).toHaveLength('> Claude: '.length + 161);
});
