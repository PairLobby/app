//! Files attached to messages. The bytes live in the relay's file store, never in
//! an event: a message carries only what is needed to show and fetch each file.

import {z} from 'zod';

import {EventId, FileId, ParticipantId, RoomId} from './ids.js';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Hard ceiling for one file: 95 MiB is 99,614,720 bytes, strictly below 100 MB. */
export const ABSOLUTE_MAX_FILE_BYTES = 95 * MIB;
/** Largest single file a room accepts unless its policy says otherwise. Zero in a policy turns attachments off. */
export const DEFAULT_MAX_FILE_BYTES = ABSOLUTE_MAX_FILE_BYTES;
/** How much a room stores across all its files unless its policy says otherwise. */
export const DEFAULT_MAX_RETAINED_FILE_BYTES = 512 * MIB;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** An upload that no message carried is removed after this long. */
export const UNATTACHED_FILE_LIFETIME_MS = 60 * 60_000;
export const MAX_FILE_NAME_LENGTH = 255;
export const FILE_SIZE_HEADER = 'pairlobby-file-size';
export const FILE_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_TEMPORARY_FILE_TTL_MS = 24 * 60 * 60_000;
export const MAX_TEMPORARY_FILE_TTL_MS = 365 * 24 * 60 * 60_000;

/** A sender's choice. Temporary retention starts when the relay accepts the upload. */
export const FileRetentionRequest = z.discriminatedUnion('mode', [
    z.object({mode: z.literal('forever')}).strict(),
    z.object({mode: z.literal('temporary'), ttlMs: z.number().int().min(1000).max(MAX_TEMPORARY_FILE_TTL_MS)}).strict(),
    z.object({mode: z.literal('until-received')}).strict()
]);
export type FileRetentionRequest = z.infer<typeof FileRetentionRequest>;

/** Absolute expiry survives room moves; old attachments without a policy keep their existing lifetime. */
export const FileRetention = z.discriminatedUnion('mode', [
    z.object({mode: z.literal('forever')}),
    z.object({mode: z.literal('temporary'), expiresAt: z.number().int().nonnegative()}),
    z.object({mode: z.literal('until-received')})
]);
export type FileRetention = z.infer<typeof FileRetention>;

export const FileReceiptRequest = z.object({sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative()}).strict();
export type FileReceiptRequest = z.infer<typeof FileReceiptRequest>;
export const FileReceiptResponse = z.object({fileId: FileId, available: z.boolean(), remaining: z.number().int().nonnegative()});
export type FileReceiptResponse = z.infer<typeof FileReceiptResponse>;

/** What a message says about a file. The relay fills every field from its own record; a client's claims are ignored. */
export const Attachment = z.object({
    fileId: FileId,
    name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
    size: z.number().int().nonnegative(),
    /** What the uploader said the file is. A label for display, never a reason to run or render it. */
    mediaType: z.string().min(1).max(127),
    sha256: z.string().length(64),
    retention: FileRetention.optional()
});
export type Attachment = z.infer<typeof Attachment>;

export const FileRecord = Attachment.extend({
    roomId: RoomId,
    uploaderId: ParticipantId,
    createdAt: z.number().int().nonnegative(),
    /** The message that carries this file, or null while it is uploaded but not yet sent. */
    eventId: EventId.nullable(),
    /** Members other than the sender, fixed atomically when the file is attached. */
    receiptRecipients: z.array(ParticipantId).optional(),
    receivedBy: z.array(ParticipantId).optional()
});
export type FileRecord = z.infer<typeof FileRecord>;

export const UploadFileResponse = z.object({file: Attachment});
export type UploadFileResponse = z.infer<typeof UploadFileResponse>;

/** A file as listed for a room: where it is, who sent it and when. */
export const RoomFile = Attachment.extend({uploaderId: ParticipantId, createdAt: z.number().int().nonnegative(), eventId: EventId, receiptRecipients: z.array(ParticipantId).optional(), receivedBy: z.array(ParticipantId).optional()});
export type RoomFile = z.infer<typeof RoomFile>;

/** How much of the room's file storage is taken. Pending uploads count, because the limit counts them. */
export const FileUsage = z.object({usedBytes: z.number().int().nonnegative(), limitBytes: z.number().int().nonnegative(), maxFileBytes: z.number().int().nonnegative()});
export type FileUsage = z.infer<typeof FileUsage>;

export const ListFilesResponse = z.object({files: z.array(RoomFile), usage: FileUsage.optional()});
export type ListFilesResponse = z.infer<typeof ListFilesResponse>;

/**
 * A name safe to show and to save under: the last path segment only, no control
 * characters, never empty and never a dot-file or a relative step. The name still
 * comes from another participant, so a client saving it chooses the directory.
 */
export function safeFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/[<>:"|?*]/g, '_').trim().replace(/^\.+/, '').slice(0, MAX_FILE_NAME_LENGTH).trim();
    return cleaned || 'file';
}

/** 1536 → "1.5 KB". Decimal steps of 1024, one decimal below ten. */
export function formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
