import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function installSkill(agent:string|undefined,force=false,skillsDirectory?:string):string[] {
    if(!agent||!['claude','codex','all'].includes(agent)) throw new Error('Usage: pairlobby install-skill claude|codex|all [--force]');
    const candidates=[new URL('../skills/pairlobby/SKILL.md',import.meta.url),new URL('../../../integrations/claude-code/SKILL.md',import.meta.url)];
    const source=candidates.map(url=>fileURLToPath(url)).find(existsSync);
    if(!source) throw new Error('This installation is missing its skill file. Reinstall the official PairLobby package.');
    const content=readFileSync(source,'utf8');
    const agents=agent==='all'?['claude','codex']:[agent];
    if(skillsDirectory&&agent==='all') throw new Error('Choose one agent when using --skills-dir');
    const destinations=agents.map(name=>join(skillsDirectory?resolve(skillsDirectory):join(name==='claude'?join(homedir(),'.claude'):(process.env['CODEX_HOME']??join(homedir(),'.codex')),'skills'),'pairlobby','SKILL.md'));
    for(const destination of destinations) if(existsSync(destination)&&readFileSync(destination,'utf8')!==content&&!force) throw new Error(`A different skill already exists at ${destination}. Review it first; --force saves a backup and replaces it.`);
    for(const destination of destinations) {
        mkdirSync(dirname(destination),{recursive:true,mode:0o700});
        if(existsSync(destination)&&readFileSync(destination,'utf8')!==content) writeFileSync(destination+`.backup-${Date.now()}`,readFileSync(destination),{mode:0o600});
        writeFileSync(destination,content,{mode:0o600});
    }
    return destinations;
}
