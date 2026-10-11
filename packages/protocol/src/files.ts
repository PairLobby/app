//! Files attached to messages. The bytes live in the relay's file store, never in
//! an event: a message carries only what is needed to show and fetch each file.

import {z} from 'zod';

import {EventId, FileId, ParticipantId, RoomId} from './ids.js';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Largest single file a room accepts unless its policy says otherwise. Zero in a policy turns attachments off. */
export const DEFAULT_MAX_FILE_BYTES = 10 * MIB;
/** How much a room stores across all its files unless its policy says otherwise. */
export const DEFAULT_MAX_RETAINED_FILE_BYTES = 64 * MIB;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** An upload that no message carried is removed after this long. */
export const UNATTACHED_FILE_LIFETIME_MS = 60 * 60_000;
export const MAX_FILE_NAME_LENGTH = 255;

/** What a message says about a file. The relay fills every field from its own record; a client's claims are ignored. */
export const Attachment = z.object({
    fileId: FileId,
    name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
    size: z.number().int().nonnegative(),
    /** What the uploader said the file is. A label for display, never a reason to run or render it. */
    mediaType: z.string().min(1).max(127),
    sha256: z.string().length(64)
});
export type Attachment = z.infer<typeof Attachment>;

export const FileRecord = Attachment.extend({
    roomId: RoomId,
    uploaderId: ParticipantId,
    createdAt: z.number().int().nonnegative(),
    /** The message that carries this file, or null while it is uploaded but not yet sent. */
    eventId: EventId.nullable()
});
export type FileRecord = z.infer<typeof FileRecord>;

export const UploadFileResponse = z.object({file: Attachment});
export type UploadFileResponse = z.infer<typeof UploadFileResponse>;

/** A file as listed for a room: where it is, who sent it and when. */
export const RoomFile = Attachment.extend({uploaderId: ParticipantId, createdAt: z.number().int().nonnegative(), eventId: EventId});
export type RoomFile = z.infer<typeof RoomFile>;

export const ListFilesResponse = z.object({files: z.array(RoomFile)});
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
