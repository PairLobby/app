import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, test} from 'vitest';

import {parseBackupLocation, parsePublicUrl, relaySettings} from '../src/settings.js';

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
            roomLimits: {},
            requestLog: 'writes'
        });
    });

    test('test_a_flag_wins_over_its_variable_and_empty_variables_count_as_unset', () => {
        const settings = relaySettings({port: '9000', requestLog: 'off'}, {PAIRLOBBY_PORT: '8080', PAIRLOBBY_REQUEST_LOG: 'all', PAIRLOBBY_HOST: '', PAIRLOBBY_CREATE_TOKEN: ''});
        expect(settings).toEqual({port: 9000, allowedHosts: [], limits: {}, roomLimits: {}});
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

    test('test_room_caps_come_from_the_environment_in_whole_units_and_out_of_range_values_are_refused', () => {
        const settings = relaySettings({}, {
            PAIRLOBBY_ROOM_MAX_PARTICIPANTS: '40',
            PAIRLOBBY_ROOM_MAX_EVENTS: '50000',
            PAIRLOBBY_ROOM_MAX_HISTORY_MB: '64',
            PAIRLOBBY_ROOM_MAX_MESSAGE_KB: '64',
            PAIRLOBBY_ROOM_MAX_FILE_MB: '0',
            PAIRLOBBY_ROOM_MAX_FILES_MB: '2048'
        });
        expect(settings.roomLimits).toEqual({maxParticipants: 40, maxRetainedEvents: 50_000, maxRetainedEventBytes: 64 * 1024 * 1024, maxEventPayloadBytes: 64 * 1024, maxFileBytes: 0, maxRetainedFileBytes: 2048 * 1024 * 1024});
        expect(() => relaySettings({}, {PAIRLOBBY_ROOM_MAX_PARTICIPANTS: '1'})).toThrow('PAIRLOBBY_ROOM_MAX_PARTICIPANTS must be a whole number from 2 to 1000, not "1"');
        expect(() => relaySettings({}, {PAIRLOBBY_ROOM_MAX_FILE_MB: '96'})).toThrow('PAIRLOBBY_ROOM_MAX_FILE_MB must be a whole number from 0 to 95');
        expect(() => relaySettings({}, {PAIRLOBBY_ROOM_MAX_HISTORY_MB: '1.5'})).toThrow('PAIRLOBBY_ROOM_MAX_HISTORY_MB must be a whole number');
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

    test('test_backups_need_a_place_and_take_their_rhythm_from_the_environment', () => {
        expect(relaySettings({}, {PAIRLOBBY_BACKUP: 's3://team-relay/pairlobby'}).backup).toEqual({location: {kind: 's3', bucket: 'team-relay', prefix: 'pairlobby/'}, intervalMs: 60_000, keep: 48, restore: true});
        expect(relaySettings({backup: '/srv/copies', noRestore: true}, {PAIRLOBBY_BACKUP: 's3://ignored', PAIRLOBBY_BACKUP_INTERVAL: '300', PAIRLOBBY_BACKUP_KEEP: '12'}).backup).toEqual({location: {kind: 'folder', path: '/srv/copies'}, intervalMs: 300_000, keep: 12, restore: false});
        expect(() => relaySettings({}, {PAIRLOBBY_BACKUP: 'relative/dir'})).toThrow('--backup (PAIRLOBBY_BACKUP) must be s3://bucket/prefix or an absolute folder path');
        expect(relaySettings({}, {PAIRLOBBY_BACKUP: '/srv/copies', PAIRLOBBY_NO_RESTORE: '1'}).backup?.restore).toBe(false);
        expect(relaySettings({}, {}).backup).toBeUndefined();
        expect(() => relaySettings({}, {PAIRLOBBY_BACKUP_INTERVAL: '60'})).toThrow('need a place to back up to');
        expect(() => relaySettings({}, {PAIRLOBBY_BACKUP: '/srv/copies', PAIRLOBBY_BACKUP_INTERVAL: '5'})).toThrow('PAIRLOBBY_BACKUP_INTERVAL must be a whole number from 10 to 86400');
        expect(() => relaySettings({}, {PAIRLOBBY_BACKUP: '/srv/copies', PAIRLOBBY_BACKUP_S3_ENDPOINT: 'r2.example.com'})).toThrow('must be an http(s) origin');
        expect(() => relaySettings({}, {PAIRLOBBY_BACKUP: '/srv/copies', PAIRLOBBY_NO_RESTORE: 'yes'})).toThrow('must be 1 or 0');
    });

    test('test_s3_urls_and_absolute_folders_are_accepted_and_nothing_else', () => {
        expect(parseBackupLocation('s3://team-relay/pairlobby/prod/')).toEqual({kind: 's3', bucket: 'team-relay', prefix: 'pairlobby/prod/'});
        expect(parseBackupLocation('s3://team-relay')).toEqual({kind: 's3', bucket: 'team-relay', prefix: ''});
        expect(parseBackupLocation('/var/backups/pairlobby')).toEqual({kind: 'folder', path: '/var/backups/pairlobby'});
        expect(parseBackupLocation('file:///var/backups/pair%20lobby')).toEqual({kind: 'folder', path: '/var/backups/pair lobby'});
        expect(parseBackupLocation('backups')).toBeNull();
        expect(parseBackupLocation('s3://Team_Relay/x')).toBeNull();
        expect(parseBackupLocation('https://bucket.s3.amazonaws.com')).toBeNull();
    });
});
