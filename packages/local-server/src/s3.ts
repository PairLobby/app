//! The few S3 calls a relay backup needs, signed with AWS Signature Version 4 over
//! `fetch`, so the relay carries no SDK. Works with AWS S3 and with S3-compatible
//! stores such as Cloudflare R2 or MinIO through an explicit endpoint.

import {createHash, createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';

export type S3Credentials = {accessKeyId: string; secretAccessKey: string; sessionToken?: string};

type ExpiringCredentials = S3Credentials & {expiresAt?: number};

export type S3Environment = Record<string, string | undefined>;

export type S3ClientOptions = {
    bucket: string;
    region: string;
    /** An S3-compatible endpoint such as `https://<account>.r2.cloudflarestorage.com`; addressed path-style. Absent means AWS. */
    endpoint?: string;
    /** Absent means the usual AWS chain: environment, then the ECS task role, then the EC2 instance role. */
    credentials?: () => Promise<S3Credentials>;
    fetch?: typeof fetch;
};

export type SignInput = {method: string; url: URL; headers: Record<string, string>; payloadHash: string; credentials: S3Credentials; region: string; at: Date};

export type S3Client = {
    putObject(key: string, body: Uint8Array): Promise<void>;
    /** Null when the object does not exist. */
    getObject(key: string): Promise<Uint8Array | null>;
    listKeys(prefix: string): Promise<string[]>;
    deleteObject(key: string): Promise<void>;
};

const EMPTY_HASH = createHash('sha256').update('').digest('hex');

function sha256Hex(data: Uint8Array | string): string {
    return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
    return createHmac('sha256', key).update(data).digest();
}

/** RFC 3986 encoding, which SigV4 requires and `encodeURIComponent` falls short of. */
function encodeStrict(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The request's headers plus `x-amz-date`, the token when there is one, and `authorization`. */
export function signRequest({method, url, headers, payloadHash, credentials, region, at}: SignInput): Record<string, string> {
    const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const signed: Record<string, string> = {...headers, host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...(credentials.sessionToken ? {'x-amz-security-token': credentials.sessionToken} : {})};
    const names = Object.keys(signed).map((name) => name.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(signed).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')]));
    const query = [...url.searchParams].map(([name, value]) => `${encodeStrict(name)}=${encodeStrict(value)}`).sort().join('&');
    const canonical = [method, url.pathname.split('/').map((segment) => encodeStrict(decodeURIComponent(segment))).join('/'), query, names.map((name) => `${name}:${lower[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    return {...signed, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
}

type RoleCredentialsBody = {AccessKeyId: string; SecretAccessKey: string; Token?: string; Expiration?: string};

function fromRoleBody(body: RoleCredentialsBody): ExpiringCredentials {
    return {accessKeyId: body.AccessKeyId, secretAccessKey: body.SecretAccessKey, ...(body.Token ? {sessionToken: body.Token} : {}), ...(body.Expiration ? {expiresAt: Date.parse(body.Expiration)} : {})};
}

async function fetchJson(fetcher: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<RoleCredentialsBody> {
    const response = await fetcher(url, {headers, signal: AbortSignal.timeout(2000)});
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    return (await response.json()) as RoleCredentialsBody;
}

async function loadCredentials(environment: S3Environment, fetcher: typeof fetch): Promise<ExpiringCredentials> {
    const accessKeyId = environment['AWS_ACCESS_KEY_ID'];
    const secretAccessKey = environment['AWS_SECRET_ACCESS_KEY'];
    if (accessKeyId && secretAccessKey) {
        const sessionToken = environment['AWS_SESSION_TOKEN'];
        return {accessKeyId, secretAccessKey, ...(sessionToken ? {sessionToken} : {})};
    }
    const relative = environment['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];
    if (relative) {
        return fromRoleBody(await fetchJson(fetcher, `http://169.254.170.2${relative}`));
    }
    const full = environment['AWS_CONTAINER_CREDENTIALS_FULL_URI'];
    if (full) {
        const tokenFile = environment['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'];
        const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : environment['AWS_CONTAINER_AUTHORIZATION_TOKEN'];
        return fromRoleBody(await fetchJson(fetcher, full, token ? {authorization: token} : {}));
    }
    // EC2 instance metadata, version 2: a session token first, then the role's credentials.
    const tokenResponse = await fetcher('http://169.254.169.254/latest/api/token', {method: 'PUT', headers: {'x-aws-ec2-metadata-token-ttl-seconds': '21600'}, signal: AbortSignal.timeout(1000)}).catch(() => null);
    if (!tokenResponse?.ok) {
        throw new Error('no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run with an ECS task role or an EC2 instance role');
    }
    const metadataToken = await tokenResponse.text();
    const roles = await fetcher('http://169.254.169.254/latest/meta-data/iam/security-credentials/', {headers: {'x-aws-ec2-metadata-token': metadataToken}, signal: AbortSignal.timeout(1000)});
    const role = (await roles.text()).split('\n')[0]?.trim();
    if (!roles.ok || !role) {
        throw new Error('this EC2 instance has no IAM role to back up with');
    }
    return fromRoleBody(await fetchJson(fetcher, `http://169.254.169.254/latest/meta-data/iam/security-credentials/${role}`, {'x-aws-ec2-metadata-token': metadataToken}));
}

/** The default AWS credential chain, cached until five minutes before temporary credentials expire. */
export function awsCredentials(environment: S3Environment = process.env, fetcher: typeof fetch = fetch): () => Promise<S3Credentials> {
    let cached: ExpiringCredentials | null = null;
    return async () => {
        if (!cached || (cached.expiresAt !== undefined && cached.expiresAt - Date.now() < 5 * 60_000)) {
            cached = await loadCredentials(environment, fetcher);
        }
        return cached;
    };
}

function xmlValues(xml: string, tag: string): string[] {
    const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => unescape(match[1] ?? ''));
}

export function s3Client({bucket, region, endpoint, credentials = awsCredentials(), fetch: fetcher = fetch}: S3ClientOptions): S3Client {
    const base = endpoint ? `${endpoint.replace(/\/+$/, '')}/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;
    const objectUrl = (key: string) => new URL(`${base}/${key.split('/').map(encodeStrict).join('/')}`);
    const send = async (method: string, url: URL, body?: Uint8Array) => {
        const headers = signRequest({method, url, headers: {}, payloadHash: body ? sha256Hex(body) : EMPTY_HASH, credentials: await credentials(), region, at: new Date()});
        delete headers['host'];
        return fetcher(url, {method, headers, ...(body ? {body} : {})});
    };
    const failed = async (response: Response, what: string) => new Error(`S3 ${what} answered ${response.status}: ${xmlValues(await response.text(), 'Code')[0] ?? response.statusText}`);
    return {
        async putObject(key, body) {
            const response = await send('PUT', objectUrl(key), body);
            if (!response.ok) {
                throw await failed(response, `upload of ${key}`);
            }
        },
        async getObject(key) {
            const response = await send('GET', objectUrl(key));
            if (response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw await failed(response, `download of ${key}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        },
        async listKeys(prefix) {
            const keys: string[] = [];
            let continuation: string | undefined;
            do {
                const url = new URL(`${base}/`);
                url.searchParams.set('list-type', '2');
                url.searchParams.set('prefix', prefix);
                if (continuation) {
                    url.searchParams.set('continuation-token', continuation);
                }
                const response = await send('GET', url);
                if (!response.ok) {
                    throw await failed(response, `listing of ${bucket}/${prefix}`);
                }
                const xml = await response.text();
                keys.push(...xmlValues(xml, 'Key'));
                continuation = xmlValues(xml, 'IsTruncated')[0] === 'true' ? xmlValues(xml, 'NextContinuationToken')[0] : undefined;
            } while (continuation);
            return keys;
        },
        async deleteObject(key) {
            const response = await send('DELETE', objectUrl(key));
            if (!response.ok && response.status !== 404) {
                throw await failed(response, `delete of ${key}`);
            }
        }
    };
}
