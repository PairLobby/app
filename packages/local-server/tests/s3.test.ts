import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';

import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import {awsCredentials, s3Client, signRequest} from '../src/s3.js';

type FakeBucket = {objects: Map<string, Buffer>; unsigned: number};

const bucket: FakeBucket = {objects: new Map(), unsigned: 0};
let server: Server;
let endpoint: string;

/** Path-style S3 with just the calls a backup makes; lists two keys a page to exercise continuation. */
function fakeS3(): Server {
    return createServer((incoming, outgoing) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
            const body = Buffer.concat(chunks);
            const url = new URL(incoming.url ?? '/', 'http://fake');
            const signed = String(incoming.headers['authorization'] ?? '').startsWith('AWS4-HMAC-SHA256 Credential=test-key/');
            if (!signed || incoming.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) {
                bucket.unsigned++;
                outgoing.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
                return;
            }
            const key = decodeURIComponent(url.pathname.replace(/^\/team-bucket\/?/, ''));
            if (incoming.method === 'GET' && url.searchParams.get('list-type') === '2') {
                const keys = [...bucket.objects.keys()].filter((name) => name.startsWith(url.searchParams.get('prefix') ?? '')).sort();
                const start = Number(url.searchParams.get('continuation-token') ?? 0);
                const page = keys.slice(start, start + 2);
                const more = start + 2 < keys.length;
                outgoing.writeHead(200).end(`<ListBucketResult>${page.map((name) => `<Contents><Key>${name.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
                return;
            }
            if (incoming.method === 'PUT') {
                bucket.objects.set(key, body);
                outgoing.writeHead(200).end();
                return;
            }
            if (incoming.method === 'GET') {
                const object = bucket.objects.get(key);
                outgoing.writeHead(object ? 200 : 404).end(object ?? '<Error><Code>NoSuchKey</Code></Error>');
                return;
            }
            bucket.objects.delete(key);
            outgoing.writeHead(204).end();
        });
    });
}

beforeAll(async () => {
    server = fakeS3();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    server.close();
});

describe('S3 signing', () => {
    test('test_the_signature_matches_the_example_in_the_aws_documentation', () => {
        // "Example: GET Object" from the S3 Signature Version 4 header authentication guide.
        const headers = signRequest({method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: {range: 'bytes=0-9'}, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', credentials: {accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'}, region: 'us-east-1', at: new Date('2013-05-24T00:00:00Z')});
        expect(headers['authorization']).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    });

    test('test_temporary_credentials_add_and_sign_the_session_token', () => {
        const headers = signRequest({method: 'GET', url: new URL('https://b.s3.amazonaws.com/k'), headers: {}, payloadHash: 'x', credentials: {accessKeyId: 'a', secretAccessKey: 's', sessionToken: 'session'}, region: 'eu-west-1', at: new Date('2026-10-21T00:00:00Z')});
        expect(headers['x-amz-security-token']).toBe('session');
        expect(headers['authorization']).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token');
    });
});

describe('S3 client', () => {
    test('test_objects_go_up_come_back_list_across_pages_and_delete', async () => {
        const client = s3Client({bucket: 'team-bucket', region: 'us-east-1', endpoint: `${endpoint}/`, credentials: async () => ({accessKeyId: 'test-key', secretAccessKey: 'secret'})});
        for (const name of ['relay/a', 'relay/b', 'relay/c', 'other/d']) {
            await client.putObject(name, new TextEncoder().encode(name));
        }
        expect(new TextDecoder().decode((await client.getObject('relay/b')) ?? new Uint8Array())).toBe('relay/b');
        expect(await client.getObject('relay/missing')).toBeNull();
        expect(await client.listKeys('relay/')).toEqual(['relay/a', 'relay/b', 'relay/c']);
        await client.deleteObject('relay/a');
        expect(await client.listKeys('relay/')).toEqual(['relay/b', 'relay/c']);
        expect(bucket.unsigned).toBe(0);
    });

    test('test_a_refusal_names_the_call_and_the_s3_error_code', async () => {
        const client = s3Client({bucket: 'team-bucket', region: 'us-east-1', endpoint, credentials: async () => ({accessKeyId: 'wrong-key', secretAccessKey: 'secret'})});
        await expect(client.putObject('relay/x', new Uint8Array([1]))).rejects.toThrow('S3 upload of relay/x answered 403: SignatureDoesNotMatch');
    });
});

describe('AWS credentials', () => {
    test('test_the_environment_wins_then_the_ecs_task_role_is_asked_and_cached', async () => {
        const fromEnvironment = awsCredentials({AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token'});
        expect(await fromEnvironment()).toEqual({accessKeyId: 'id', secretAccessKey: 'secret', sessionToken: 'token'});

        const asked: string[] = [];
        const expiration = new Date(Date.now() + 60 * 60_000).toISOString();
        const taskRole = (async (url: string | URL | Request) => {
            asked.push(String(url));
            return new Response(JSON.stringify({AccessKeyId: 'role-id', SecretAccessKey: 'role-secret', Token: 'role-token', Expiration: expiration}));
        }) as typeof fetch;
        const fromTask = awsCredentials({AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc'}, taskRole);
        expect(await fromTask()).toMatchObject({accessKeyId: 'role-id', sessionToken: 'role-token'});
        await fromTask();
        expect(asked).toEqual(['http://169.254.170.2/v2/credentials/abc']);
    });

    test('test_no_credentials_anywhere_says_how_to_provide_them', async () => {
        const nothing = (async () => {
            throw new Error('unreachable');
        }) as typeof fetch;
        await expect(awsCredentials({}, nothing)()).rejects.toThrow('no AWS credentials');
    });
});

type StsCall = {headers: Record<string, string | string[] | undefined>; form: URLSearchParams};

type StsAnswer = {status: number; body: string};

/** A loopback STS that records each AssumeRoleWithWebIdentity call and answers with whatever the test queued. */
async function fakeSts(answer: (call: StsCall) => StsAnswer): Promise<{url: string; calls: StsCall[]; close: () => void}> {
    const calls: StsCall[] = [];
    const sts = createServer((incoming, outgoing) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
            const call = {headers: incoming.headers, form: new URLSearchParams(Buffer.concat(chunks).toString())};
            calls.push(call);
            const {status, body} = answer(call);
            outgoing.writeHead(status, {'content-type': 'application/json'}).end(body);
        });
    });
    await new Promise<void>((resolve) => sts.listen(0, '127.0.0.1', resolve));
    return {url: `http://127.0.0.1:${(sts.address() as AddressInfo).port}/`, calls, close: () => sts.close()};
}

function stsCredentials(id: string, expiration: number | string): StsAnswer {
    return {status: 200, body: JSON.stringify({AssumeRoleWithWebIdentityResponse: {AssumeRoleWithWebIdentityResult: {Credentials: {AccessKeyId: id, SecretAccessKey: `${id}-secret`, SessionToken: `${id}-session`, Expiration: expiration}}}})};
}

describe('AWS web identity credentials', () => {
    const roleArn = 'arn:aws:iam::123456789012:role/pairlobby-relay';
    let directory: string;
    let tokenFile: string;

    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), 'pairlobby-web-identity-'));
        tokenFile = join(directory, 'token');
    });

    afterAll(() => {
        rmSync(directory, {recursive: true, force: true});
    });

    test('test_web_identity_assumes_the_role_with_an_unsigned_form_post', async () => {
        writeFileSync(tokenFile, 'web-token-1\n');
        const sts = await fakeSts(() => stsCredentials('assumed', Math.floor(Date.now() / 1000) + 3600));
        try {
            const credentials = await awsCredentials({AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ENDPOINT_URL_STS: sts.url})();
            expect(credentials).toMatchObject({accessKeyId: 'assumed', secretAccessKey: 'assumed-secret', sessionToken: 'assumed-session'});
            expect(sts.calls).toHaveLength(1);
            const [call] = sts.calls;
            expect(Object.fromEntries(call!.form)).toEqual({Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: roleArn, RoleSessionName: 'pairlobby-relay', WebIdentityToken: 'web-token-1'});
            expect(call!.headers['accept']).toBe('application/json');
            expect(call!.headers['authorization']).toBeUndefined();
        } finally {
            sts.close();
        }
    });

    test('test_expiring_credentials_are_refreshed_with_the_token_file_read_again', async () => {
        writeFileSync(tokenFile, 'web-token-1');
        let round = 0;
        // The first credentials expire within the five-minute margin, in ISO form; the second last an hour, in epoch seconds.
        const sts = await fakeSts(() => ++round === 1 ? stsCredentials('first', new Date(Date.now() + 60_000).toISOString()) : stsCredentials('second', Math.floor(Date.now() / 1000) + 3600));
        try {
            const credentials = awsCredentials({AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_SESSION_NAME: 'team-relay', AWS_ENDPOINT_URL_STS: sts.url});
            expect((await credentials()).accessKeyId).toBe('first');
            writeFileSync(tokenFile, 'web-token-2');
            expect((await credentials()).accessKeyId).toBe('second');
            expect((await credentials()).accessKeyId).toBe('second');
            expect(sts.calls.map((call) => [call.form.get('WebIdentityToken'), call.form.get('RoleSessionName')])).toEqual([['web-token-1', 'team-relay'], ['web-token-2', 'team-relay']]);
        } finally {
            sts.close();
        }
    });

    test('test_concurrent_callers_share_one_refresh', async () => {
        writeFileSync(tokenFile, 'web-token-1');
        const sts = await fakeSts(() => stsCredentials('shared', Math.floor(Date.now() / 1000) + 3600));
        try {
            const credentials = awsCredentials({AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ENDPOINT_URL_STS: sts.url});
            const all = await Promise.all([credentials(), credentials(), credentials()]);
            expect(all.map((each) => each.accessKeyId)).toEqual(['shared', 'shared', 'shared']);
            expect(sts.calls).toHaveLength(1);
        } finally {
            sts.close();
        }
    });

    test('test_an_sts_refusal_names_the_role_and_error_code_and_nothing_secret', async () => {
        writeFileSync(tokenFile, 'secret-web-token');
        const sts = await fakeSts(() => ({status: 400, body: JSON.stringify({Error: {Code: 'InvalidIdentityToken', Message: 'Token secret-web-token is not valid'}})}));
        try {
            const failure = await awsCredentials({AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ENDPOINT_URL_STS: sts.url})().catch((error: Error) => error);
            expect((failure as Error).message).toBe(`could not assume ${roleArn}: InvalidIdentityToken`);
            expect((failure as Error).message).not.toContain('secret-web-token');
        } finally {
            sts.close();
        }
        const missing = awsCredentials({AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: join(directory, 'missing'), AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:9/'});
        await expect(missing()).rejects.toThrow(`could not assume ${roleArn}: cannot read AWS_WEB_IDENTITY_TOKEN_FILE`);
    });

    test('test_environment_keys_win_over_web_identity_which_wins_over_the_container_role', async () => {
        writeFileSync(tokenFile, 'web-token-1');
        const asked: string[] = [];
        const recording = (async (url: string | URL | Request) => {
            asked.push(String(url));
            return new Response(stsCredentials('from-sts', Math.floor(Date.now() / 1000) + 3600).body);
        }) as typeof fetch;
        const webIdentity = {AWS_ROLE_ARN: roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_REGION: 'eu-west-1'};
        expect((await awsCredentials({...webIdentity, AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret'}, recording)()).accessKeyId).toBe('id');
        expect(asked).toEqual([]);
        expect((await awsCredentials({...webIdentity, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc'}, recording)()).accessKeyId).toBe('from-sts');
        expect(asked).toEqual(['https://sts.eu-west-1.amazonaws.com/']);
    });
});
