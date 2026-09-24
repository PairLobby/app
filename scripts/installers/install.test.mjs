import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const publicDirectory=resolve(process.env.PAIRLOBBY_TEST_INSTALLER_DIR??'../frontend/public');
const installer=join(publicDirectory,'install.mjs');
const version=JSON.parse(readFileSync('packages/cli/src/release.json','utf8')).version;
const archive=readFileSync(join(publicDirectory,`downloads/pairlobby-cli-${version}.tgz`));
const hash=createHash('sha256').update(archive).digest('hex');
test('staged installers and checksum match the shared release version',()=>{
 assert.equal(readFileSync(installer,'utf8'),readFileSync('scripts/installers/install.mjs','utf8').replaceAll('__PAIRLOBBY_RELEASE_VERSION__',version));
 for(const file of ['install.sh','install.ps1'])assert.equal(readFileSync(join(publicDirectory,file),'utf8'),readFileSync('scripts/installers/'+file,'utf8'));
 assert.equal(readFileSync(join(publicDirectory,`downloads/pairlobby-cli-${version}.tgz.sha256`),'utf8').trim().split(/\s+/)[0],hash);
});
function run(command,args,env){return new Promise((resolve,reject)=>{let output='';const child=spawn(command,args,{env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});}
test('installer verifies downloads, preserves customized skills, and installs a working user command',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pairlobby-installer-test-'));let bad=false,wrongVersion=false;
 const invalid=join(root,'invalid');mkdirSync(join(invalid,'package'),{recursive:true});
 writeFileSync(join(invalid,'package/package.json'),JSON.stringify({name:'@pairlobby/cli',version:'0.0.0'}));
 const invalidArchive=execFileSync(process.platform==='win32'?'tar.exe':'tar',['-czf','-','-C',invalid,'package']);
 const invalidHash=createHash('sha256').update(invalidArchive).digest('hex');
 const server=createServer((req,res)=>{if(req.url.endsWith('.sha256'))res.end((bad?'0'.repeat(64):wrongVersion?invalidHash:hash)+'  package.tgz\n');else res.end(wrongVersion?invalidArchive:archive);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const env={...process.env,PAIRLOBBY_DOWNLOAD_BASE:base,PAIRLOBBY_INSTALL_DIR:join(root,'app'),PAIRLOBBY_BIN_DIR:join(root,'bin'),PAIRLOBBY_SKIP_PATH:'1'};
 try{
  const args=[installer,'--skills','claude','--skills-dir',join(root,'skills')];
  let result=await run(process.execPath,args,env);assert.equal(result.code,0,result.output);
  const skill=join(root,'skills/pairlobby/SKILL.md');assert.match(readFileSync(skill,'utf8'),/PairLobby/i);
  result=await run(join(root,'bin/pairlobby'),['--help'],env);assert.equal(result.code,0,result.output);assert.match(result.output,/join online/);
  result=await run(join(root,'bin/pairlobby'),['--version'],env);assert.equal(result.code,0,result.output);assert.ok(result.output.includes(`PairLobby ${version} `));
  const legacySkill=join(root,'app/releases/previous/skills/pairlobby');mkdirSync(legacySkill,{recursive:true});
  writeFileSync(join(legacySkill,'SKILL.md'),'Previous bundled skill');writeFileSync(skill,'Previous bundled skill');
  result=await run(process.execPath,args,env);assert.equal(result.code,0,result.output);assert.match(result.output,/Updating bundled claude skill/);assert.match(readFileSync(skill,'utf8'),/managed Claude/i);
  writeFileSync(skill,'My customized skill');result=await run(process.execPath,args,env);assert.equal(result.code,0,result.output);assert.equal(readFileSync(skill,'utf8'),'My customized skill');
  const qwenArgs=[installer,'--skills','qwen','--skills-dir',join(root,'qwen-skills')];
  result=await run(process.execPath,qwenArgs,env);assert.equal(result.code,0,result.output);assert.match(result.output,/Installed qwen skill/);
  const qwenSkill=join(root,'qwen-skills/pairlobby/SKILL.md');assert.match(readFileSync(qwenSkill,'utf8'),/--runtime qwen/);
  writeFileSync(qwenSkill,'Customized Qwen skill');result=await run(process.execPath,qwenArgs,env);assert.equal(result.code,0,result.output);assert.equal(readFileSync(qwenSkill,'utf8'),'Customized Qwen skill');
  result=await run(join(root,'bin/pairlobby'),['install-skill','qwen','--skills-dir',join(root,'qwen-cli-skills'),'--json'],env);assert.equal(result.code,0,result.output);assert.ok(JSON.parse(result.output).installed[0].endsWith('pairlobby/SKILL.md'));
  result=await run(process.execPath,[installer],env);assert.equal(result.code,0,result.output);assert.match(result.output,/No interactive terminal; skipping agent skills/);assert.doesNotMatch(result.output,/Installed (claude|codex|qwen) skill/);
  const before=readFileSync(join(root,'bin/pairlobby'),'utf8');bad=true;
  result=await run(process.execPath,args,env);assert.notEqual(result.code,0);assert.match(result.output,/checksum/);assert.equal(readFileSync(join(root,'bin/pairlobby'),'utf8'),before);
  bad=false;
  wrongVersion=true;
  result=await run(process.execPath,args,env);assert.notEqual(result.code,0);assert.match(result.output,/version does not match/);assert.equal(readFileSync(join(root,'bin/pairlobby'),'utf8'),before);
  wrongVersion=false;
  if(process.platform!=='win32'){
   const tools=join(root,'tools');mkdirSync(tools);
   writeFileSync(join(tools,'curl'),`#!/bin/sh\nlast=''\ninstaller=0\nfor arg do last=$arg; case "$arg" in */install.mjs) installer=1;; esac; done\nif [ "$installer" = 1 ]; then cp '${installer.replaceAll("'","'\\''")}' "$last"; else /usr/bin/curl "$@"; fi\n`,{mode:0o755});
   result=await run('/bin/sh',[resolve('scripts/installers/install.sh'),'--skills','none'],{...env,PATH:tools+':/usr/bin:/bin:/usr/sbin:/sbin',PAIRLOBBY_INSTALL_DIR:join(root,'bootstrap'),PAIRLOBBY_BIN_DIR:join(root,'bootstrap-bin')});
   assert.equal(result.code,0,result.output);
   result=await run(join(root,'bootstrap-bin/pairlobby'),['--help'],env);assert.equal(result.code,0,result.output);
  }
 } finally {await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
},{timeout:180000});
