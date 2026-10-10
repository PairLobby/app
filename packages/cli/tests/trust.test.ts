import {execFile, execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterAll, beforeAll, expect, test} from 'vitest';

import {certificatesIn, trustLocalCertificates} from '../src/trust.js';

const execute = promisify(execFile);
const directory = mkdtempSync(join(tmpdir(), 'pairlobby-trust-'));
const root = join(directory, 'root.pem');
let origin: string;
let close: () => Promise<void>;

// A stand-in for a company network: a private root that no machine trusts, signing the relay's certificate.
beforeAll(async () => {
    const openssl = (...args: string[]) => execFileSync('openssl', args, {cwd: directory, stdio: 'pipe'});
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Example Corp Inspection Root', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'relay.key', '-out', 'relay.csr', '-subj', '/CN=127.0.0.1');
    writeFileSync(join(directory, 'relay.ext'), 'subjectAltName=IP:127.0.0.1\n');
    openssl('x509', '-req', '-in', 'relay.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'relay.pem', '-days', '2', '-extfile', 'relay.ext');
    const server = createServer({key: readFileSync(join(directory, 'relay.key')), cert: readFileSync(join(directory, 'relay.pem'))}, (_request, response) => {
        response.writeHead(404, {'content-type': 'application/json'});
        response.end(JSON.stringify({error: {code: 'room_not_found', message: 'no such room'}}));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((done) => server.close(() => done()));
}, 30_000);

afterAll(async () => {
    await close();
    rmSync(directory, {recursive: true, force: true});
});

/** Asks the built CLI to read a room on the stand-in relay; resolves with what it printed on stderr. */
async function cli(env: NodeJS.ProcessEnv): Promise<string> {
    const base: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', ...env};
    delete base['NODE_EXTRA_CA_CERTS'];
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'PAIRLOBBY_SESSION', 'PAIRLOBBY_ROOM']) {
        delete base[variable];
    }
    return execute(process.execPath, [resolve('packages/cli/dist/main.js'), 'join', 'ABCD-EFGH', '--server', origin, '--human', '--as', 'hugo', '--json'], {env: base, timeout: 20_000}).then(({stderr}) => stderr, (error: {stderr?: string}) => error.stderr ?? '');
}

test('test_a_relay_signed_by_an_unknown_root_is_refused_with_advice_and_accepted_once_the_root_is_named', async () => {
    const refused = await cli({PAIRLOBBY_CA_FILE: ''});
    expect(refused).toContain(`could not reach ${origin}`);
    expect(refused).toMatch(/its certificate is not trusted on this machine \((SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)/);
    expect(refused).toContain('PAIRLOBBY_CA_FILE');

    // With the root named, the TLS handshake succeeds and the relay's own answer comes through.
    const trusted = await cli({PAIRLOBBY_CA_FILE: root});
    expect(trusted).not.toContain('certificate is not trusted');
    expect(trusted).not.toContain('could not reach');
    expect(trusted).toMatch(/no such room|room_not_found|invite/i);
}, 60_000);

test('test_a_bad_certificate_file_is_reported_and_never_stops_the_command', async () => {
    const missing = await cli({PAIRLOBBY_CA_FILE: join(directory, 'absent.pem')});
    expect(missing).toContain('absent.pem could not be read');
    expect(missing).toContain('certificate is not trusted');
    writeFileSync(join(directory, 'empty.pem'), 'not a certificate\n');
    expect(await cli({PAIRLOBBY_CA_FILE: join(directory, 'empty.pem')})).toContain('empty.pem contains no PEM certificate');
}, 60_000);

test('test_trust_only_ever_grows_and_falls_back_cleanly_on_a_node_that_cannot_change_it', () => {
    const pem = (name: string) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----`;
    writeFileSync(join(directory, 'bundle.pem'), `# company roots\n${pem('file-one')}\n\n${pem('file-two')}\n${pem('bundled-a')}\n`);
    expect(certificatesIn(readFileSync(join(directory, 'bundle.pem'), 'utf8'))).toHaveLength(3);

    let applied: string[] | undefined;
    const stores = {default: [pem('bundled-a'), pem('bundled-b')], system: [pem('os-root'), pem('bundled-b')]};
    const api = {getCACertificates: (store: 'default' | 'system') => stores[store], setDefaultCACertificates: (certificates: string[]) => { applied = certificates; }};
    expect(trustLocalCertificates(join(directory, 'bundle.pem'), api)).toEqual({applied: true, system: 2, file: 3});
    // Node's own list first and intact, then only what is new, each once.
    expect(applied).toEqual([pem('bundled-a'), pem('bundled-b'), pem('os-root'), pem('file-one'), pem('file-two')]);

    // Nothing new to add: the trust list is left untouched.
    applied = undefined;
    expect(trustLocalCertificates('', {...api, getCACertificates: (store) => (store === 'system' ? [pem('bundled-a')] : stores.default)})).toEqual({applied: true, system: 1, file: 0});
    expect(applied).toBeUndefined();

    // A platform whose store cannot be read still gets the file.
    expect(trustLocalCertificates(join(directory, 'bundle.pem'), {...api, getCACertificates: (store) => { if (store === 'system') { throw new Error('unsupported'); } return stores.default; }})).toEqual({applied: true, system: 0, file: 3});
    expect(applied).toEqual([pem('bundled-a'), pem('bundled-b'), pem('file-one'), pem('file-two')]);

    // An older Node cannot change trust after starting: say how to do it instead.
    expect(trustLocalCertificates(join(directory, 'bundle.pem'), {})).toMatchObject({applied: false, problem: expect.stringContaining('NODE_EXTRA_CA_CERTS')});
    expect(trustLocalCertificates('', {})).toEqual({applied: false, system: 0, file: 0});
});
