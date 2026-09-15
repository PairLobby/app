import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {z} from 'zod';
import {expect,test,vi} from 'vitest';
import {PairLobbyClient,LocalStore} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';

test('channel requires explicit agent ACK and exact final replies over real MCP and HTTP',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'pairlobby-channel-'));
    const relay=await startServer({port:0,dataFile:join(directory,'room.sqlite')});
    const api=new PairLobbyClient(relay.url);
    const owner=await api.createRoom('channel test',{displayName:'sender',kind:'agent'});
    const sessionId=newId('session');
    const recipient=await api.redeemInvite(owner.invite.code,{displayName:'recipient',kind:'agent',sessionId});
    const local=new LocalStore(directory);
    local.upsertRoom({roomId:owner.roomId,name:'channel test',serverUrl:relay.url,createdAt:Date.now(),expiresAt:null,controls:false,sessions:[]});
    local.addSession(owner.roomId,{participantId:recipient.participantId,sessionId,displayName:'recipient',kind:'agent',role:'member',joinedAt:Date.now(),lastReadSeq:0,cwd:directory});
    local.putCredential(owner.roomId,sessionId,recipient.participantCredential);
    const asks=await Promise.all(['first','second'].map(text=>api.send(owner.roomId,owner.participantCredential,{type:'message',recipientId:recipient.participantId,payload:{text,priority:'normal'},idempotencyKey:newId('event')})));
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve('packages/cli/dist/main.js'),'channel','--room',owner.roomId,'--session',sessionId,'--allow-from',owner.participantId],env:{PAIRLOBBY_DATA_DIR:directory},stderr:'pipe'});
    const mcp=new Client({name:'test-receiver',version:'1.0.0'});
    const notices:unknown[]=[];
    mcp.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.object({content:z.string(),meta:z.record(z.string())})}),notice=>{notices.push(notice);});
    try {
        await mcp.connect(transport);
        await vi.waitFor(()=>expect(notices.length).toBe(2),{timeout:7000});
        const id=asks[0]!.event.eventId;
        expect((await api.request(owner.roomId,owner.participantCredential,id)).receivedAt).toBeNull();
        const premature=await mcp.callTool({name:'reply_to_message',arguments:{eventId:id,text:'not yet acknowledged'}});
        expect(premature.isError).toBe(true);
        const ack=await mcp.callTool({name:'acknowledge_message',arguments:{eventId:id}});expect(ack.isError).not.toBe(true);
        expect((await api.request(owner.roomId,owner.participantCredential,id)).receivedAt).not.toBeNull();
        await mcp.callTool({name:'progress_message',arguments:{eventId:id,text:'working'}});
        expect((await api.requests(owner.roomId,owner.participantCredential)).requests).toHaveLength(2);
        const reply=await mcp.callTool({name:'reply_to_message',arguments:{eventId:id,text:'I do not know the answer'}});expect(reply.isError).not.toBe(true);
        expect((await api.requests(owner.roomId,owner.participantCredential)).requests.map(r=>r.eventId)).toEqual([asks[1]!.event.eventId]);
    } finally {await mcp.close();await relay.close();rmSync(directory,{recursive:true,force:true});}
},15_000);
