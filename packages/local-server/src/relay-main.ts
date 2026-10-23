#!/usr/bin/env node
//! `pairlobby-relay`: the relay alone, for a container or a service manager. It takes the
//! same PAIRLOBBY_* settings as `pairlobby serve`, logs JSON lines, and has none of the
//! CLI's room commands, network sharing or local discovery.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

import {RelaySettingsError, relaySettings} from './settings.js';
import type {RelayFlags} from './settings.js';

type LogLine = Record<string, unknown> & {level: 'info' | 'warn' | 'error'; event: string};

const HELP = `pairlobby-relay: a PairLobby relay for a container or a service

  pairlobby-relay                    run the relay with settings from PAIRLOBBY_* variables
  pairlobby-relay check <url>        check a deployed relay: health, invite address, create token,
                                     then one test room through create, join, send, read and delete
  pairlobby-relay --version

Settings (a flag wins over its variable)
  --data-dir <dir>         PAIRLOBBY_DATA_DIR             required; where rooms.sqlite lives
  --host <address>         PAIRLOBBY_HOST                 default 127.0.0.1; 0.0.0.0 in a container
  --port <port>            PAIRLOBBY_PORT                 default 8790
  --public-url <url>       PAIRLOBBY_PUBLIC_URL           the address invites show
  --trusted-proxy-header   PAIRLOBBY_TRUSTED_PROXY_HEADER such as x-forwarded-for, behind a load balancer
  --request-log <mode>     PAIRLOBBY_REQUEST_LOG          all, writes or off (default)
  --backup <place>         PAIRLOBBY_BACKUP               s3://bucket/prefix or an absolute folder
  --no-restore             PAIRLOBBY_NO_RESTORE=1         start empty on an empty disk
                           PAIRLOBBY_CREATE_TOKEN(_FILE)  token needed to create rooms
  See the guide for the rest: limits, allowed hosts, backup interval and S3 endpoint.
`;

function version(): string {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version: string}).version;
}

function log(line: LogLine): void {
    process.stdout.write(`${JSON.stringify({ts: new Date().toISOString(), ...line})}\n`);
}

async function check(url: string | undefined, json: boolean): Promise<number> {
    if (!url || !/^https?:\/\//.test(url)) {
        process.stderr.write('pairlobby-relay check needs the relay\'s address, such as https://pairlobby.internal.example.com\n');
        return 2;
    }
    const {checkRelay} = await import('./check.js');
    const createToken = process.env['PAIRLOBBY_CREATE_TOKEN'] || undefined;
    const steps = await checkRelay(url, createToken ? {createToken} : {});
    if (json) {
        process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`);
    } else {
        for (const {name, ok, detail} of steps) {
            process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(14)} ${detail}\n`);
        }
    }
    return steps.every((step) => step.ok) ? 0 : 1;
}

async function serve(flags: RelayFlags, dataDir: string | undefined): Promise<number> {
    const settings = relaySettings(flags, process.env);
    if (!dataDir) {
        throw new RelaySettingsError('set --data-dir (PAIRLOBBY_DATA_DIR) to where the rooms should live, such as a mounted volume');
    }
    const {DEFAULT_PORT, backupTarget, startServer} = await import('./index.js');
    const writeLine = (line: string) => process.stdout.write(`${line}\n`);
    const backup = settings.backup ? {target: backupTarget(settings.backup.location), intervalMs: settings.backup.intervalMs, keep: settings.backup.keep, restore: settings.backup.restore, log: writeLine} : undefined;
    const host = settings.host ?? '127.0.0.1';
    const running = await startServer({
        version: version(),
        host,
        port: settings.port ?? DEFAULT_PORT,
        dataFile: join(dataDir, 'rooms.sqlite'),
        ...(settings.publicUrl ? {publicUrl: settings.publicUrl} : {}),
        ...(settings.trustedProxyHeader ? {trustedProxyHeader: settings.trustedProxyHeader} : {}),
        ...(settings.createToken ? {createToken: settings.createToken} : {}),
        allowedHosts: settings.allowedHosts,
        limits: settings.limits,
        roomLimits: settings.roomLimits,
        discovery: settings.discovery,
        ...(settings.requestLog ? {requestLog: {mode: settings.requestLog, write: writeLine}} : {}),
        ...(backup ? {backup} : {})
    });
    log({level: 'info', event: 'start', version: version(), url: running.url, listening: `${running.host}:${running.port}`, dataFile: running.dataFile, createToken: Boolean(settings.createToken), loginMode: settings.discovery.loginMode, backup: backup?.target.description ?? null, restore: running.restore?.outcome ?? null});
    if (!settings.createToken && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
        log({level: 'warn', event: 'open-creation', message: 'anyone who can reach this relay can create rooms; set PAIRLOBBY_CREATE_TOKEN to require a token'});
    }
    await new Promise<void>((resolve) => {
        const stop = (signal: string) => {
            log({level: 'info', event: 'stopping', signal});
            void running.close().then(resolve);
        };
        process.once('SIGINT', () => stop('SIGINT'));
        process.once('SIGTERM', () => stop('SIGTERM'));
    });
    log({level: 'info', event: 'stop'});
    return 0;
}

async function main(argv: string[]): Promise<number> {
    const {values, positionals} = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            help: {type: 'boolean', short: 'h'},
            version: {type: 'boolean'},
            json: {type: 'boolean'},
            'data-dir': {type: 'string'},
            host: {type: 'string'},
            port: {type: 'string'},
            'public-url': {type: 'string'},
            'trusted-proxy-header': {type: 'string'},
            'request-log': {type: 'string'},
            backup: {type: 'string'},
            'no-restore': {type: 'boolean'},
        },
    });
    if (values.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (values.version) {
        process.stdout.write(`${version()}\n`);
        return 0;
    }
    if (positionals[0] === 'check') {
        return check(positionals[1], values.json === true);
    }
    if (positionals.length > 0) {
        process.stderr.write(`pairlobby-relay: unknown command "${positionals[0]}"\n\n${HELP}`);
        return 2;
    }
    const flags: RelayFlags = {
        ...(values.host !== undefined ? {host: values.host} : {}),
        ...(values.port !== undefined ? {port: values.port} : {}),
        ...(values['public-url'] !== undefined ? {publicUrl: values['public-url']} : {}),
        ...(values['trusted-proxy-header'] !== undefined ? {trustedProxyHeader: values['trusted-proxy-header']} : {}),
        ...(values['request-log'] !== undefined ? {requestLog: values['request-log']} : {}),
        ...(values.backup !== undefined ? {backup: values.backup} : {}),
        ...(values['no-restore'] ? {noRestore: true} : {}),
    };
    return serve(flags, values['data-dir'] ?? (process.env['PAIRLOBBY_DATA_DIR']?.trim() || undefined));
}

main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}, (error: unknown) => {
    const usage = error instanceof RelaySettingsError || (error as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
    log({level: 'error', event: usage ? 'bad-settings' : 'failed', message: error instanceof Error ? error.message : String(error)});
    process.exitCode = usage ? 2 : 1;
});
