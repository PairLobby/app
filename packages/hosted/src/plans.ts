export const MiB = 1024 * 1024;
export const PLANS = {
    dev: {priceCents: 300, people: 1, teams: 1, agents: 8, rooms: 3, messages: 20_000, requests: 200_000, storageBytes: 128 * MiB, retentionDays: 7},
    team: {priceCents: 1000, people: 5, teams: 1, agents: 40, rooms: 10, messages: 80_000, requests: 1_000_000, storageBytes: 640 * MiB, retentionDays: 30},
    enterprise: {priceCents: 9900, people: 25, teams: 5, agents: 200, rooms: 50, messages: 1_000_000, requests: 5_000_000, storageBytes: 5120 * MiB, retentionDays: 30},
} as const;
export type Plan = keyof typeof PLANS;
export function isPlan(value: unknown): value is Plan { return typeof value === 'string' && Object.hasOwn(PLANS, value); }
