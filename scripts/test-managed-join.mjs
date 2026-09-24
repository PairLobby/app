// Run after npm run build; requires Python with PTY support. No model requests are sent.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {startServer} from '@pairlobby/local-server';
import {LocalStore,PairLobbyClient} from '@pairlobby/client';
const root=mkdtempSync(join(tmpdir(),'pairlobby-tty-ready-'));
const relay=await startServer({port:0,dataFile:join(root,'relay.sqlite')});const client=new PairLobbyClient(relay.url);const host=await client.createRoom('TTY receiver check',{displayName:'host',kind:'human'});
const data=join(root,'device');const store=new LocalStore(data);const cli=process.env.PAIRLOBBY_TEST_CLI ?? resolve('packages/cli/dist/main.js');const env={...process.env,PAIRLOBBY_DATA_DIR:data};
function run(command,args){return new Promise((resolve,reject)=>{const p=spawn(command,args,{env,cwd:root,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',c=>output+=c);p.stderr.on('data',c=>output+=c);p.on('error',reject);p.on('exit',code=>code===0?resolve(output):reject(new Error(output)));});}
try{
 for(const runtime of ['codex','claude','qwen']){
  const invite=await client.mintInvite(host.roomId,host.controllerCredential);
  console.log((await run('python3',[resolve('scripts/fixtures/managed-join-pty.py'),process.execPath,cli,'join',invite.code,'--runtime',runtime,'--server',relay.url,'--as',runtime])).trim());
 }
 for(const member of store.room(host.roomId).sessions){await run(process.execPath,[cli,'receiver','stop','--room',host.roomId,'--session',member.sessionId]);}
 console.log('PASS all three packaged runtime joins; no model request was sent');
}finally{
 for(const member of store.room(host.roomId)?.sessions??[])await run(process.execPath,[cli,'receiver','stop','--room',host.roomId,'--session',member.sessionId]).catch(()=>{});
 await relay.close();rmSync(root,{recursive:true,force:true});
}
