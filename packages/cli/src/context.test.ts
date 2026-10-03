import {expect, test} from 'vitest';

import {normalizeServerUrl, resolveServer} from './context.js';

test('test_a_short_relay_address_gets_http_and_the_default_port', () => {
    expect(normalizeServerUrl('h')).toBe('http://h:8790');
    expect(normalizeServerUrl('Laptop.tailnet.ts.net')).toBe('http://laptop.tailnet.ts.net:8790');
    expect(normalizeServerUrl('10.0.0.5')).toBe('http://10.0.0.5:8790');
    expect(normalizeServerUrl(' 10.0.0.5:8791 ')).toBe('http://10.0.0.5:8791');
    expect(normalizeServerUrl('10.0.0.5:80')).toBe('http://10.0.0.5:80');
    expect(normalizeServerUrl('[fd7a:115c:a1e0::1]')).toBe('http://[fd7a:115c:a1e0::1]:8790');
});

test('test_a_full_url_is_kept_as_written', () => {
    expect(normalizeServerUrl('http://10.0.0.5:8790')).toBe('http://10.0.0.5:8790');
    expect(normalizeServerUrl('https://laptop.tailnet.example')).toBe('https://laptop.tailnet.example');
    expect(normalizeServerUrl('https://pairlobby.com/relay/a/b')).toBe('https://pairlobby.com/relay/a/b');
});

test('test_a_short_address_with_more_than_host_and_port_is_refused', () => {
    expect(() => normalizeServerUrl('laptop/rooms')).toThrow('not a relay address');
    expect(() => normalizeServerUrl('user@laptop')).toThrow('not a relay address');
    expect(() => normalizeServerUrl('two words')).toThrow('not a relay address');
});

test('test_server_flags_accept_short_addresses', () => {
    expect(resolveServer({server: 'laptop'})).toBe('http://laptop:8790');
    expect(resolveServer({local: true})).toBe('http://127.0.0.1:8790');
    expect(() => resolveServer({server: 'laptop', local: true})).toThrow('either --server or --local');
});
