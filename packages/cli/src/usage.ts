import {formatFileSize} from '@pairlobby/protocol';
import type {AccountUsage, UsageAllowance} from '@pairlobby/protocol';

function allowanceLine(label: string, value: UsageAllowance, bytes = false): string {
    const format = bytes ? formatFileSize : (amount: number) => amount.toLocaleString();
    const remaining = Math.max(0, value.limit - value.used);
    const percent = value.limit > 0 ? Math.round(value.used / value.limit * 1000) / 10 : value.used > 0 ? 100 : 0;
    return `${label}: ${format(value.used)} / ${format(value.limit)} (${percent}%) · ${format(remaining)} remaining`;
}

/** Read-only account information. It is printed locally, never posted as a room message. */
export function usageReport(usage: AccountUsage): string {
    return [
        `PairLobby ${usage.plan.replace(/[\x00-\x1f\x7f]/g, '')} plan${usage.active ? '' : ' · inactive'} — ${JSON.stringify(usage.workspaceName ?? usage.workspaceId)}`,
        allowanceLine(usage.filesShareStorage ? 'Storage (messages + files)' : 'Message storage', usage.storage, true),
        ...(!usage.filesShareStorage ? [allowanceLine('File storage', usage.files, true)] : []),
        allowanceLine('Work events', usage.messages),
        allowanceLine('API requests', usage.requests),
        allowanceLine('Open rooms', usage.rooms),
        allowanceLine('Agents', usage.agents),
        ...(usage.archivedBytes ? [`Archived storage: ${formatFileSize(usage.archivedBytes)} (outside the active storage pool)`] : []),
        `Work events and API requests reset ${new Date(usage.periodEnd).toLocaleString()}.`,
        'Storage does not reset with the period. Delete stored files or rooms to free it.',
        'AI-provider tokens and credits are separate; PairLobby does not report their balance.'
    ].join('\n');
}
