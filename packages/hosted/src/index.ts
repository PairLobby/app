import {accountRoute} from './accounts';
import {createAuth} from './auth';
import {webhook} from './billing';
import {digest, fail, HttpError, json} from './http';
import {PLANS} from './plans';
export {Workspace} from './workspace';

export default {
    async scheduled(_event: ScheduledController, env: Env) {
        if (String(env.BILLING_ENABLED)!=='true' || !env.STRIPE_SECRET_KEY) return;
        const workspaces=await env.DB.prepare('SELECT id,subscription_id FROM workspaces WHERE subscription_id IS NOT NULL AND last_synced_at<? ORDER BY last_synced_at LIMIT 100').bind(Date.now()-3600_000).all<{id:string;subscription_id:string}>();
        for (const workspace of workspaces.results) {
            try {await env.WORKSPACES.getByName(workspace.id).reconcileBilling(workspace.id,workspace.subscription_id,`sync:${workspace.id}:${Math.floor(Date.now()/900_000)}`);}
            catch {console.error('billing_reconciliation_failed');}
        }
    },
    async fetch(original: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            const url = new URL(original.url);
            if (url.pathname === '/api/health') return json({service:'pairlobby',ready:true});
            if (url.pathname === '/api/plans') return json({currency:env.CURRENCY,plans:PLANS,signupEnabled:String(env.SIGNUPS_ENABLED)==='true',billingEnabled:String(env.BILLING_ENABLED)==='true'});
            const origin = original.headers.get('origin');
            if (origin && origin !== env.APP_ORIGIN) fail(403,'Origin is not allowed');
            // Bound actual streamed bytes, not the untrusted Content-Length header.
            let request = original;
            if (original.body) {
                const reader = original.body.getReader();
                const chunks: Uint8Array[] = [];
                let size = 0;
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    size += next.value.byteLength;
                    if (size > (url.pathname === '/api/billing/webhook' ? 512*1024 : 40*1024)) {
                        await reader.cancel(); fail(413,'Request body too large');
                    }
                    chunks.push(next.value);
                }
                const bytes = new Uint8Array(size); let offset=0;
                for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
                request = new Request(original,{body:bytes});
            }
            if (url.pathname === '/api/billing/webhook' && request.method === 'POST') return await webhook(request,env);
            if (url.pathname.startsWith('/api/auth/')) {
                const ip = original.headers.get('cf-connecting-ip') ?? 'local';
                if (!(await env.PUBLIC_RATE_LIMIT.limit({key:ip})).success) fail(429,'Too many requests; try again in a minute');
                if (url.pathname.startsWith('/api/auth/sign-up') && String(env.SIGNUPS_ENABLED)!=='true') fail(503,'Signup is not open yet');
                return await createAuth(env,ctx).handler(request);
            }
            if (url.pathname.startsWith('/api/')) {
                if (request.method !== 'GET' && (!origin || origin !== env.APP_ORIGIN)) fail(403,'Use the website to manage your account');
                return await accountRoute(request,env,ctx);
            }
            const match = /^\/relay\/([a-f0-9-]{36})\/([a-f0-9-]{36})(\/v1\/.*)$/.exec(url.pathname);
            if (!match) fail(404,'Endpoint not found');
            const workspaceId=match[1]!, teamId=match[2]!, path=match[3]!;
            const headers = new Headers(request.headers);
            // Internal claims always overwrite caller-supplied headers.
            headers.set('x-workspace-id',workspaceId);headers.set('x-team-id',teamId);headers.delete('x-can-create');
            const team = await env.DB.prepare('SELECT id FROM teams WHERE id=? AND workspace_id=?').bind(teamId,workspaceId).first();
            if (!team) fail(404,'Team not found');
            if (request.method === 'POST' && path === '/v1/rooms') {
                const token = request.headers.get('x-pairlobby-account-token') ?? '';
                const claim = await env.DB.prepare(`SELECT t.user_id FROM api_tokens t JOIN members m ON m.workspace_id=t.workspace_id AND m.user_id=t.user_id
                    WHERE t.digest=? AND t.workspace_id=? AND t.team_id=? AND t.expires_at>?
                    AND (m.role='owner' OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.team_id AND tm.user_id=t.user_id))`).bind(await digest(token),workspaceId,teamId,Date.now()).first();
                if (!claim) fail(401,'An account token for this team is required to create a hosted room');
                headers.set('x-can-create','true');
            }
            headers.delete('x-pairlobby-account-token');
            url.pathname = path;
            return await env.WORKSPACES.getByName(workspaceId).fetch(new Request(url,{
                method:request.method,headers,body:request.body,redirect:'manual',
            }));
        } catch (error) {
            if (error instanceof HttpError) return json({error:{code:error.status===429?'quota_exceeded':error.status===401?'unauthorized':'invalid_request',message:error.message}},error.status);
            if (error instanceof SyntaxError) return json({error:{code:'invalid_request',message:'Invalid JSON'}},400);
            console.error('api_request_failed');
            return json({error:{code:'server_unavailable',message:'The service could not complete this request'}},503);
        }
    },
} satisfies ExportedHandler<Env>;
