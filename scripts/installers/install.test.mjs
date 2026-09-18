import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const installer=resolve('scripts/installers/install.mjs');
const archive=readFileSync('../frontend/public/downloads/pairlobby-cli-0.1.0-demo.2.tgz');
const hash=createHash('sha256').update(archive).digest('hex');
function run(command,args,env){return new Promise((resolve,reject)=>{let output='';const child=spawn(command,args,{env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});}
test('installer verifies downloads, preserves customized skills, and installs a working user command',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pairlobby-installer-test-'));let bad=false;
 const server=createServer((req,res)=>{if(req.url.endsWith('.sha256'))res.end((bad?'0'.repeat(64):hash)+'  package.tgz\n');else res.end(archive);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const env={...process.env,PAIRLOBBY_DOWNLOAD_BASE:base,PAIRLOBBY_INSTALL_DIR:join(root,'app'),PAIRLOBBY_BIN_DIR:join(root,'bin'),PAIRLOBBY_SKIP_PATH:'1'};
 try{
  const args=[installer,'--skills','claude','--skills-dir',join(root,'skills')];
  let result=await run(process.execPath,args,env);assert.equal(result.code,0,result.output);
  const skill=join(root,'skills/pairlobby/SKILL.md');assert.match(readFileSync(skill,'utf8'),/PairLobby/i);
  result=await run(join(root,'bin/pairlobby'),['--help'],env);assert.equal(result.code,0,result.output);assert.match(result.output,/join online/);
  writeFileSync(skill,'My customized skill');result=await run(process.execPath,args,env);assert.equal(result.code,0,result.output);assert.equal(readFileSync(skill,'utf8'),'My customized skill');
  result=await run(process.execPath,[installer],env);assert.equal(result.code,0,result.output);assert.match(result.output,/No interactive terminal; skipping agent skills/);assert.doesNotMatch(result.output,/Installed (claude|codex) skill/);
  const before=readFileSync(join(root,'bin/pairlobby'),'utf8');bad=true;
  result=await run(process.execPath,args,env);assert.notEqual(result.code,0);assert.match(result.output,/checksum/);assert.equal(readFileSync(join(root,'bin/pairlobby'),'utf8'),before);
  bad=false;
  if(process.platform!=='win32'){
   const tools=join(root,'tools');mkdirSync(tools);
   writeFileSync(join(tools,'curl'),`#!/bin/sh\nlast=''\ninstaller=0\nfor arg do last=$arg; case "$arg" in */install.mjs) installer=1;; esac; done\nif [ "$installer" = 1 ]; then cp '${installer.replaceAll("'","'\\''")}' "$last"; else /usr/bin/curl "$@"; fi\n`,{mode:0o755});
   result=await run('/bin/sh',[resolve('scripts/installers/install.sh'),'--skills','none'],{...env,PATH:tools+':/usr/bin:/bin:/usr/sbin:/sbin',PAIRLOBBY_INSTALL_DIR:join(root,'bootstrap'),PAIRLOBBY_BIN_DIR:join(root,'bootstrap-bin')});
   assert.equal(result.code,0,result.output);
   result=await run(join(root,'bootstrap-bin/pairlobby'),['--help'],env);assert.equal(result.code,0,result.output);
  }
 } finally {await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
},{timeout:180000});
