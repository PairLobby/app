import type {LocalStore, PairLobbyClient, RoomAccountRestrictions} from '@pairlobby/client';
import type {AutoClosePolicy, RoomSnapshot} from '@pairlobby/protocol';
import {ProtocolError} from '@pairlobby/protocol';
import type {RoomPanelPage, RoomPanelRow, PanelEdit} from './room-panel.js';
import {parseExpiry} from './when.js';
import {AUTO_CLOSE_CHOICES, describeAutoClose, formatAutoClose, parseAutoClose} from './auto-close.js';
import {loadRoomStatus, roomStatusRows} from './room-status.js';

export type RoomSettingsContext = {client: PairLobbyClient; roomId: string; credential: string; participantId: string; controllerCredential?: string | undefined; store?: LocalStore};
type SettingsAccess = {room: RoomSnapshot; authority: string | undefined};

async function access(context: RoomSettingsContext): Promise<SettingsAccess> {
    const room = await context.client.snapshot(context.roomId, context.credential);
    const actor = room.participants.find((person) => person.participantId === context.participantId);
    const active = room.lifecycle === 'open' && actor && !actor.left && !actor.revoked && !actor.muted && actor.role !== 'guest';
    return {room, authority: active ? context.controllerCredential ?? (actor.role === 'controller' ? context.credential : undefined) : undefined};
}

async function change(context: RoomSettingsContext, apply: (authority: string) => Promise<unknown>): Promise<void> {
    const current = await access(context);
    if (!current.authority) {
        throw new ProtocolError('unauthorized', 'Only an active room owner or admin can change this setting.');
    }
    await apply(current.authority);
    const room = await context.client.snapshot(context.roomId, context.credential);
    const saved = context.store?.room(context.roomId);
    if (saved) {
        context.store!.upsertRoom({...saved, name: room.name, expiresAt: room.expiresAt});
    }
}

export async function statusPage(context: RoomSettingsContext): Promise<RoomPanelPage> {
    const status = await loadRoomStatus(context);
    return {id: 'status', title: `Room status — ${status.room.name}`, rows: roomStatusRows(status), note: 'Read-only snapshot · R refreshes · Enter copies the selected value · Dates are UTC.', reload: () => statusPage(context)};
}

export async function settingsPage(context: RoomSettingsContext): Promise<RoomPanelPage> {
    const {room, authority} = await access(context);
    const hosted = new URL(context.client.serverUrl).pathname.startsWith('/relay/');
    const rows: RoomPanelRow[] = [];
    const edit = (id: string, label: string, value: string, section: string, action: PanelEdit, supported = true) => {
        rows.push({id, label, value, section, hint: !authority ? 'Read only — owner or admin access is required.' : !supported ? 'Update this relay to edit this setting.' : action.hint, ...(authority && supported ? {action} : {})});
    };
    edit('name', 'Room name', room.name, 'Room', {kind: 'edit', initial: room.name, hint: '1–64 characters. This changes the room name, not your participant name.', save: async (value) => {
        const name = value.trim();
        if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) {
            throw new Error('Use a room name of 1–64 characters without control characters.');
        }
        if (name !== room.name) {
            await change(context, (owner) => context.client.rename(context.roomId, owner, name));
        }
    }});
    edit('turns', 'Reply mode', room.turnMode ?? 'Unsupported', 'Turns', {kind: 'edit', initial: room.turnMode ?? 'sequential', choices: [{label: 'Sequential — one agent answers at a time', value: 'sequential'}, {label: 'Parallel — different agents can work together', value: 'parallel'}], hint: 'Parallel still processes one request at a time per agent; it does not interrupt current work.', save: (value) => change(context, (owner) => context.client.setTurnMode(context.roomId, owner, value === 'parallel' ? 'parallel' : 'sequential'))}, Boolean(room.groupTurnsSupported));
    edit('expiry', 'Expiry', room.expiresAt === null ? 'Never' : new Date(room.expiresAt).toISOString(), 'Room', {kind: 'edit', initial: room.expiresAt === null ? 'never' : `at ${new Date(room.expiresAt).toISOString()}`, choices: [{label: 'Never expire', value: 'never'}, {label: 'In 1 hour', value: 'in 1 hour'}, {label: 'In 24 hours', value: 'in 24 hours'}, {label: 'In 7 days', value: 'in 7 days'}, {label: 'Custom duration or date…', value: 'custom', custom: true}], hint: 'Examples: never, in 10 hours, at 2026-10-01 18:00. Custom dates use your local timezone unless specified.', save: async (value) => {
        const expiresAt = parseExpiry(value);
        if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) {
            throw new Error('Expiry must be a future time, or never.');
        }
        await change(context, (owner) => context.client.setExpiry(context.roomId, owner, expiresAt));
    }});
    const autoClose = room.policy.autoClose ?? {mode: 'off' as const};
    const closes = room.autoCloseAt ? ` · closes ${new Date(room.autoCloseAt).toLocaleString()}` : autoClose.mode === 'agents_and_guests_left' && !room.autoCloseArmed ? ' · waiting for an agent or guest to join' : '';
    edit('auto-close', 'Auto-close discussion', `${describeAutoClose(autoClose)}${closes}`, 'Lifecycle', {kind: 'edit', initial: formatAutoClose(autoClose), choices: AUTO_CLOSE_CHOICES, hint: 'Closing keeps history readable and exportable; it does not stop agent processes or undo work already started. Custom: idle:<duration> or age:<duration>, e.g. idle:90m.', confirm: (value) => closesNow(room, parseAutoClose(value)) ? `${describeAutoClose(parseAutoClose(value))}: this room is already past that limit and will close immediately. Continue?` : `Set auto-close to: ${describeAutoClose(parseAutoClose(value)).toLowerCase()}?`, save: (value) => change(context, (owner) => context.client.setAutoClose(context.roomId, owner, parseAutoClose(value)))}, Boolean(room.autoCloseSupported));
    edit('privacy', 'Guest access', room.policy.joinPolicy === 'invite_only' ? 'Invite only' : 'Anyone with room ID (read only)', 'Privacy', {kind: 'edit', initial: room.policy.joinPolicy, choices: [{label: 'Invite only — require an invitation', value: 'invite_only'}, {label: 'Anyone with room ID may read as a guest', value: 'open_to_guests'}], hint: 'Guest access controls reading. Guests cannot send messages or invite others. Existing memberships remain.', confirm: (value) => value === 'open_to_guests' ? 'Allow anyone who knows this room ID to read its retained transcript as a guest?' : 'Require invitations for new guests? Existing members and guests remain.', save: (value) => change(context, (owner) => context.client.setJoinPolicy(context.roomId, owner, value === 'open_to_guests' ? 'open_to_guests' : 'invite_only'))});
    edit('invites', 'Invitations', room.policy.inviteRole === 'guest' ? 'Read-only observers' : 'Members who can speak', 'Privacy', {kind: 'edit', initial: room.policy.inviteRole ?? 'member', choices: [{label: 'Members — invitees can send messages', value: 'member'}, {label: 'Read-only observers — invitees can only read', value: 'guest'}], hint: 'What a plain /invite admits. /invite member and /invite observer still choose explicitly. Existing invites keep their role.', save: (value) => change(context, (owner) => context.client.setInviteRole(context.roomId, owner, value === 'guest' ? 'guest' : 'member'))}, Boolean(room.inviteRoleSupported));
    edit('lock', 'Admission lock', room.locked ? 'Locked' : 'Unlocked', 'Privacy', {kind: 'edit', initial: room.locked ? 'locked' : 'unlocked', choices: [{label: 'Unlocked — normal admission policy', value: 'unlocked'}, {label: 'Locked — block joins, rejoins and new invites', value: 'locked'}], hint: 'A lock blocks admission but does not remove current members.', save: (value) => change(context, (owner) => context.client.setLocked(context.roomId, owner, value === 'locked'))});
    rows.push({id: 'members', label: 'Admins and members', value: `${room.participants.filter((person) => !person.left && !person.revoked).length} joined`, section: 'Admin', action: {kind: 'menu', load: () => membersPage(context)}});
    if (room.groupTurnsSupported) {
        rows.push({id: 'queue', label: 'Speaking queue', value: 'Inspect, skip or cancel turns', section: 'Turns', action: {kind: 'menu', load: () => turnsPage(context)}});
    }
    rows.push({id: 'permission', label: 'Your access', value: authority ? context.controllerCredential ? 'Owner' : 'Admin' : 'Read only', section: 'Admin', hint: 'Admins manage settings and members. The owner retains control when admin roles change.'});
    if (hosted) {
        const guestAccess = rows.find((row) => row.id === 'privacy')!;
        delete guestAccess.action;
        guestAccess.hint = 'Hosted rooms require invitations. Account restrictions are configured below.';
        let restrictions: RoomAccountRestrictions | undefined;
        if (authority && context.controllerCredential) {
            try { restrictions = await context.client.accountRestrictions(context.roomId, context.controllerCredential); } catch {}
        }
        if (!restrictions) {
            rows.push({id: 'hosted-privacy', label: 'Account restrictions', value: 'Unavailable / owner access required', section: 'Hosted'});
        } else {
            edit('hosted-privacy', 'Account restrictions', restrictions.private ? 'Allowlist enabled' : 'No account restriction', 'Hosted', {kind: 'edit', initial: restrictions.private ? 'private' : 'open', choices: [{label: 'Require an allowed account', value: 'private'}, {label: 'No account restriction (admission policy still applies)', value: 'open'}], hint: 'The saved account allowlist is preserved when toggling this setting. The room owner keeps access.', confirm: (value) => `Set account restrictions to ${value === 'private' ? 'allowlist only' : 'off'}? Invitation and guest rules still apply.`, save: (value) => change(context, () => context.client.setAccountRestrictions(context.roomId, context.controllerCredential!, value === 'private'))}, Boolean(restrictions.preserveAllowlistSupported));
            edit('allowed-accounts', 'Replace allowlist', `${restrictions.accounts.length} accounts (owner included)`, 'Hosted', {kind: 'edit', initial: '', hint: 'Enter the complete replacement list of verified account emails, separated by commas. Blank means owner only.', confirm: (value) => `Replace the allowed accounts with ${value.trim() || 'owner only'}? The owner is always retained.`, save: (value) => change(context, () => context.client.setAccountRestrictions(context.roomId, context.controllerCredential!, restrictions!.private, value.split(',').map((email) => email.trim()).filter(Boolean)))});
        }
    }
    rows.push({id: 'status', label: 'Room status', value: 'Counts, activity and dates', section: 'Inspect', action: {kind: 'menu', load: () => statusPage(context)}});
    return {id: 'settings', title: `Room settings — ${room.name}`, rows, note: authority ? 'Select a setting and press Enter. Esc cancels unsaved edits.' : 'Read-only settings. Ask the room owner for admin access.', reload: () => settingsPage(context)};
}

/** Whether applying `policy` would close the room at once, so the change can be confirmed as such. */
function closesNow(room: RoomSnapshot, policy: AutoClosePolicy): boolean {
    const now = Date.now();
    const present = room.participants.filter((person) => !person.left && !person.revoked);
    switch (policy.mode) {
        case 'inactivity':             return (room.lastMessageAt ?? room.createdAt) + policy.afterMs <= now;
        case 'age':                    return room.createdAt + policy.afterMs <= now;
        case 'agents_and_guests_left': return Boolean(room.autoCloseArmed) && !present.some((person) => person.kind === 'agent' || person.role === 'guest');
        case 'off':                    return false;
    }
}

async function turnsPage(context: RoomSettingsContext): Promise<RoomPanelPage> {
    const {authority} = await access(context);
    const queue = await context.client.turnQueue(context.roomId, context.credential);
    const rows: RoomPanelRow[] = [];
    for (const entry of queue.entries) {
        rows.push({id: entry.requestId, label: entry.name, value: `${entry.state} · ${entry.requestId}`, section: 'Queue', hint: `Round ${entry.conversationId}`});
        if (authority && entry.state !== 'failed') {
            rows.push({id: `skip-${entry.requestId}`, label: 'Skip this turn', value: entry.name, section: 'Controls', action: {kind: 'command', confirm: `Skip ${entry.name}’s turn? Late output from that turn will be rejected; this does not interrupt external tools.`, run: () => change(context, (owner) => context.client.controlTurn(context.roomId, owner, {action: 'skip', requestId: entry.requestId}))}});
            rows.push({id: `cancel-${entry.requestId}`, label: 'Cancel this round', value: entry.conversationId, section: 'Controls', action: {kind: 'command', confirm: 'Cancel the whole response round? Other queued agents in that round will not answer.', run: () => change(context, (owner) => context.client.controlTurn(context.roomId, owner, {action: 'cancel', requestId: entry.requestId}))}});
        }
    }
    if (!rows.length) {
        rows.push({id: 'empty', label: 'Speaking queue', value: 'Ready — no pending turns', section: 'Queue'});
    }
    return {id: 'turns', title: `Speaking queue — ${queue.mode}`, rows, note: 'Failed entries describe previous requests. They are not active work.', reload: () => turnsPage(context)};
}

async function membersPage(context: RoomSettingsContext): Promise<RoomPanelPage> {
    const {room} = await access(context);
    return {id: 'members', title: 'Admins and members', rows: room.participants.filter((person) => !person.left && !person.revoked).map((person) => ({id: person.participantId, label: person.displayName, value: `${person.role === 'controller' ? 'Admin' : person.role === 'guest' ? 'Observer' : 'Member'} · ${person.kind}${person.muted ? ' · muted' : ''}${person.paused ? ' · paused' : ''}`, section: 'Members', action: {kind: 'menu', load: () => memberPage(context, person.participantId)}})), note: 'Enter opens a member’s controls. Names are labels; actions use participant IDs.', reload: () => membersPage(context)};
}

async function memberPage(context: RoomSettingsContext, id: string): Promise<RoomPanelPage> {
    const {room, authority} = await access(context);
    const person = room.participants.find((member) => member.participantId === id && !member.left && !member.revoked);
    if (!person) {
        throw new Error('This participant is no longer in the room. Refresh the member list.');
    }
    const rows: RoomPanelRow[] = [{id: 'id', label: 'Participant ID', value: id, section: 'Identity'}, {id: 'role', label: 'Admin access', value: person.role === 'controller' ? 'Admin' : person.role === 'guest' ? 'Observer' : 'Member', section: 'Admin'}];
    if (authority && room.adminRolesSupported && person.role !== 'guest') {
        rows[1]!.action = {kind: 'edit', initial: person.role, choices: [{label: 'Member — ordinary participation', value: 'member'}, {label: 'Admin — manage room settings and members', value: 'controller'}], hint: 'Admin rights include changing settings, managing members and granting admin access. The owner retains control.', confirm: (value) => `${value === 'controller' ? 'Grant' : 'Remove'} admin access for ${person.displayName}?`, save: (value) => change(context, (owner) => context.client.setRole(context.roomId, owner, id, value === 'controller' ? 'controller' : 'member'))};
    }
    rows[1]!.hint = room.adminRolesSupported ? 'Read-only observers must be invited as members before they can become admins.' : 'Update this relay to change admin roles.';
    const control = (key: string, label: string, value: string, confirm: string, run: (owner: string) => Promise<unknown>) => rows.push({id: key, label, value, section: 'Controls', ...(authority ? {action: {kind: 'command' as const, confirm, run: () => change(context, run)}} : {hint: 'Owner or admin access required.'})});
    control('mute', person.muted ? 'Unmute' : 'Mute', person.muted ? 'Muted' : 'Can write', `${person.muted ? 'Unmute' : 'Mute'} ${person.displayName}? Reading and receipts continue.`, (owner) => context.client.setMuted(context.roomId, owner, id, !person.muted));
    if (person.kind === 'agent' && room.interruptSupported && !person.paused) {
        control('interrupt', 'Interrupt current task', 'Stop the turn it is running', `Interrupt ${person.displayName}? Its current task stops and cannot post an answer; its queued requests wait until you resume it. Edits or commands already carried out are not undone.`, (owner) => context.client.interrupt(context.roomId, owner, id));
    }
    if (person.kind === 'agent') {
        control('pause', person.paused ? 'Resume requests' : 'Pause requests', person.paused ? 'Paused' : 'Accepting requests', `${person.paused ? 'Resume' : 'Pause'} ${person.displayName}? This does not verify interruption of tools already running.`, (owner) => context.client.control(context.roomId, owner, id, !person.paused));
    }
    if (id !== context.participantId) {
        control('kick', 'Remove from room', 'Kick participant', `Remove ${person.displayName}? Their credential and invite seat will no longer grant access.`, (owner) => context.client.revoke(context.roomId, owner, id));
    }
    return {id: `member-${id}`, title: `Member — ${person.displayName}`, rows, note: authority ? 'Select a control. Changes require confirmation.' : 'Read-only member details.', reload: async () => {
        const updated = await context.client.snapshot(context.roomId, context.credential);
        return updated.participants.some((member) => member.participantId === id && !member.left && !member.revoked) ? memberPage(context, id) : membersPage(context);
    }};
}
