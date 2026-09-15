import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {LocalStore} from '@pairlobby/client';
import {resolveRoom,resolveSession,UsageError} from './context.js';
const quote=(text:string)=>`'${text.replaceAll("'", "'\\''")}'`;
export function configureClaude(store:LocalStore,roomRef:string|undefined,sessionRef:string|undefined,senders:string|undefined) {
    const room=resolveRoom(store,roomRef),session=resolveSession(room,sessionRef);
    if(session.kind!=='agent' || (session.runtime && session.runtime!=='claude-code')) throw new UsageError('choose the Claude agent session to configure');
    if(!senders || senders.split(',').some(id=>!/^pt_[0-9A-Z]{26}$/.test(id.trim()))) throw new UsageError('--allow-from must list the participant IDs the human authorizes to message Claude');
    const directory=join(store.directory,'claude-channels',session.sessionId);
    mkdirSync(directory,{recursive:true,mode:0o700});
    const cli=resolve(process.argv[1]!);
    const roomArgs=['--room',room.roomId,'--session',session.sessionId];
    const mcpPath=join(directory,'mcp.json'),settingsPath=join(directory,'settings.json'),launchPath=join(directory,'launch.sh');
    const mcp={mcpServers:{pairlobby:{command:process.execPath,args:[cli,'channel',...roomArgs,'--allow-from',senders],env:{PAIRLOBBY_DATA_DIR:store.directory}}}};
    const settings={
        permissions:{allow:['mcp__pairlobby__acknowledge_message','mcp__pairlobby__reply_to_message','mcp__pairlobby__progress_message','mcp__pairlobby__list_pending_requests']},
        hooks:{Stop:[{hooks:[{type:'command',command:[process.execPath,cli,'guard-stop',...roomArgs].map(quote).join(' '),timeout:20}]}]},
    };
    writeFileSync(mcpPath,JSON.stringify(mcp,null,2)+'\n',{mode:0o600});
    writeFileSync(settingsPath,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
    const argv=['claude',...(session.conversationId?['--resume',session.conversationId]:[]),'--mcp-config',mcpPath,'--settings',settingsPath,'--dangerously-load-development-channels','server:pairlobby'];
    const command=argv.map(quote).join(' ');
    writeFileSync(launchPath,`#!/bin/sh\n# Review the local MCP configuration and accept Claude's custom-channel consent prompt.\nexport PAIRLOBBY_DATA_DIR=${quote(store.directory)}\ncd ${quote(session.cwd)} || exit 1\nexec ${command}\n`,{mode:0o700});chmodSync(launchPath,0o700);
    return {roomId:room.roomId,sessionId:session.sessionId,mcpPath,settingsPath,launchPath,command,activationRequired:'Exit the existing Claude session, run the launch script, and accept Claude\'s custom-channel and MCP consent prompts. Shell/tool permissions are not bypassed.'};
}
