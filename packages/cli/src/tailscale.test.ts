import {expect, test} from 'vitest';

import {parseTailscaleStatus, tailscaleNames} from './tailscale.js';

const STATUS = {
    BackendState: 'Running',
    Self: {HostName: 'H-Mac-Mini', DNSName: 'h.tail0ac1ca.ts.net.', TailscaleIPs: ['100.111.208.123', 'fd7a:115c:a1e0::ad01:d0b0'], Online: true, OS: 'macOS'},
    Peer: {
        'nodekey:a': {HostName: 'DESKTOP-HJONCOUR', DNSName: 'desktop-hjoncour.tail0ac1ca.ts.net.', TailscaleIPs: ['100.125.214.0'], Online: true, OS: 'windows'},
        'nodekey:b': {HostName: 'localhost', DNSName: 'iphone-15-pro-max.tail0ac1ca.ts.net.', TailscaleIPs: ['100.119.62.36'], Online: false, OS: 'iOS'},
    },
};

test('test_tailscale_status_names_this_device_and_its_peers', () => {
    const view = parseTailscaleStatus(JSON.stringify(STATUS))!;
    expect(view.self).toEqual({name: 'h', dnsName: 'h.tail0ac1ca.ts.net', addresses: ['100.111.208.123', 'fd7a:115c:a1e0::ad01:d0b0'], online: true, os: 'macOS'});
    expect(view.peers.map((peer) => [peer.name, peer.online])).toEqual([['desktop-hjoncour', true], ['iphone-15-pro-max', false]]);
    expect(tailscaleNames(view)).toEqual(['h.tail0ac1ca.ts.net', 'h']);
});

test('test_stopped_or_unreadable_tailscale_is_absent', () => {
    expect(parseTailscaleStatus(JSON.stringify({...STATUS, BackendState: 'Stopped'}))).toBeNull();
    expect(parseTailscaleStatus(JSON.stringify({BackendState: 'NeedsLogin'}))).toBeNull();
    expect(parseTailscaleStatus('not json')).toBeNull();
    expect(tailscaleNames(null)).toEqual([]);
});
