export class HttpError extends Error {
    constructor(readonly status: number, message: string
    ) {
        super(message);
    }
}
export function json(value: unknown, status = 200) {
    return Response.json(value, {status, headers: {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
}
export function fail(status: number, message: string): never {
    throw new HttpError(status, message);
}
export async function body(request: Request): Promise<Record<string, unknown>> {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(400, 'Expected a JSON object');
    }
    return value as Record<string, unknown>;
}
export function textField(value: unknown, name: string, max = 64): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        fail(400, `Invalid ${name}`);
    }
    return value.trim();
}
export async function digest(value: string) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function secret() {
    return [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
