import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
import {homedir,platform} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{skills:{type:'string',default:'all'},'skills-dir':{type:'string'}}});
if(!['all','claude','codex','none'].includes(values.skills)) throw new Error('Skills must be all, claude, codex or none.');
if(values['skills-dir']&&['all','none'].includes(values.skills)) throw new Error('--skills-dir requires a single agent.');
const windows=platform()==='win32';
const root=resolve(process.env.PAIRLOBBY_INSTALL_DIR??(windows?join(process.env.LOCALAPPDATA??homedir(),'PairLobby'):join(homedir(),'.local/share/pairlobby')));
const bin=resolve(process.env.PAIRLOBBY_BIN_DIR??(windows?join(root,'bin'):join(homedir(),'.local/bin')));
const base=process.env.PAIRLOBBY_DOWNLOAD_BASE??'https://pairlobby.com';
const version='0.1.0-demo.2';
const filename=`pairlobby-cli-${version}.tgz`;
const target=join(bin,windows?'pairlobby.cmd':'pairlobby');
if(existsSync(target)&&!readFileSync(target,'utf8').includes('PairLobby managed launcher'))throw new Error(`Refusing to overwrite an existing command: ${target}. Choose PAIRLOBBY_BIN_DIR.`);
async function download(path){const response=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`Download failed: ${response.status}`);return Buffer.from(await response.arrayBuffer());}
mkdirSync(root,{recursive:true});const work=mkdtempSync(join(root,'.install-'));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
try {
    console.log('Downloading PairLobby…');
    const [archive,sums]=await Promise.all([download('/downloads/'+filename),download('/downloads/'+filename+'.sha256')]);
    const expected=sums.toString().trim().split(/\s+/)[0];
    if(!/^[a-f0-9]{64}$/.test(expected)||createHash('sha256').update(archive).digest('hex')!==expected)throw new Error('PairLobby download checksum failed.');
    const packed=join(work,'app.tgz');writeFileSync(packed,archive);
    const tar=windows?'tar.exe':'tar';
    const entries=execFileSync(tar,['-tzf',packed],{encoding:'utf8'}).trim().split('\n');
    if(entries.some(path=>!path.startsWith('package/')||path.split(/[\\/]/).includes('..')))throw new Error('Invalid package contents.');
    execFileSync(tar,['-xzf',packed,'-C',work]);
    const packageRoot=join(work,'package');const cli=join(packageRoot,'dist/main.mjs');
    execFileSync(process.execPath,[cli,'--help'],{stdio:'pipe'});
    const release=join(root,'releases',`${version}-${expected.slice(0,12)}`);mkdirSync(join(root,'releases'),{recursive:true});
    if(!existsSync(release))renameSync(packageRoot,release);
    const targets=values.skills==='none'?[]:values.skills==='all'?['claude','codex']:[values.skills];
    const skill=readFileSync(join(release,'skills/pairlobby/SKILL.md'),'utf8');
    for(const agent of targets){
        const skillsRoot=values['skills-dir']?resolve(values['skills-dir']):join(agent==='claude'?join(homedir(),'.claude'):(process.env.CODEX_HOME??join(homedir(),'.codex')),'skills');
        const target=join(skillsRoot,'pairlobby/SKILL.md');
        if(existsSync(target)&&readFileSync(target,'utf8')!==skill){console.log(`Preserved customized ${agent} skill: ${target}`);continue;}
        mkdirSync(join(skillsRoot,'pairlobby'),{recursive:true,mode:0o700});writeFileSync(target,skill,{mode:0o600});console.log(`Installed ${agent} skill.`);
    }
    mkdirSync(bin,{recursive:true});
    if(existsSync(target)&&!readFileSync(target,'utf8').includes('PairLobby managed launcher'))throw new Error(`Refusing to overwrite an existing command: ${target}. Choose PAIRLOBBY_BIN_DIR.`);
    const entry=join(release,'dist/main.mjs');
    const launcher=windows?`@echo off\r\nrem PairLobby managed launcher\r\n"${process.execPath}" "${entry}" %*\r\n`:`#!/bin/sh\n# PairLobby managed launcher\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`;
    const pending=join(bin,`.pairlobby-${process.pid}.tmp`);writeFileSync(pending,launcher,{mode:0o755});chmodSync(pending,0o755);renameSync(pending,target);
    if(process.env.PAIRLOBBY_SKIP_PATH!=='1') {
        if(windows){
            const path=bin.replaceAll("'","''");
            execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=[Environment]::GetEnvironmentVariable('Path','User');if(($p -split ';') -notcontains '${path}'){[Environment]::SetEnvironmentVariable('Path',('${path};'+$p),'User')}`],{stdio:'pipe'});
        }else{
            const line=`\n# PairLobby command\nexport PATH=${quote(bin)}:"$PATH"\n`;
            const profiles=new Set([join(homedir(),'.profile')]);
            if((process.env.SHELL??'').endsWith('zsh')||platform()==='darwin')profiles.add(join(homedir(),'.zshrc'));
            else profiles.add(join(homedir(),'.bashrc'));
            for(const file of profiles)if(!existsSync(file)||!readFileSync(file,'utf8').includes(line.trim()))appendFileSync(file,line);
        }
    }
    console.log(`PairLobby installed: ${target}\nOpen a new terminal and run: pairlobby --help\nSkills add instructions; agent listeners still need their normal runtime setup.`);
} finally {rmSync(work,{recursive:true,force:true});}
