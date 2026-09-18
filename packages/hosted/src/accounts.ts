import {createAuth} from './auth';
import {body, digest, fail, json, secret, textField} from './http';
import {isPlan, PLANS} from './plans';
import {portal, usageCheckout} from './billing';

export interface Account {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
}
export interface WorkspaceRecord {
    id: string;
    name: string;
    owner_id: string;
    plan: string | null;
    status: string;
    customer_id: string | null;
    subscription_id: string | null;
    period_start: number;
    period_end: number;
}
export async function sessionUser(request: Request, env: Env, ctx: ExecutionContext): Promise<Account> {
    const session = await createAuth(env, ctx).api.getSession({headers: request.headers});
    if (!session?.user || !session.user.emailVerified) {
        fail(401, 'Sign in with a verified email address');
    }
    return session.user;
}
export async function workspaceFor(env: Env, id: string, user: Account, owner = false): Promise<WorkspaceRecord> {
    const row = await env.DB.prepare('SELECT w.* FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?').bind(id, user.id).first<WorkspaceRecord>();
    if (!row || (owner && row.owner_id !== user.id)) {
        fail(403, 'Workspace access denied');
    }
    return row;
}
export function paid(workspace: WorkspaceRecord) {
    return isPlan(workspace.plan) && workspace.status === 'active' && workspace.period_end > Date.now();
}
export async function accountRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const user = await sessionUser(request, env, ctx);
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    const db = env.DB;
    if (path[1] === 'account' && request.method === 'GET') {
        const workspaces = await db.prepare('SELECT w.* FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=?').bind(user.id).all<WorkspaceRecord>();
        return json({user: {id: user.id, name: user.name, email: user.email}, workspaces: workspaces.results});
    }
    if (path[1] === 'accept-invite' && request.method === 'POST') {
        const input = await body(request);
        const hash = await digest(textField(input.token, 'invite', 256));
        const invitation = await db
            .prepare('SELECT * FROM member_invites WHERE digest=? AND email=? AND expires_at>?')
            .bind(hash, user.email.toLowerCase(), Date.now())
            .first<{workspace_id: string; team_id: string}>();
        if (!invitation) {
            fail(404, 'Invitation is invalid, expired, or belongs to a different email');
        }
        const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').bind(invitation.workspace_id).first<WorkspaceRecord>();
        if (!workspace || !paid(workspace) || !isPlan(workspace.plan)) {
            fail(402, 'An active plan is required');
        }
        const seats = PLANS[workspace.plan].people;
        // One conditional write serializes seat allocation in D1. Team enrollment
        // only happens if the seat exists, including idempotent acceptance retries.
        await db.batch([
            db
                .prepare("INSERT OR IGNORE INTO members(workspace_id,user_id,role) SELECT ?,?,'member' WHERE (SELECT COUNT(*) FROM members WHERE workspace_id=?) < ?")
                .bind(workspace.id, user.id, workspace.id, seats),
            db
                .prepare('INSERT OR IGNORE INTO team_members(team_id,user_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND user_id=?)')
                .bind(invitation.team_id, user.id, workspace.id, user.id)
        ]);
        const member = await db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').bind(workspace.id, user.id).first();
        if (!member) {
            fail(409, 'This plan has no available account seats');
        }
        await db.prepare('DELETE FROM member_invites WHERE digest=?').bind(hash).run();
        return json({workspaceId: workspace.id});
    }
    if (path[1] !== 'workspaces') {
        fail(404, 'Unknown account endpoint');
    }
    if (path.length === 2 && request.method === 'POST') {
        const name = textField((await body(request)).name, 'workspace name');
        const id = crypto.randomUUID();
        const team = crypto.randomUUID();
        await db.batch([
            db.prepare('INSERT INTO workspaces(id,name,owner_id,created_at) VALUES(?,?,?,?)').bind(id, name, user.id, Date.now()),
            db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'owner')").bind(id, user.id),
            db.prepare('INSERT INTO teams(id,workspace_id,name) VALUES(?,?,?)').bind(team, id, name),
            db.prepare('INSERT INTO team_members(team_id,user_id) VALUES(?,?)').bind(team, user.id)
        ]);
        return json({id}, 201);
    }
    const id = path[2];
    if (!id) {
        fail(404, 'Workspace not found');
    }
    const workspace = await workspaceFor(env, id, user, request.method !== 'GET' && ['checkout', 'portal', 'usage', 'members', 'invites', 'teams'].includes(path[3] ?? ''));
    if (path.length === 3 && request.method === 'GET') {
        const owner = workspace.owner_id === user.id;
        const [teams, members, tokens] = await Promise.all([
            db
                .prepare('SELECT t.* FROM teams t WHERE t.workspace_id=? AND (? OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=?))')
                .bind(id, owner ? 1 : 0, user.id)
                .all(),
            db.prepare('SELECT u.id,u.name,u.email,m.role FROM members m JOIN user u ON u.id=m.user_id WHERE m.workspace_id=?').bind(id).all(),
            db.prepare('SELECT digest,label,team_id,expires_at FROM api_tokens WHERE workspace_id=? AND user_id=?').bind(id, user.id).all()
        ]);
        return json({workspace, teams: teams.results, members: members.results, tokens: tokens.results, usage: await env.WORKSPACES.getByName(id).usage()});
    }
    if (path[3] === 'checkout' && request.method === 'POST') {
        const input = await body(request);
        if (!isPlan(input.plan)) {
            fail(400, 'Unknown plan');
        }
        return json({url: await env.WORKSPACES.getByName(workspace.id).startCheckout(workspace.id, user, input.plan)});
    }
    if (path[3] === 'usage' && request.method === 'POST') {
        return json({url: await usageCheckout(env, workspace, Number((await body(request)).blocks))});
    }
    if (path[3] === 'portal' && request.method === 'POST') {
        return json({url: await portal(env, workspace)});
    }
    if (path[3] === 'members' && path[4] && request.method === 'DELETE') {
        if (path[4] === workspace.owner_id) {
            fail(400, 'The billing owner cannot be removed');
        }
        await db.batch([
            db.prepare('DELETE FROM api_tokens WHERE workspace_id=? AND user_id=?').bind(id, path[4]),
            db.prepare('DELETE FROM team_members WHERE user_id=? AND team_id IN(SELECT id FROM teams WHERE workspace_id=?)').bind(path[4], id),
            db.prepare('DELETE FROM members WHERE workspace_id=? AND user_id=?').bind(id, path[4])
        ]);
        return json({ok: true});
    }
    if (!paid(workspace) || !isPlan(workspace.plan)) {
        fail(402, 'Choose an active subscription first');
    }
    const plan = PLANS[workspace.plan];
    if (path[3] === 'teams' && request.method === 'POST') {
        const name = textField((await body(request)).name, 'team name');
        const team = crypto.randomUUID();
        const inserted = await db
            .prepare('INSERT INTO teams(id,workspace_id,name) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM teams WHERE workspace_id=?) < ?')
            .bind(team, id, name, id, plan.teams)
            .run();
        if (!inserted.meta.changes) {
            fail(409, 'Team limit reached');
        }
        await db.prepare('INSERT INTO team_members(team_id,user_id) VALUES(?,?)').bind(team, user.id).run();
        return json({id: team}, 201);
    }
    if (path[3] === 'invites' && request.method === 'POST') {
        const input = await body(request);
        const email = textField(input.email, 'email', 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            fail(400, 'Invalid email');
        }
        const team = await db.prepare('SELECT id FROM teams WHERE id=? AND workspace_id=?').bind(textField(input.teamId, 'team'), id).first<{id: string}>();
        if (!team) {
            fail(404, 'Team not found');
        }
        await db.prepare('DELETE FROM member_invites WHERE workspace_id=? AND expires_at<=?').bind(id, Date.now()).run();
        const pending = await db.prepare('SELECT count(*) AS n FROM member_invites WHERE workspace_id=?').bind(id).first<{n: number}>();
        if ((pending?.n ?? 0) >= 50) {
            fail(429, 'Too many pending invitations');
        }
        const token = secret();
        await db
            .prepare('INSERT INTO member_invites(digest,workspace_id,team_id,email,expires_at) VALUES(?,?,?,?,?)')
            .bind(await digest(token), id, team.id, email, Date.now() + 7 * 86400_000)
            .run();
        return json({url: `${env.APP_ORIGIN}/account?invite=${token}`}, 201);
    }
    if (path[3] === 'tokens' && request.method === 'POST') {
        const input = await body(request);
        const team = await db
            .prepare('SELECT t.id FROM teams t WHERE t.id=? AND t.workspace_id=? AND (? OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=?))')
            .bind(textField(input.teamId, 'team'), id, workspace.owner_id === user.id ? 1 : 0, user.id)
            .first<{id: string}>();
        if (!team) {
            fail(404, 'Team not found');
        }
        const token = `pl_${secret()}`;
        const inserted = await db
            .prepare(
                'INSERT INTO api_tokens(digest,user_id,workspace_id,team_id,label,created_at,expires_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM api_tokens WHERE user_id=? AND expires_at>?)<20'
            )
            .bind(await digest(token), user.id, id, team.id, textField(input.label, 'token name'), Date.now(), Date.now() + 90 * 86400_000, user.id, Date.now())
            .run();
        if (!inserted.meta.changes) {
            fail(409, 'Token limit reached; revoke an old token');
        }
        return json({token, server: `${env.APP_ORIGIN}/relay/${id}/${team.id}`}, 201);
    }
    if (path[3] === 'tokens' && path[4] && request.method === 'DELETE') {
        await db.prepare('DELETE FROM api_tokens WHERE digest=? AND workspace_id=? AND user_id=?').bind(path[4], id, user.id).run();
        return json({ok: true});
    }
    fail(404, 'Unknown workspace endpoint');
}
