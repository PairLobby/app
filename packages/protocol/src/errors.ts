//! Typed protocol errors. Codes are stable wire values; messages are for humans
//! and must never carry a credential, an invite code, or transcript content.

export const ERROR_CODES = [
    'invite_expired',
    'invite_already_redeemed',
    'invite_unknown',
    'unauthorized',
    'participant_revoked',
    'room_expired',
    'room_closed',
    'room_not_found',
    'quota_exceeded',
    'cursor_gap',
    'stale_handover_revision',
    'handover_already_resolved',
    'idempotency_conflict',
    'participant_limit_reached',
    'payload_too_large',
    'unsupported_capability',
    'protocol_version_unsupported',
    'invalid_request',
    'server_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolErrorBody {
    code: ErrorCode;
    message: string;
    /** Milliseconds the caller should wait before retrying, when retrying can help. */
    retryAfterMs?: number;
    /** Set on `cursor_gap` so the client can resume from a sequence the server still holds. */
    earliestAvailableSeq?: number;
    /** Set on `stale_handover_revision` so the client can name the revision it must accept. */
    currentRevision?: number;
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
    invite_expired:               410,
    invite_already_redeemed:      409,
    invite_unknown:               404,
    unauthorized:                 401,
    participant_revoked:          403,
    room_expired:                 410,
    room_closed:                  409,
    room_not_found:               404,
    quota_exceeded:               429,
    cursor_gap:                   410,
    stale_handover_revision:      409,
    handover_already_resolved:    409,
    idempotency_conflict:         409,
    participant_limit_reached:    409,
    payload_too_large:            413,
    unsupported_capability:       501,
    protocol_version_unsupported: 400,
    invalid_request:              400,
    server_unavailable:           503,
};

export class ProtocolError extends Error {
    readonly code: ErrorCode;
    readonly details: Omit<ProtocolErrorBody, 'code' | 'message'>;
    constructor(code: ErrorCode, message: string, details: Omit<ProtocolErrorBody, 'code' | 'message'> = {}) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        this.details = details;
    }
    get httpStatus(): number {
        return STATUS_BY_CODE[this.code];
    }
    toBody(): ProtocolErrorBody {
        return {code: this.code, message: this.message, ...this.details};
    }
}

export function httpStatusFor(code: ErrorCode): number {
    return STATUS_BY_CODE[code];
}

/** True when the same request, unchanged, could succeed later. */
export function isRetryable(code: ErrorCode): boolean {
    return code === 'server_unavailable' || code === 'quota_exceeded';
}
