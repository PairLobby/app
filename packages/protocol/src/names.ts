import {z} from 'zod';

export const ParticipantName = z.string().trim().min(1).max(64)
    .refine((name) => !/[\u0000-\u001f\u007f-\u009f]/u.test(name), 'names cannot contain control characters')
    .refine((name) => name.toLowerCase() !== 'all', 'all is reserved for group mentions');

export const NameSource = z.enum(['profile', 'room']);
export type NameSource = z.infer<typeof NameSource>;

export const RenameSelfRequest = z.object({name: ParticipantName, source: NameSource.default('room')}).strict();
export type RenameSelfRequest = z.infer<typeof RenameSelfRequest>;
