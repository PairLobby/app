import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestHarness} from 'wrangler';
import {PROTOCOL_VERSION_HEADER} from '../../protocol/dist/index.js';
import {PairLobbyClient} from '../../client/dist/index.js';
import {createHash,randomUUID} from 'node:crypto';

const origin='https://pairlobby.com';
const server=createTestHarness({workers:[{configPath:'packages/hosted/wrangler.jsonc',vars:{SIGNUPS_ENABLED:'true'},secrets:{BETTER_AUTH_SECRET:'test-only-secret-with-at-least-thirty-two-bytes',STRIPE_WEBHOOK_SECRET:'whsec_test_only',STRIPE_SECRET_KEY:'sk_test_placeholder'}}]});
let worker,db,cookie,user,workspace,team,relay,token,localOrigin;
const hash=s=>createHash('sha256').update(s).digest('hex');
async function call(path,{body,headers={},method=body===undefined?'GET':'POST'}={}) {
    const response=await worker.fetch(origin+path,{method,headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    return {response,data};
}
before(async()=>{
    localOrigin=(await server.listen()).url.origin;worker=server.getWorker();await worker.applyD1Migrations('DB');db=(await worker.getEnv()).DB;
}, {timeout:60_000});
after(async()=>{await server.close();});

test('signup, verification gate, login, secure session and workspace ownership',async()=>{
    let result=await call('/api/auth/sign-up/email',{body:{email:'local-test@example.com',name:'Test Owner',password:'A-local-test-password-86753',callbackURL:origin+'/account'}});
    assert.equal(result.response.status,200,JSON.stringify(result.data));
    result=await call('/api/auth/sign-in/email',{body:{email:'local-test@example.com',password:'A-local-test-password-86753'}});
    assert.equal(result.response.status,403,JSON.stringify(result.data));
    await db.prepare('UPDATE user SET emailVerified=1 WHERE email=?').bind('local-test@example.com').run();
    result=await call('/api/auth/sign-in/email',{body:{email:'local-test@example.com',password:'A-local-test-password-86753'}});
    assert.equal(result.response.status,200,JSON.stringify(result.data));
    const cookies=result.response.headers.getSetCookie();assert.ok(cookies.some(c=>/HttpOnly/i.test(c)&&/Secure/i.test(c)));
    cookie=cookies.map(c=>c.split(';')[0]).join('; ');user=result.data.user;
    result=await call('/api/workspaces',{body:{name:'Test Workspace'},headers:{cookie}});
    assert.equal(result.response.status,201,JSON.stringify(result.data));workspace=result.data.id;
    team=(await db.prepare('SELECT id FROM teams WHERE workspace_id=?').bind(workspace).first()).id;
    relay=`/relay/${workspace}/${team}`;
    const denied=await call(`/api/workspaces/${workspace}`);assert.equal(denied.response.status,401);
    result=await call(`/api/workspaces/${workspace}/checkout`,{body:{plan:'dev'},headers:{cookie}});assert.equal(result.response.status,503);
    await db.prepare("UPDATE workspaces SET plan='dev',status='active',period_start=?,period_end=? WHERE id=?").bind(Date.now()-1000,Date.now()+86400_000,workspace).run();
    result=await call(`/api/workspaces/${workspace}/tokens`,{body:{teamId:team,label:'test device'},headers:{cookie}});
    assert.equal(result.response.status,201,JSON.stringify(result.data));token=result.data.token;
},{timeout:30_000});

let room,credential,controller,invite,participant;
test('hosted creation requires account proof and room credentials remain isolated',async()=>{
    const input={name:'remote room',displayName:'owner-agent',kind:'agent',controllerCredential:'c'.repeat(40),participantCredential:'p'.repeat(40)};
    let result=await call(relay+'/v1/rooms',{body:input,headers:{'x-can-create':'true'}});assert.equal(result.response.status,401);
    result=await call(relay+'/v1/rooms',{body:input,headers:{'x-pairlobby-account-token':token,[PROTOCOL_VERSION_HEADER]:'2'}});assert.equal(result.response.status,400);
    result=await call(relay+'/v1/rooms',{body:input,headers:{'x-pairlobby-account-token':token}});
    assert.equal(result.response.status,201,JSON.stringify(result.data));room=result.data.room.roomId;participant=result.data.participantId;invite=result.data.invite.code;credential=input.participantCredential;controller=input.controllerCredential;
    const before=(await call(`/api/workspaces/${workspace}`,{headers:{cookie}})).data.usage.requests;
    result=await call(relay+`/v1/rooms/${room}/events`);assert.equal(result.response.status,401);
    const after=(await call(`/api/workspaces/${workspace}`,{headers:{cookie}})).data.usage.requests;assert.equal(after,before,'anonymous calls must not consume allowance');
    const otherTeam=randomUUID();await db.prepare('INSERT INTO teams VALUES(?,?,?)').bind(otherTeam,workspace,'Other').run();
    result=await call(`/relay/${workspace}/${otherTeam}/v1/rooms/${room}`,{headers:{authorization:`Bearer ${credential}`}});assert.equal(result.response.status,404);
});
test('invite redemption, retry deduplication, revocation and pooled quota races',async()=>{
    const input={code:invite,attemptId:'at_'+'A'.repeat(26),attemptSecret:'a'.repeat(40),participantCredential:'q'.repeat(40),displayName:'remote-agent',kind:'agent'};
    let result=await call(relay+'/v1/invites/redeem',{body:input});assert.equal(result.response.status,200,JSON.stringify(result.data));
    const remote=result.data.participantId;
    const event={type:'message',payload:{text:'Cross-network hello',priority:'normal'},idempotencyKey:'test-send-1',recipientId:remote};
    result=await call(relay+`/v1/rooms/${room}/events`,{body:event,headers:{authorization:`Bearer ${credential}`}});assert.equal(result.response.status,201,JSON.stringify(result.data));
    const again=await call(relay+`/v1/rooms/${room}/events`,{body:event,headers:{authorization:`Bearer ${credential}`}});assert.equal(again.response.status,200);assert.equal(again.data.deduplicated,true);assert.equal(again.data.event.seq,result.data.event.seq);
    result=await call(relay+`/v1/rooms/${room}/participants/${remote}`,{method:'DELETE',headers:{authorization:`Bearer ${controller}`}});assert.equal(result.response.status,200);
    result=await call(relay+`/v1/rooms/${room}/events`,{body:event,headers:{authorization:'Bearer '+'q'.repeat(40)}});assert.equal(result.response.status,403,JSON.stringify(result.data));
    const sql=await worker.getDurableObjectStorage('WORKSPACES',{name:workspace});
    await sql.exec('UPDATE usage SET messages=19999');
    const race=await Promise.all([1,2].map(i=>call(relay+`/v1/rooms/${room}/events`,{body:{...event,recipientId:participant,idempotencyKey:`race-${i}`},headers:{authorization:`Bearer ${credential}`}})));
    assert.deepEqual(race.map(r=>r.response.status).sort(),[201,429]);
    result=await call(relay+`/v1/rooms/${room}/control`,{body:{targetParticipantId:participant,paused:true},headers:{authorization:`Bearer ${controller}`}});assert.equal(result.response.status,200,JSON.stringify(result.data));
    await sql.exec('UPDATE usage SET messages=0');
});
test('single-use WebSocket tickets and hibernation preserve room authentication',async()=>{
    let result=await call(relay+`/v1/rooms/${room}/connect-ticket`,{body:{},headers:{authorization:`Bearer ${credential}`}});assert.equal(result.response.status,200,JSON.stringify(result.data));
    const path=origin+relay+`/v1/rooms/${room}/connect?ticket=${result.data.ticket}`;
    const upgraded=await worker.fetch(path,{headers:{Upgrade:'websocket'}});assert.equal(upgraded.status,101);
    const ws=upgraded.webSocket;ws.accept();
    const hello=await new Promise(resolve=>ws.addEventListener('message',e=>resolve(JSON.parse(e.data)),{once:true}));assert.equal(hello.type,'hello');
    const reused=await worker.fetch(path,{headers:{Upgrade:'websocket'}});assert.equal(reused.status,401);
    await worker.evictDurableObject('WORKSPACES',{name:workspace,webSockets:'hibernate'});
    const received=new Promise(resolve=>ws.addEventListener('message',e=>resolve(JSON.parse(e.data)),{once:true}));
    result=await call(relay+`/v1/rooms/${room}/control`,{body:{targetParticipantId:participant,paused:false},headers:{authorization:`Bearer ${controller}`}});assert.equal(result.response.status,200,JSON.stringify(result.data));
    const frame=await received;assert.equal(frame.type,'event');assert.equal(frame.event.type,'control.resume');ws.close();
},{timeout:15_000});
test('the CLI client consumes live deliveries without another HTTP read',async()=>{
    const client=new PairLobbyClient(localOrigin+relay);
    const page=await client.readEvents(room,credential,0);
    try {
        await client.waitForChange(room,credential,page.latestSeq,40);
        const before=(await call(`/api/workspaces/${workspace}`,{headers:{cookie}})).data.usage.requests;
        const waiting=client.waitForChange(room,credential,page.latestSeq,2000);
        const result=await call(relay+`/v1/rooms/${room}/control`,{body:{targetParticipantId:participant,paused:false},headers:{authorization:`Bearer ${controller}`}});
        assert.equal(result.response.status,200);
        await waiting;
        const delivered=await client.readEvents(room,credential,page.latestSeq);
        assert.equal(delivered.events[0].eventId,result.data.event.eventId);
        const after=(await call(`/api/workspaces/${workspace}`,{headers:{cookie}})).data.usage.requests;
        assert.equal(after,before+1,'only the control write should consume an HTTP request');
    } finally {client.closeLive();}
},{timeout:5000});

test('Team seats are allocated atomically and members cannot manage billing',async()=>{
    await db.prepare("UPDATE workspaces SET plan='team' WHERE id=?").bind(workspace).run();
    const candidates=[];
    for(let i=0;i<5;i++) {
        await db.prepare('DELETE FROM rateLimit').run(); // Isolate seat races from the separately configured auth throttle.
        const email=`seat-${i}@example.com`;
        let result=await call('/api/auth/sign-up/email',{body:{email,name:`Seat ${i}`,password:'A-local-test-password-86753',callbackURL:origin+'/account'}});
        assert.equal(result.response.status,200);
        await db.prepare('UPDATE user SET emailVerified=1 WHERE email=?').bind(email).run();
        result=await call('/api/auth/sign-in/email',{body:{email,password:'A-local-test-password-86753'}});
        assert.equal(result.response.status,200,JSON.stringify(result.data));
        const memberCookie=result.response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
        const invitation=await call(`/api/workspaces/${workspace}/invites`,{body:{email,teamId:team},headers:{cookie}});
        assert.equal(invitation.response.status,201);
        candidates.push({cookie:memberCookie,token:new URL(invitation.data.url).searchParams.get('invite')});
    }
    const results=await Promise.all(candidates.map(c=>call('/api/accept-invite',{body:{token:c.token},headers:{cookie:c.cookie}})));
    assert.equal(results.filter(r=>r.response.status===200).length,4);
    assert.equal(results.filter(r=>r.response.status===409).length,1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM members WHERE workspace_id=?').bind(workspace).first()).n,5);
    const member=candidates[results.findIndex(r=>r.response.status===200)];
    const denied=await call(`/api/workspaces/${workspace}/checkout`,{body:{plan:'enterprise'},headers:{cookie:member.cookie}});
    assert.equal(denied.response.status,403);
    const memberToken=await call(`/api/workspaces/${workspace}/tokens`,{body:{teamId:team,label:'member laptop'},headers:{cookie:member.cookie}});
    assert.equal(memberToken.response.status,201,JSON.stringify(memberToken.data));
},{timeout:30_000});

test('expired subscriptions deny new work but preserve controls and exports',async()=>{
    await db.prepare('UPDATE workspaces SET period_end=? WHERE id=?').bind(Date.now()-1000,workspace).run();
    let result=await call(relay+`/v1/rooms/${room}/events`,{body:{type:'message',payload:{text:'no',priority:'normal'},idempotencyKey:'expired-write'},headers:{authorization:`Bearer ${credential}`}});assert.equal(result.response.status,402);
    result=await call(relay+`/v1/rooms/${room}/export`,{headers:{authorization:`Bearer ${controller}`}});assert.equal(result.response.status,200);
    result=await call('/api/billing/webhook',{body:{type:'customer.subscription.created'},headers:{'stripe-signature':'invalid'}});assert.equal(result.response.status,400);
});
