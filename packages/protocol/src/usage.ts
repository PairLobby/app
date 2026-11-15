import {z} from 'zod';

/** Account-service allowances, separate from the locally running AI provider's billing. */
export const UsageAllowance = z.object({used: z.number().nonnegative(), limit: z.number().nonnegative()});
export type UsageAllowance = z.infer<typeof UsageAllowance>;

export const AccountUsage = z.object({
    workspaceId: z.string(),
    workspaceName: z.string().optional(),
    plan: z.string(),
    active: z.boolean(),
    periodStart: z.number().int().nonnegative(),
    periodEnd: z.number().int().nonnegative(),
    messages: UsageAllowance,
    requests: UsageAllowance,
    storage: UsageAllowance,
    files: UsageAllowance,
    filesShareStorage: z.boolean(),
    rooms: UsageAllowance,
    agents: UsageAllowance,
    archivedBytes: z.number().nonnegative()
});
export type AccountUsage = z.infer<typeof AccountUsage>;
