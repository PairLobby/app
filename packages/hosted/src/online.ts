import {hashCredential, normalizeInviteCode} from '@pairlobby/protocol';
import {digest, fail, json} from './http';

export interface OnlineAccount {
    userId: string;
    email: string;
    workspaceId: string;
    teamId: string;
}

export async function tokenAccount(request: Request, env: Env): Promise<OnlineAccount | null> {
    const token = request.headers.get('x-pairlobby-account-token');
    if (!token) {
        return null;
    }
    const row = await env.DB.prepare(
        `SELECT t.user_id AS userId,lower(u.email) AS email,t.workspace_id AS workspaceId,t.team_id AS teamId
        FROM api_tokens t JOIN user u ON u.id=t.user_id JOIN members m ON m.workspace_id=t.workspace_id AND m.user_id=t.user_id
        WHERE t.digest=? AND t.expires_at>? AND u.emailVerified=1
        AND (m.role='owner' OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.team_id AND tm.user_id=t.user_id))`
    )
        .bind(await digest(token), Date.now())
        .first<OnlineAccount>();
    if (!row) {
        fail(401, 'Account login has expired or was revoked; run pairlobby login again');
    }
    return row;
}

export async function reserveOnlineInvite(env: Env, code: string, roomId: string, expiresAt: number | null, workspaceId: string, teamId: string) {
    const inserted = await env.DB.prepare('INSERT OR IGNORE INTO online_invites(digest,room_id,relay_path,workspace_id,team_id,expires_at) VALUES(?,?,?,?,?,?)')
        .bind(await hashCredential(normalizeInviteCode(code)!), roomId, `/relay/${workspaceId}/${teamId}`, workspaceId, teamId, expiresAt)
        .run();
    return inserted.meta.changes === 1;
}

export async function onlineRoute(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET') {
        fail(405, 'Use GET');
    }
    if (!(await env.PUBLIC_RATE_LIMIT.limit({key: request.headers.get('cf-connecting-ip') ?? 'local'})).success) {
        fail(429, 'Too many requests; try again in a minute');
    }
    const path = new URL(request.url).pathname;
    const account = await tokenAccount(request, env);
    if (path === '/api/online/account') {
        if (!account) {
            fail(401, 'Run pairlobby login with a token from /account');
        }
        return json({...account, server: `${env.APP_ORIGIN}/relay/${account.workspaceId}/${account.teamId}`});
    }
    const code = normalizeInviteCode(decodeURIComponent(path.slice('/api/online/invites/'.length)));
    if (!path.startsWith('/api/online/invites/') || !code) {
        fail(404, 'Invite not found');
    }
    const entry = await env.DB.prepare('SELECT * FROM online_invites WHERE digest=? AND (expires_at IS NULL OR expires_at>?)')
        .bind(await hashCredential(code), Date.now())
        .first<{room_id: string; relay_path: string; workspace_id: string | null; team_id: string | null}>();
    if (!entry) {
        fail(404, 'Invite not found or expired');
    }
    if (entry.workspace_id) {
        const access = await env.WORKSPACES.getByName(entry.workspace_id).checkOnlineJoin(entry.room_id, account?.userId ?? null);
        if (access.status !== 200) {
            fail(access.status, access.message);
        }
    }
    return json({server: env.APP_ORIGIN + entry.relay_path});
}
