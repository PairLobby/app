import type Stripe from 'stripe';
import {DurableObject} from 'cloudflare:workers';
import {PROTOCOL_VERSION_HEADER, DEFAULT_ROOM_POLICY, CreateRoomRequest, RedeemInviteRequest, ProtocolError, hashCredential, isQuotaExempt, payloadBytes, normalizeInviteCode} from '@pairlobby/protocol';
import type {RoomEvent, RoomRecord} from '@pairlobby/protocol';
import {authenticate, toSnapshot} from '@pairlobby/room-core';
import type {Mutation} from '@pairlobby/room-core';
import {RoomService, createRouter} from '@pairlobby/server-core';
import {HostedRoomStore} from './store';
import {PLANS, isPlan} from './plans';
import {digest, fail, HttpError, json, secret} from './http';
import type {Account, WorkspaceRecord} from './accounts';
import type {Plan} from './plans';
import {checkout, prices, stripeClient} from './billing';

export class Workspace extends DurableObject<Env> {
    private readonly store: HostedRoomStore;
    private readonly service: RoomService;
    private queue: Promise<unknown> = Promise.resolve();
    private current: WorkspaceRecord | null = null;
    private emitted: RoomEvent[] = [];

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx,env);
        this.store = new HostedRoomStore(ctx.storage, mutation => this.meter(mutation));
        this.service = new RoomService(this.store);
        ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS hosted_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS room_teams(room_id TEXT PRIMARY KEY,team_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage(period INTEGER PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, system_events INTEGER NOT NULL DEFAULT 0, receipts INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS tickets(digest TEXT PRIMARY KEY,room_id TEXT NOT NULL,credential TEXT NOT NULL,expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS reconciled_events(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS bursts(second INTEGER PRIMARY KEY,events INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS exports(hour INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS usage_grants(session_id TEXT PRIMARY KEY,period INTEGER NOT NULL,blocks INTEGER NOT NULL);
        `);
        if(!ctx.storage.sql.exec<{name:string}>('PRAGMA table_info(usage)').toArray().some(column=>column.name==='replies')) ctx.storage.sql.exec('ALTER TABLE usage ADD COLUMN replies INTEGER NOT NULL DEFAULT 0');
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
    }
    private serial<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }
    async usage() {
        const usage=this.ctx.storage.sql.exec<{period:number;messages:number;requests:number}>('SELECT * FROM usage ORDER BY period DESC LIMIT 1').toArray()[0] ?? {period:0,messages:0,requests:0};
        return {...usage,extraBlocks:this.extraBlocks(usage.period)};
    }
    private extraBlocks(period: number) {return this.ctx.storage.sql.exec<{n:number}>('SELECT coalesce(sum(blocks),0) AS n FROM usage_grants WHERE period=?',period).one().n;}
    private limits(workspace: WorkspaceRecord) {
        const base=PLANS[isPlan(workspace.plan)?workspace.plan:'dev'];
        const extra=workspace.plan==='enterprise'?this.extraBlocks(workspace.period_start):0;
        return {...base,messages:base.messages+extra*100_000,requests:base.requests+extra*500_000,storageBytes:base.storageBytes};
    }
    async startCheckout(workspaceId: string, user: Account, plan: Plan) {
        return this.serial(async()=>{
            const workspace=await this.env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(workspaceId).first<WorkspaceRecord>();
            if (!workspace || workspace.owner_id!==user.id) fail(403,'Only the billing owner can subscribe');
            return checkout(this.env,workspace,user,plan);
        });
    }
    async reconcileUsage(workspaceId: string, sessionId: string) {
        return this.serial(async()=>{
            const stripe=stripeClient(this.env);
            const checkout=await stripe.checkout.sessions.retrieve(sessionId,{expand:['payment_intent.latest_charge']});
            const workspace=await this.env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(workspaceId).first<WorkspaceRecord>();
            const customer=typeof checkout.customer==='string'?checkout.customer:checkout.customer?.id;
            if (!workspace || customer!==workspace.customer_id || checkout.metadata?.workspaceId!==workspaceId || checkout.metadata.kind!=='usage') fail(403,'Usage purchase does not match workspace');
            const blocks=Number(checkout.metadata.blocks);const period=Number(checkout.metadata.period);
            if (!Number.isInteger(blocks)||blocks<1||blocks>10||!Number.isFinite(period)||checkout.mode!=='payment'||checkout.currency!==this.env.CURRENCY||checkout.amount_total!==blocks*1000) fail(400,'Invalid usage purchase');
            if (checkout.payment_status!=='paid') return;
            const intent=checkout.payment_intent as Stripe.PaymentIntent;
            const charge=typeof intent.latest_charge==='object'?intent.latest_charge:null;
            // Any refunded block is removed; never grant capacity for refunded money.
            const granted=Math.max(0,blocks-Math.ceil((charge?.amount_refunded ?? 0)/1000));
            this.ctx.storage.sql.exec('INSERT INTO usage_grants(session_id,period,blocks) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET blocks=excluded.blocks',checkout.id,period,granted);
        });
    }
    async reconcileBilling(workspaceId: string, subscriptionId: string, eventId: string) {
        return this.serial(async () => {
            if (this.ctx.storage.sql.exec('SELECT id FROM reconciled_events WHERE id=?',eventId).toArray().length) return;
            const workspace = await this.env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(workspaceId).first<WorkspaceRecord>();
            if (!workspace) fail(404,'Workspace not found');
            const subscription = await stripeClient(this.env).subscriptions.retrieve(subscriptionId);
            const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
            if (workspace.customer_id !== customer || subscription.metadata.workspaceId !== workspaceId) fail(403,'Subscription does not match workspace');
            if (workspace.subscription_id && workspace.subscription_id !== subscriptionId) {
                const previous = await stripeClient(this.env).subscriptions.retrieve(workspace.subscription_id);
                if (!['canceled','incomplete_expired'].includes(previous.status)) fail(409,'Another subscription is already linked');
            }
            const item = subscription.items.data[0];
            const plan = Object.entries(prices(this.env)).find(([,id]) => id && id === item?.price.id)?.[0] ?? null;
            const status = isPlan(plan) && subscription.items.data.length === 1 && item?.quantity === 1 && item.price.unit_amount===PLANS[plan].priceCents && item.price.currency===this.env.CURRENCY && item.price.recurring?.interval==='month' && item.price.recurring.interval_count===1 ? subscription.status : 'inactive';
            await this.env.DB.prepare('UPDATE workspaces SET plan=?,status=?,subscription_id=?,period_start=?,period_end=?,last_synced_at=? WHERE id=?').bind(plan,status,subscription.id,(item?.current_period_start ?? 0)*1000,(item?.current_period_end ?? 0)*1000,Date.now(),workspaceId).run();
            this.ctx.storage.sql.exec('INSERT INTO reconciled_events(id,at) VALUES(?,?)',eventId,Date.now());
            this.ctx.storage.sql.exec("INSERT OR REPLACE INTO hosted_meta(key,value) VALUES('workspace',?)",workspaceId);
            if (status !== 'active') for (const ws of this.ctx.getWebSockets()) ws.close(1008,'Subscription is inactive');
        });
    }
    override async fetch(request: Request): Promise<Response> {
        return this.serial(async () => {
            try { return await this.handle(request); }
            catch (error) {
                if (error instanceof ProtocolError) return json({error:{code:error.code,message:error.message,...error.details}},error.httpStatus);
                if (error instanceof HttpError) return json({error:{code:error.status===429?'quota_exceeded':'invalid_request',message:error.message}},error.status);
                if (error instanceof Error && error.name === 'ZodError') return json({error:{code:'invalid_request',message:'Invalid room request'}},400);
                console.error('workspace_request_failed');
                return json({error:{code:'server_unavailable',message:'The room could not complete this request'}},503);
            } finally { this.current = null; this.emitted = []; }
        });
    }
    private async handle(request: Request): Promise<Response> {
        const version=request.headers.get(PROTOCOL_VERSION_HEADER);
        if (version!==null && version!=='1') throw new ProtocolError('protocol_version_unsupported','This server speaks protocol version 1');
        const workspaceId = request.headers.get('x-workspace-id')!;
        const teamId = request.headers.get('x-team-id')!;
        const workspace = await this.env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(workspaceId).first<WorkspaceRecord>();
        if (!workspace) fail(404,'Workspace not found');
        this.current = workspace;
        const active = isPlan(workspace.plan) && workspace.status === 'active' && workspace.period_end > Date.now();
        const plan = this.limits(workspace);
        const url = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean);
        const roomId = parts[2];
        const action = parts[3];
        const controlAck=request.method==='POST' && action==='events' && (await request.clone().json() as {type?:string}).type==='control.ack';
        const control = controlAck || request.method === 'DELETE' || ['control','close','leave','export'].includes(action ?? '');
        if (!active && !control && request.method !== 'GET') fail(402,'An active subscription is required');
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO hosted_meta(key,value) VALUES('workspace',?)",workspaceId);
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()+3600_000);

        if (request.method === 'POST' && url.pathname === '/v1/rooms') {
            if (request.headers.get('x-can-create') !== 'true') fail(401,'Create rooms with an account token from /account');
            this.chargeRequest(workspace,false);
            const input = CreateRoomRequest.parse(await request.json());
            const count = this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM rooms WHERE json_extract(body,'$.lifecycle')='open' AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?)",Date.now()).one().n;
            if (count >= plan.rooms) fail(429,'Concurrent room limit reached');
            this.checkParticipants(input.kind);
            const policy = {...DEFAULT_ROOM_POLICY,maxParticipants:Math.min(plan.people+plan.agents,workspace.plan==='enterprise'?32:16),maxRetainedEventBytes:Math.min(plan.storageBytes,32*1024*1024),maxRetainedEvents:plan.messages,roomLifetimeMs:null,inviteLifetimeMs:86400_000};
            const created = await this.service.createRoom({...input,policy});
            this.ctx.storage.sql.exec('INSERT INTO room_teams(room_id,team_id) VALUES(?,?)',created.roomId,teamId);
            return json({room:created.snapshot,participantId:created.participantId,invite:created.invite},201);
        }
        if (url.pathname === '/v1/invites/redeem' && request.method === 'POST') {
            const input = RedeemInviteRequest.parse(await request.clone().json());
            const normalized = normalizeInviteCode(input.code);
            if (!normalized) fail(404,'Invalid invite');
            const invite = await this.store.inviteByDigest(await hashCredential(normalized));
            if (!invite || !this.inTeam(invite.roomId,teamId)) fail(404,'Invite not found in this team');
            this.chargeRequest(workspace,false);
            const previous = await this.store.participantByCredential(invite.roomId,await hashCredential(input.participantCredential));
            if (!previous) this.checkParticipants(input.kind);
        } else {
            if (!roomId || !this.inTeam(roomId,teamId)) fail(404,'Room not found in this team');
            if (action === 'guests') fail(403,'Hosted rooms require an invite');
            if (action === 'access') fail(403,'Hosted rooms are invite-only');
            if (action === 'connect') return this.connectSocket(request,roomId,active);
            const credential = request.headers.get('authorization')?.replace(/^Bearer /,'');
            if (!credential) fail(401,'Room credential required');
            const view = await this.store.loadRoom(roomId);
            if (!view) fail(404,'Room not found');
            authenticate(view,await hashCredential(credential),Date.now());
            this.chargeRequest(workspace,control);
            if (action === 'export' && request.method === 'GET') return this.streamExport(roomId,toSnapshot(view),await this.store.handovers(roomId));
            if (action === 'connect-ticket' && request.method === 'POST') {
                if (!active) fail(402,'An active subscription is required');
                const ticket = secret();
                this.ctx.storage.sql.exec('DELETE FROM tickets WHERE expires<=?',Date.now());
                this.ctx.storage.sql.exec('DELETE FROM reconciled_events WHERE at<?',Date.now()-93*86400_000);
                this.ctx.storage.sql.exec('DELETE FROM usage_grants WHERE period<?',Date.now()-93*86400_000);
                if (this.ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM tickets').one().n > plan.agents+plan.people) fail(429,'Too many connection attempts');
                this.ctx.storage.sql.exec('INSERT INTO tickets VALUES(?,?,?,?)',await digest(ticket),roomId,credential,Date.now()+30_000);
                return json({ticket,expiresAt:Date.now()+30_000});
            }
            if (action === 'invites') {
                const count = this.ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM invites').one().n;
                if (count >= (plan.agents+plan.people)*4) fail(429,'Invite limit reached');
            }
        }
        const response = await createRouter({service:this.service,allowedOrigins:[this.env.APP_ORIGIN]})(request);
        if (response.ok) for (const event of this.emitted) await this.broadcast(event);
        if (response.ok && request.method==='DELETE' && !action && roomId) for (const ws of this.ctx.getWebSockets(roomId)) ws.close(1008,'Room deleted');
        return response;
    }
    private chargeRequest(workspace: WorkspaceRecord, control: boolean) {
        const plan = this.limits(workspace);
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO usage(period) VALUES(?)',workspace.period_start);
        const usage = this.ctx.storage.sql.exec<{requests:number}>('SELECT requests FROM usage WHERE period=?',workspace.period_start).one();
        // Reserved controls still have a bounded technical budget (20% headroom).
        if (usage.requests >= Math.floor(plan.requests * (control ? 1.2 : 1))) fail(429,'Monthly request allowance reached');
        this.ctx.storage.sql.exec('UPDATE usage SET requests=requests+1 WHERE period=?',workspace.period_start);
    }
    private streamExport(roomId: string, snapshot: unknown, handovers: unknown) {
        const hour = Math.floor(Date.now()/3600_000);
        if (this.ctx.storage.sql.exec('SELECT 1 FROM exports WHERE hour=?',hour).toArray().length) fail(429,'One full export per workspace per hour is available');
        this.ctx.storage.sql.exec('INSERT INTO exports(hour) VALUES(?)',hour);
        this.ctx.storage.sql.exec('DELETE FROM exports WHERE hour<?',hour-1);
        const store = this.store;
        const encoder = new TextEncoder();
        let cursor=0,started=false,first=true;
        let deadline: ReturnType<typeof setTimeout>;
        const source = snapshot as {latestSeq:number;earliestSeq:number};
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {deadline=setTimeout(()=>controller.error(new Error('Export timed out; retry with a faster connection')),60_000);},
            cancel() {clearTimeout(deadline);},
            async pull(controller) {
                if (!started) {started=true;controller.enqueue(encoder.encode(JSON.stringify({room:snapshot,handovers,exportedAt:Date.now(),complete:source.earliestSeq<=1}).slice(0,-1)+',"events":['));return;}
                const page=await store.readEvents(roomId,cursor,100);
                const events=page.events.filter(e=>e.seq<=source.latestSeq);
                for (const event of events) {controller.enqueue(encoder.encode((first?'':',')+JSON.stringify(event)));first=false;cursor=event.seq;}
                if (!page.hasMore || !events.length || cursor>=source.latestSeq) {clearTimeout(deadline);controller.enqueue(encoder.encode(']}'));controller.close();}
            },
        });
        return new Response(stream,{headers:{'content-type':'application/json','cache-control':'no-store'}});
    }
    private inTeam(roomId: string,teamId: string) { return this.ctx.storage.sql.exec('SELECT 1 FROM room_teams WHERE room_id=? AND team_id=?',roomId,teamId).toArray().length>0; }
    private checkParticipants(kind: string) {
        const plan = PLANS[isPlan(this.current?.plan)?this.current.plan:'dev'];
        const row = this.ctx.storage.sql.exec<{n:number}>(`SELECT count(*) AS n FROM participants p JOIN rooms r ON r.room_id=p.room_id
            WHERE json_extract(p.body,'$.kind')=? AND json_extract(p.body,'$.leftAt') IS NULL AND json_extract(p.body,'$.revokedAt') IS NULL
            AND json_extract(r.body,'$.lifecycle')='open' AND (json_extract(r.body,'$.expiresAt') IS NULL OR json_extract(r.body,'$.expiresAt')>?)`,kind,Date.now()).one();
        if (row.n >= (kind==='agent'?plan.agents:plan.people)) fail(429,`${kind} session limit reached; leave an unused session first`);
    }
    private meter(mutation: Mutation) {
        if (!this.current) fail(402,'No workspace is selected');
        const plan = this.limits(this.current);
        const bytes = payloadBytes(mutation.appendEvent);
        const reply=mutation.appendEvent.type==='message' && mutation.appendEvent.replyTo!==null && mutation.appendEvent.payload.responseStage!=='progress';
        const progress=mutation.appendEvent.type==='message' && mutation.appendEvent.replyTo!==null && mutation.appendEvent.payload.responseStage==='progress';
        const receipt = mutation.appendEvent.type==='message.received';
        const exempt = reply || progress || isQuotaExempt(mutation.appendEvent.type) || mutation.appendEvent.type === 'participant.left';
        const count = this.ctx.storage.sql.exec<{messages:number;system_events:number;receipts:number;replies:number}>('SELECT messages,system_events,receipts,replies FROM usage WHERE period=?',this.current.period_start).one();
        if(reply && count.replies>=plan.messages) quota('The reserved reply allowance is exhausted');
        if (receipt && count.receipts>=2*plan.messages+Math.max(1000,Math.floor(plan.messages*0.05))) quota('Monthly receipt allowance exhausted');
        if (exempt && !receipt && !reply && count.system_events >= Math.max(1000,Math.floor(plan.messages*0.05))) quota('The reserved control and receipt allowance is exhausted');
        if (!exempt && count.messages >= plan.messages) quota('Monthly message allowance reached');
        if (!exempt) {
            const second=Math.floor(Date.now()/1000);
            const burst=this.ctx.storage.sql.exec<{events:number}>('INSERT INTO bursts(second,events) VALUES(?,1) ON CONFLICT(second) DO UPDATE SET events=events+1 RETURNING events',second).one().events;
            if (burst>({dev:5,team:15,enterprise:50}[isPlan(this.current.plan)?this.current.plan:'dev'])) quota('Workspace message rate exceeded; retry after one second');
            this.ctx.storage.sql.exec('DELETE FROM bursts WHERE second<?',second-1);
        }
        if (mutation.upsertHandovers.some(h=>!this.ctx.storage.sql.exec('SELECT 1 FROM handovers WHERE handover_id=?',h.handoverId).toArray().length) && this.ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM handovers WHERE room_id=?',mutation.room.roomId).one().n>=64) quota('This room has reached its active handover limit');
        // Bound full SQL storage, not only JSON payload; reserve 20% for controls.
        if (this.ctx.storage.sql.databaseSize + bytes*3 > plan.storageBytes * (exempt?1.2:1)) quota('Retained storage allowance reached');
        if (!exempt) this.ctx.storage.sql.exec('UPDATE usage SET messages=messages+1 WHERE period=?',this.current.period_start);
        else if(reply) this.ctx.storage.sql.exec('UPDATE usage SET replies=replies+1 WHERE period=?',this.current.period_start);
        else if (receipt) this.ctx.storage.sql.exec('UPDATE usage SET receipts=receipts+1 WHERE period=?',this.current.period_start);
        else this.ctx.storage.sql.exec('UPDATE usage SET system_events=system_events+1 WHERE period=?',this.current.period_start);
        this.emitted.push(mutation.appendEvent);
    }
    private async connectSocket(request: Request,roomId: string,active: boolean) {
        if (!active) fail(402,'An active subscription is required');
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') fail(426,'WebSocket upgrade required');
        const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
        const hash = await digest(ticket);
        const row = this.ctx.storage.sql.exec<{credential:string}>('SELECT credential FROM tickets WHERE digest=? AND room_id=? AND expires>?',hash,roomId,Date.now()).toArray()[0];
        if (!row) fail(401,'Connection ticket invalid or expired');
        this.ctx.storage.sql.exec('DELETE FROM tickets WHERE digest=?',hash);
        const view = await this.store.loadRoom(roomId);
        if (!view) fail(404,'Room not found');
        const actor = authenticate(view,await hashCredential(row.credential),Date.now());
        if (actor.kind !== 'participant') fail(403,'Connect with a participant credential');
        this.chargeRequest(this.current!,false);
        const participantId = actor.participant.participantId;
        for (const existing of this.ctx.getWebSockets(roomId)) {
            if (existing.deserializeAttachment()?.participantId===participantId) existing.close(1000,'Connection replaced');
        }
        const pair = new WebSocketPair();
        const server = pair[1];
        this.ctx.acceptWebSocket(server,[roomId]);
        server.serializeAttachment({roomId,participantId});
        const snapshot = await this.service.snapshot(roomId,row.credential);
        server.send(JSON.stringify({type:'hello',snapshot,watermarkSeq:snapshot.latestSeq}));
        return new Response(null,{status:101,webSocket:pair[0]});
    }
    private async broadcast(event: RoomEvent) {
        const view = await this.store.loadRoom(event.roomId);
        for (const ws of this.ctx.getWebSockets(event.roomId)) {
            const meta = ws.deserializeAttachment() as {participantId:string};
            const participant = view?.participants.find(p=>p.participantId===meta.participantId);
            try {
                if (!view || view.room.lifecycle !== 'open' || !participant || participant.revokedAt !== null || participant.leftAt !== null) ws.close(1008,'Room access ended');
                else ws.send(JSON.stringify({type:'event',event}));
            } catch { ws.close(1011,'Reconnect to resume'); }
        }
    }
    override async webSocketMessage(ws: WebSocket) { ws.close(1008,'Send work through the authenticated HTTP API'); }
    override async webSocketClose(ws: WebSocket) { ws.close(); }
    override async alarm() {
        await this.serial(async () => {
            const id = this.ctx.storage.sql.exec<{value:string}>("SELECT value FROM hosted_meta WHERE key='workspace'").toArray()[0]?.value;
            if (!id) return;
            const workspace = await this.env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(id).first<WorkspaceRecord>();
            const plan = PLANS[isPlan(workspace?.plan)?workspace.plan:'dev'];
            const cutoff = Date.now()-plan.retentionDays*86400_000;
            // Bounded cleanup; backlog progresses hourly without unbounded loops.
            this.ctx.storage.transactionSync(()=>{
                this.ctx.storage.sql.exec("DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE json_extract(body,'$.at')<? LIMIT 2000)",cutoff);
                this.ctx.storage.sql.exec('DELETE FROM idempotency WHERE rowid IN(SELECT i.rowid FROM idempotency i LEFT JOIN events e ON e.room_id=i.room_id AND e.seq=i.seq WHERE e.seq IS NULL LIMIT 2000)');
                this.ctx.storage.sql.exec('DELETE FROM tickets WHERE expires<=?',Date.now());
                this.ctx.storage.sql.exec('DELETE FROM reconciled_events WHERE at<?',Date.now()-93*86400_000);
                this.ctx.storage.sql.exec('DELETE FROM usage_grants WHERE period<?',Date.now()-93*86400_000);
                this.ctx.storage.sql.exec("DELETE FROM handovers WHERE json_extract(body,'$.resolvedAt') IS NOT NULL AND json_extract(body,'$.resolvedAt')<?",cutoff);
                this.ctx.storage.sql.exec("DELETE FROM invites WHERE json_extract(body,'$.expiresAt') IS NOT NULL AND json_extract(body,'$.expiresAt')<? AND state='unused'",Date.now());
                this.ctx.storage.sql.exec("DELETE FROM message_requests WHERE (response_event_id IS NOT NULL OR requires_reply=0) AND json_extract(body,'$.at')<?",cutoff);
                this.ctx.storage.sql.exec('DELETE FROM usage WHERE period<?',Date.now()-93*86400_000);
                for (const row of this.ctx.storage.sql.exec<{room_id:string;body:string}>('SELECT room_id,body FROM rooms').toArray()) {
                    const room = JSON.parse(row.body) as RoomRecord;
                    const totals = this.ctx.storage.sql.exec<{n:number;b:number;s:number|null}>("SELECT count(*) AS n,coalesce(sum(length(body)),0) AS b,min(seq) AS s FROM events WHERE room_id=?",row.room_id).one();
                    room.retainedEvents = totals.n; room.retainedEventBytes = totals.b;
                    this.ctx.storage.sql.exec('UPDATE rooms SET body=?,earliest_seq=? WHERE room_id=?',JSON.stringify(room),totals.s ?? room.nextSeq,row.room_id);
                }
            });
            for (const ws of this.ctx.getWebSockets()) {
                const meta = ws.deserializeAttachment() as {roomId:string};
                const view = await this.store.loadRoom(meta.roomId);
                if (!workspace || workspace.status !== 'active' || workspace.period_end <= Date.now() || !view || view.room.lifecycle !== 'open' || (view.room.expiresAt !== null && view.room.expiresAt<=Date.now())) ws.close(1008,'Access expired');
            }
            await this.ctx.storage.setAlarm(Date.now()+3600_000);
        });
    }
}

function quota(message: string): never { throw new ProtocolError('quota_exceeded',message); }
