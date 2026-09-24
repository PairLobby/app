import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync,appendFileSync,openSync,closeSync,readSync,writeSync} from 'node:fs';
import {homedir,platform} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{skills:{type:'string'},'skills-dir':{type:'string'}}});

function selectSkills(requested) {
    if (requested !== undefined) return requested;

    let terminal;
    try {
        terminal = openSync('/dev/tty', 'r+');
    } catch {
        console.log('No interactive terminal; skipping agent skills. Use --skills all, claude, codex or qwen to include them.');
        return 'none';
    }

    function ask(question) {
        writeSync(terminal, question);
        const byte = Buffer.alloc(1);
        let answer = '';
        while (readSync(terminal, byte, 0, 1, null) > 0) {
            const character = byte.toString();
            if (character === '\n') return answer.trim().toLowerCase();
            if (character !== '\r') answer += character;
        }
        return null;
    }

    try {
        while (true) {
            const answer = ask('Install agent skills? [y/N] ');
            if (answer === null || ['', 'n', 'no'].includes(answer)) return 'none';
            if (['y', 'yes'].includes(answer)) break;
            writeSync(terminal, 'Please enter y or n.\n');
        }
        while (true) {
            const answer = ask('Which agents? 1) Claude Code  2) Codex  3) Qwen Code  4) All [4]: ');
            if (answer === null) return 'none';
            if (['1', 'claude', 'claude code'].includes(answer)) return 'claude';
            if (['2', 'codex'].includes(answer)) return 'codex';
            if (['3', 'qwen', 'qwen code'].includes(answer)) return 'qwen';
            if (['', '4', 'all'].includes(answer)) return 'all';
            writeSync(terminal, 'Please enter 1, 2, 3 or 4.\n');
        }
    } finally {
        closeSync(terminal);
    }
}

values.skills = selectSkills(values.skills);
if(!['all','claude','codex','qwen','none'].includes(values.skills)) throw new Error('Skills must be all, claude, codex, qwen or none.');
if(values['skills-dir']&&['all','none'].includes(values.skills)) throw new Error('--skills-dir requires a single agent.');
const windows=platform()==='win32';
const root=resolve(process.env.PAIRLOBBY_INSTALL_DIR??(windows?join(process.env.LOCALAPPDATA??homedir(),'PairLobby'):join(homedir(),'.local/share/pairlobby')));
const bin=resolve(process.env.PAIRLOBBY_BIN_DIR??(windows?join(root,'bin'):join(homedir(),'.local/bin')));
const base=process.env.PAIRLOBBY_DOWNLOAD_BASE??'https://pairlobby.com';
const version='__PAIRLOBBY_RELEASE_VERSION__';
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw new Error('Build the website installer with scripts/build-installers.mjs before running it.');
const filename=`pairlobby-cli-${version}.tgz`;
const target=join(bin,windows?'pairlobby.cmd':'pairlobby');
if(existsSync(target)&&!readFileSync(target,'utf8').includes('PairLobby managed launcher'))throw new Error(`Refusing to overwrite an existing command: ${target}. Choose PAIRLOBBY_BIN_DIR.`);
async function download(path){const response=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`Download failed: ${response.status}`);return Buffer.from(await response.arrayBuffer());}
mkdirSync(root,{recursive:true});const work=mkdtempSync(join(root,'.install-'));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
function isBundledSkill(content) {
    const releases=join(root,'releases');
    if(!existsSync(releases))return false;
    return readdirSync(releases,{withFileTypes:true}).some(entry=>{
        if(!entry.isDirectory())return false;
        try{return readFileSync(join(releases,entry.name,'skills/pairlobby/SKILL.md'),'utf8')===content;}
        catch{return false;}
    });
}
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
    const metadata=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
    if(metadata.name!=='@pairlobby/cli'||metadata.version!==version)throw new Error('Downloaded package version does not match the installer.');
    const reported=execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'});
    if(!reported.startsWith(`PairLobby ${version} `))throw new Error('Downloaded CLI reports an unexpected version.');
    execFileSync(process.execPath,[cli,'--help'],{stdio:'pipe'});
    const release=join(root,'releases',`${version}-${expected.slice(0,12)}`);mkdirSync(join(root,'releases'),{recursive:true});
    if(!existsSync(release))renameSync(packageRoot,release);
    const targets=values.skills==='none'?[]:values.skills==='all'?['claude','codex','qwen']:[values.skills];
    const skill=readFileSync(join(release,'skills/pairlobby/SKILL.md'),'utf8');
    for(const agent of targets){
        const skillsRoot=values['skills-dir']?resolve(values['skills-dir']):join(agent==='codex'?(process.env.CODEX_HOME??join(homedir(),'.codex')):join(homedir(),agent==='qwen'?'.qwen':'.claude'),'skills');
        const target=join(skillsRoot,'pairlobby/SKILL.md');
        if(existsSync(target)&&readFileSync(target,'utf8')!==skill){
            const current=readFileSync(target,'utf8');
            if(!isBundledSkill(current)){console.log(`Preserved customized ${agent} skill: ${target}. Review it and use pairlobby install-skill ${agent} --force to back it up and update.`);continue;}
            writeFileSync(target+`.backup-${Date.now()}`,current,{mode:0o600});
            console.log(`Updating bundled ${agent} skill.`);
        }
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
    console.log(`PairLobby ${version} installed: ${target}\nOpen a new terminal and run: pairlobby --version\nInstall and sign into Codex CLI, Claude Code or Qwen Code separately. From your project, join with --runtime codex, --runtime claude or --runtime qwen for automatic receiving. Each uses a separate managed conversation; no listening subagent is needed.`);
} finally {rmSync(work,{recursive:true,force:true});}
