import {expect, test} from 'vitest';

import {ACCOUNT_SETTING_DEFINITIONS, ACCOUNT_SETTING_FIELDS, AccountSettingsError, linkedAccountSettings, parseAccountSettingChanges, parseAccountSettingsDocument, validAutoCloseSetting} from '../src/account-settings.js';

test('test_auto_close_settings_take_only_the_forms_the_cli_writes', () => {
    for (const value of ['off', 'agents-and-guests-left', 'idle:1h', 'age:7d', 'idle:90m', 'idle:60s']) {
        expect(validAutoCloseSetting(value)).toBe(true);
    }
    for (const value of ['idle:30s', 'idle:0m', 'idle:1x', 'idle:2 hours', 'Off', 'age:', 'never']) {
        expect(validAutoCloseSetting(value)).toBe(false);
    }
});

test('test_changes_are_checked_as_a_batch', () => {
    expect(parseAccountSettingChanges({changes: [{field: 'showIds', value: true, updatedAt: 5}]})).toEqual([{field: 'showIds', value: true, updatedAt: 5}]);
    expect(() => parseAccountSettingChanges({changes: [{field: 'relayNetwork', value: 'lan', updatedAt: 5}]})).toThrow(/not a synced setting/);
    expect(() => parseAccountSettingChanges({changes: [{field: 'showIds', value: 'yes', updatedAt: 5}]})).toThrow(AccountSettingsError);
    expect(() => parseAccountSettingChanges({changes: [{field: 'showIds', value: true, updatedAt: 5}, {field: 'showIds', value: false, updatedAt: 6}]})).toThrow(/twice/);
    expect(() => parseAccountSettingChanges({changes: []})).toThrow(AccountSettingsError);
    expect(() => parseAccountSettingChanges({changes: [{field: 'displayName', value: ' padded', updatedAt: 5}]})).toThrow(/displayName/);
    expect(parseAccountSettingChanges({changes: [{field: 'displayName', value: null, updatedAt: 5}]})[0]!.value).toBeNull();
});

test('test_managed_limits_travel_together_and_stay_consistent', () => {
    expect(linkedAccountSettings('managedTaskIdleMs')).toEqual(['managedTaskIdleMs', 'managedTaskTimeoutMs']);
    expect(linkedAccountSettings('showIds')).toEqual(['showIds']);
    expect(() => parseAccountSettingChanges({changes: [{field: 'managedTaskIdleMs', value: 60_000, updatedAt: 5}]})).toThrow(/change together/);
    expect(() => parseAccountSettingChanges({changes: [{field: 'managedTaskIdleMs', value: 60_000, updatedAt: 5}, {field: 'managedTaskTimeoutMs', value: 120_000, updatedAt: 6}]})).toThrow(/one time/);
    expect(() => parseAccountSettingChanges({changes: [{field: 'managedTaskIdleMs', value: 120_000, updatedAt: 5}, {field: 'managedTaskTimeoutMs', value: 60_000, updatedAt: 5}]})).toThrow(/at least/);
    expect(parseAccountSettingChanges({changes: [{field: 'managedTaskIdleMs', value: 60_000, updatedAt: 5}, {field: 'managedTaskTimeoutMs', value: 60_000, updatedAt: 5}]})).toHaveLength(2);
});

test('test_a_document_keeps_only_settings_this_version_can_read', () => {
    const document = parseAccountSettingsDocument({serverTime: 10, settings: {showIds: {value: true, updatedAt: 3}, futureSetting: {value: 1, updatedAt: 3}, confirmDelete: {value: 'maybe', updatedAt: 3}}});
    expect(document).toEqual({serverTime: 10, settings: {showIds: {value: true, updatedAt: 3}}});
    expect(() => parseAccountSettingsDocument({settings: {}})).toThrow(AccountSettingsError);
});

test('test_every_synced_setting_has_one_definition', () => {
    expect(ACCOUNT_SETTING_DEFINITIONS.map((definition) => definition.field).sort()).toEqual([...ACCOUNT_SETTING_FIELDS].sort());
    expect(new Set(ACCOUNT_SETTING_DEFINITIONS.map((definition) => definition.key)).size).toBe(ACCOUNT_SETTING_DEFINITIONS.length);
});
