import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, test} from 'vitest';

import {parsePublicUrl, relaySettings} from './relay-settings.js';

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-relay-settings-'));

afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
});

describe('relay settings', () => {
    test('test_a_container_configures_every_setting_through_the_environment', () => {
        const settings = relaySettings({}, {
            PAIRLOBBY_HOST: '0.0.0.0',
            PAIRLOBBY_PORT: '8080',
            PAIRLOBBY_PUBLIC_URL: 'https://team.example.com/',
            PAIRLOBBY_TRUSTED_PROXY_HEADER: 'X-Forwarded-For',
            PAIRLOBBY_ALLOWED_HOSTS: 'relay.internal, relay.internal:8080',
            PAIRLOBBY_CREATE_TOKEN: 'team-secret',
            PAIRLOBBY_REQUEST_LOG: 'writes',
            PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP: '5',
            PAIRLOBBY_LIMIT_REDEEM_PER_MIN_IP: '30',
            PAIRLOBBY_LIMIT_REDEEM_PER_MIN_GLOBAL: '600'
        });
        expect(settings).toEqual({
            host: '0.0.0.0',
            port: 8080,
            publicUrl: 'https://team.example.com',
            trustedProxyHeader: 'x-forwarded-for',
            createToken: 'team-secret',
            allowedHosts: ['relay.internal', 'relay.internal:8080'],
            limits: {createPerMinutePerAddress: 5, redeemPerMinutePerAddress: 30, redeemPerMinuteGlobal: 600},
            requestLog: 'writes'
        });
    });

    test('test_a_flag_wins_over_its_variable_and_empty_variables_count_as_unset', () => {
        const settings = relaySettings({port: '9000', requestLog: 'off'}, {PAIRLOBBY_PORT: '8080', PAIRLOBBY_REQUEST_LOG: 'all', PAIRLOBBY_HOST: '', PAIRLOBBY_CREATE_TOKEN: ''});
        expect(settings).toEqual({port: 9000, allowedHosts: [], limits: {}});
    });

    test('test_bad_values_name_the_flag_or_variable_that_holds_them', () => {
        expect(relaySettings({port: '0'}, {}).port).toBe(0);
        expect(() => relaySettings({}, {PAIRLOBBY_PORT: '70000'})).toThrow('--port (PAIRLOBBY_PORT) must be a whole number from 0 to 65535');
        expect(() => relaySettings({}, {PAIRLOBBY_PUBLIC_URL: 'team.example.com'})).toThrow('--public-url (PAIRLOBBY_PUBLIC_URL) must be a full address');
        expect(() => relaySettings({}, {PAIRLOBBY_TRUSTED_PROXY_HEADER: 'x forwarded'})).toThrow('must be a header name');
        expect(() => relaySettings({}, {PAIRLOBBY_ALLOWED_HOSTS: 'https://relay.internal'})).toThrow('PAIRLOBBY_ALLOWED_HOSTS takes Host values');
        expect(() => relaySettings({}, {PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP: '0'})).toThrow('PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP must be a whole number');
        expect(() => relaySettings({requestLog: 'verbose'}, {})).toThrow('must be all, writes or off');
        expect(() => parsePublicUrl('https://team.example.com/path')).toThrow('no path');
    });

    test('test_the_create_token_file_must_be_private_and_not_combined_with_the_variable', () => {
        const file = join(directory, 'create-token');
        writeFileSync(file, 'from-a-file\n');
        chmodSync(file, 0o600);
        expect(relaySettings({}, {PAIRLOBBY_CREATE_TOKEN_FILE: file}).createToken).toBe('from-a-file');
        expect(() => relaySettings({}, {PAIRLOBBY_CREATE_TOKEN_FILE: file, PAIRLOBBY_CREATE_TOKEN: 'inline'})).toThrow('not both');
        expect(() => relaySettings({}, {PAIRLOBBY_CREATE_TOKEN_FILE: join(directory, 'missing')})).toThrow('cannot be read');
        if (process.platform !== 'win32') {
            chmodSync(file, 0o644);
            expect(() => relaySettings({}, {PAIRLOBBY_CREATE_TOKEN_FILE: file})).toThrow('chmod 600');
        }
        const empty = join(directory, 'empty-token');
        writeFileSync(empty, '\n');
        chmodSync(empty, 0o600);
        expect(() => relaySettings({}, {PAIRLOBBY_CREATE_TOKEN_FILE: empty})).toThrow('is empty');
    });
});
