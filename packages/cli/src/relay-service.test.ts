import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';
import type {RoomEntry} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';

import {definitionProgram, formatServiceStatus, plistProgram, probeRelay, serviceDefinition, serviceLayout, servicePlist, servicePort, serviceProgram, unitProperties} from './relay-service.js';
import type {ServiceLayout, ServiceStatus} from './relay-service.js';
import {relayAdvice} from './room-list.js';
import type {RoomListEntry} from './render.js';

const layout: ServiceLayout = {manager: 'launchd', label: 'com.pairlobby.relay', file: '/Users/me/Library/LaunchAgents/com.pairlobby.relay.plist', log: '/Users/me/Library/Logs/PairLobby/relay.log', domain: 'gui/501'};

test('test_the_agent_runs_the_installed_launcher_and_restarts_after_a_failure', () => {
    const program = serviceProgram('/Users/me/.local/bin/pairlobby');
    expect(program).toEqual({args: ['/Users/me/.local/bin/pairlobby'], followsUpdates: true});
    const plist = servicePlist(layout, program, {port: 8790, environment: {PAIRLOBBY_NO_UPDATE_CHECK: '1', PATH: '/opt/homebrew/bin:/usr/bin'}});
    expect(plistProgram(plist)).toEqual(['/Users/me/.local/bin/pairlobby', 'serve', '--port', '8790']);
    expect(servicePort(plistProgram(plist))).toBe(8790);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(plist).toContain('<key>PAIRLOBBY_NO_UPDATE_CHECK</key><string>1</string>');
    expect(plist).toContain('<string>/Users/me/Library/Logs/PairLobby/relay.log</string>');
});

test('test_without_the_installer_the_agent_runs_this_exact_build_and_says_so', () => {
    const program = serviceProgram(null, process.argv[1]);
    expect(program.followsUpdates).toBe(false);
    expect(program.args[0]).toBe(process.execPath);
    const plist = servicePlist(layout, {args: ['/a & b/<node>'], followsUpdates: false}, {port: 8791, host: '0.0.0.0', environment: {}});
    expect(plist).toContain('<string>/a &amp; b/&lt;node&gt;</string>');
    expect(plistProgram(plist)).toEqual(['/a & b/<node>', 'serve', '--port', '8791', '--host', '0.0.0.0']);
});

test('test_on_linux_a_systemd_user_unit_runs_the_launcher_restarts_always_and_logs_to_a_file', () => {
    const linux = serviceLayout('linux', {}, '/home/me');
    expect(linux).toEqual({manager: 'systemd', label: 'pairlobby-relay', file: '/home/me/.config/systemd/user/pairlobby-relay.service', log: '/home/me/.local/state/pairlobby/relay.log', domain: 'user'});
    expect(serviceLayout('linux', {XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state', PAIRLOBBY_SERVICE_LABEL: 'pairlobby-test'}, '/home/me')).toMatchObject({label: 'pairlobby-test', file: '/cfg/systemd/user/pairlobby-test.service', log: '/state/pairlobby/pairlobby-test.log'});
    const unit = serviceDefinition(linux, {args: ['/home/me/.local/bin/pairlobby'], followsUpdates: true}, {port: 8790, environment: {PAIRLOBBY_NO_UPDATE_CHECK: '1', PATH: '/usr/local/bin:/usr/bin'}});
    expect(unit).toContain('ExecStart="/home/me/.local/bin/pairlobby" "serve" "--port" "8790"\n');
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin"\n');
    expect(unit).toContain('Restart=always\n');
    expect(unit).toContain('RestartSec=10\n');
    expect(unit).toContain('StandardOutput=append:/home/me/.local/state/pairlobby/relay.log\n');
    expect(unit).toContain('WantedBy=default.target\n');
    expect(definitionProgram(linux, unit)).toEqual(['/home/me/.local/bin/pairlobby', 'serve', '--port', '8790']);
    expect(servicePort(definitionProgram(linux, unit))).toBe(8790);
});

test('test_a_unit_quotes_spaces_quotes_percent_and_dollar_signs_and_reads_them_back', () => {
    const linux = serviceLayout('linux', {}, '/home/me');
    const unit = serviceDefinition(linux, {args: ['/opt/my "tools"/100%/$HOME\\node'], followsUpdates: false}, {port: 8791, host: '0.0.0.0', environment: {PAIRLOBBY_DATA_DIR: '/data/50%'}});
    expect(unit).toContain('ExecStart="/opt/my \\"tools\\"/100%%/$$HOME\\\\node" "serve" "--port" "8791" "--host" "0.0.0.0"');
    expect(unit).toContain('Environment="PAIRLOBBY_DATA_DIR=/data/50%%"');
    expect(definitionProgram(linux, unit)).toEqual(['/opt/my "tools"/100%/$HOME\\node', 'serve', '--port', '8791', '--host', '0.0.0.0']);
    expect(unitProperties('UnitFileState=enabled\nMainPID=4242\n')).toEqual({UnitFileState: 'enabled', MainPID: '4242'});
});

test('test_an_agent_from_the_old_repository_script_is_read_and_reported_as_not_following_updates', () => {
    const old = '<key>ProgramArguments</key>\n    <array><string>/Users/me/Library/Application Support/PairLobby/relay-launch.sh</string></array>';
    expect(plistProgram(old)).toEqual(['/Users/me/Library/Application Support/PairLobby/relay-launch.sh']);
    expect(servicePort(plistProgram(old))).toBe(8790);
    const status: ServiceStatus = {installed: true, loaded: true, pid: 4242, program: plistProgram(old), followsUpdates: false, relay: {answering: true, version: null}, url: 'http://127.0.0.1:8790', log: layout.log};
    const text = formatServiceStatus(status, '0.18.0');
    expect(text).toContain('installed and loaded (pid 4242)');
    expect(text).toContain('updates do not reach the relay; pairlobby service install fixes that');
    expect(text).toContain('an older build that does not report its version (this CLI is 0.18.0)');
});

test('test_status_names_a_version_gap_a_foreign_relay_on_the_port_and_a_relay_that_is_down', () => {
    const base: ServiceStatus = {installed: true, loaded: true, pid: 7, program: ['/Users/me/.local/bin/pairlobby', 'serve'], followsUpdates: true, relay: {answering: true, version: '0.18.0'}, url: 'http://127.0.0.1:8790', log: layout.log};
    expect(formatServiceStatus(base, '0.18.0')).toContain('answering on http://127.0.0.1:8790, version 0.18.0');
    expect(formatServiceStatus({...base, relay: {answering: true, version: '0.3.0'}}, '0.18.0')).toContain('version 0.3.0 while this CLI is 0.18.0');
    expect(formatServiceStatus({...base, pid: null}, '0.18.0')).toContain('another process holds the port');
    expect(formatServiceStatus({...base, relay: {answering: false, version: null}}, '0.18.0')).toContain('not answering on http://127.0.0.1:8790');
    expect(formatServiceStatus({...base, installed: false, loaded: false, pid: null, program: []}, '0.18.0')).toContain('not installed; pairlobby service install');
});

test('test_the_relay_reports_its_version_and_a_closed_port_reads_as_down', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-relay-probe-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite'), version: '9.9.9'});
    try {
        expect(await probeRelay(relay.url)).toEqual({answering: true, version: '9.9.9'});
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
    expect(await probeRelay(relay.url)).toEqual({answering: false, version: null});
});

test('test_the_room_list_says_this_devices_relay_is_down_and_what_to_run', () => {
    const room = (serverUrl: string): RoomEntry => ({roomId: `rm_${serverUrl.length}`, name: 'r', serverUrl, createdAt: 0, expiresAt: null, controls: false, sessions: []});
    const down: RoomListEntry = {room: room('http://127.0.0.1:8790'), reachable: false, why: 'server_unavailable'};
    const remote: RoomListEntry = {room: room('http://laptop.tailnet:8790'), reachable: false, why: 'server_unavailable'};
    const gone: RoomListEntry = {room: room('http://127.0.0.1:8790/x'), reachable: false, why: 'room_not_found'};
    expect(relayAdvice([remote, gone], () => false)).toBeNull();
    expect(relayAdvice([down, down, remote], (port) => port === 8790)).toBe('The relay at http://127.0.0.1:8790 is not running, so its rooms cannot be reached. Its service restarts it within 10 seconds; pairlobby service status says why it stopped.');
    if (process.platform === 'darwin') {
        expect(relayAdvice([down], () => false)).toContain('Start it with pairlobby service install, which');
        expect(relayAdvice([{...down, room: {...down.room, serverUrl: 'http://127.0.0.1:8798'}}], (port) => port === 8790)).toContain('Start it with pairlobby service install --port 8798');
    }
});
