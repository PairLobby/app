import {createRequire} from 'node:module';

import {describe, expect, test} from 'vitest';

import {advertiseRelay, browseRelays, isLocalNetworkAddress, isLoopbackAddress, isTailscaleAddress, ownAddresses} from './network.js';

describe('relay network', () => {
    test('test_tailscale_addresses_are_the_cgnat_range_and_its_ipv6_prefix', () => {
        expect(isTailscaleAddress('100.64.0.0')).toBe(true);
        expect(isTailscaleAddress('100.127.255.255')).toBe(true);
        expect(isTailscaleAddress('::ffff:100.100.1.1')).toBe(true);
        expect(isTailscaleAddress('FD7A:115C:A1E0::53')).toBe(true);
        expect(isTailscaleAddress('100.63.255.255')).toBe(false);
        expect(isTailscaleAddress('100.128.0.0')).toBe(false);
        expect(isTailscaleAddress('10.0.0.1')).toBe(false);
    });

    test('test_local_network_addresses_are_private_link_local_tailscale_or_this_device', () => {
        for (const address of ['127.0.0.1', '::1', '10.0.0.240', '172.16.0.1', '172.31.255.254', '192.168.1.20', '::ffff:192.168.1.20', '169.254.10.1', '100.125.214.0', 'fd00::1', 'fe80::1']) {
            expect(isLocalNetworkAddress(address)).toBe(true);
        }
        for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.128.0.1', '2001:4860::8888', '']) {
            expect(isLocalNetworkAddress(address)).toBe(false);
        }
    });

    test('test_loopback_addresses', () => {
        expect(isLoopbackAddress('127.0.0.1')).toBe(true);
        expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
        expect(isLoopbackAddress('::1')).toBe(true);
        expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    });

    // Real multicast on this machine's interfaces. CI runners rarely route it, and macOS
    // refuses it (EHOSTUNREACH) to an app without the Local Network permission.
    test.skipIf(Boolean(process.env['CI']) || ownAddresses().filter((address) => !isTailscaleAddress(address)).length === 0)('test_an_advertised_relay_is_found_by_browsing', async (context) => {
        if (!(await multicastAllowed())) {
            context.skip();
        }
        const stop = advertiseRelay(48_790);
        try {
            const found = await browseRelays(1500);
            expect(found.some((url) => url.endsWith(':48790'))).toBe(true);
        } finally {
            stop();
        }
    });
});

type MdnsFactory = (options?: object) => {query: (packet: object, callback: (error: Error | null) => void) => void; destroy: () => void};

function multicastAllowed(): Promise<boolean> {
    const mdns = (createRequire(import.meta.url)('multicast-dns') as MdnsFactory)();
    return new Promise((resolve) => {
        mdns.query({questions: [{name: '_pairlobby._tcp.local', type: 'PTR'}]}, (error) => {
            mdns.destroy();
            resolve(error === null || error === undefined);
        });
    });
}
