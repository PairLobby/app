//! Bearer credential generation and hashing.
//!
//! Credentials are 256-bit random tokens, so a single SHA-256 is the correct
//! digest: there is no low-entropy secret for a slow KDF to protect, and room
//! authorization runs this on every request.

const CREDENTIAL_BYTES = 32;

export type CredentialKind = 'controller' | 'participant' | 'attempt' | 'connect';

const CREDENTIAL_PREFIXES: Record<CredentialKind, string> = {controller: 'plc', participant: 'plp', attempt: 'pla', connect: 'plk'};

function toBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function newCredential(kind: CredentialKind): string {
    const bytes = new Uint8Array(CREDENTIAL_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    return `${CREDENTIAL_PREFIXES[kind]}_${toBase64Url(bytes)}`;
}

export function credentialKindOf(credential: string): CredentialKind | null {
    const prefix = credential.split('_', 1)[0];
    const found = Object.entries(CREDENTIAL_PREFIXES).find(([, value]) => value === prefix);
    return found ? (found[0] as CredentialKind) : null;
}

export async function hashCredential(credential: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares two hex digests without an early exit on the first differing byte. */
export function digestsEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
}
