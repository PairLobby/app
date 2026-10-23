import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
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
