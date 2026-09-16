import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const output=resolve(process.argv[2]??'artifacts');
const stage=mkdtempSync(join(tmpdir(),'pairlobby-release-'));
const pkg=join(stage,'package');mkdirSync(join(pkg,'dist'),{recursive:true});mkdirSync(join(pkg,'skills/pairlobby'),{recursive:true});mkdirSync(output,{recursive:true});
const result=await build({entryPoints:['packages/cli/dist/main.js'],outfile:join(pkg,'dist/main.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,legalComments:'eof',banner:{js:"import { createRequire as __pairlobbyCreateRequire } from 'node:module'; const require = __pairlobbyCreateRequire(import.meta.url);"}});
chmodSync(join(pkg,'dist/main.mjs'),0o755);
cpSync('integrations/claude-code/SKILL.md',join(pkg,'skills/pairlobby/SKILL.md'));
writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@pairlobby/cli',version:'0.1.0-demo.1',description:'PairLobby rooms for humans and their coding agents',type:'module',bin:{pairlobby:'dist/main.mjs'},engines:{node:'>=22.18.0'},files:['dist','skills','README.md','THIRD_PARTY_NOTICES.txt']},null,2)+'\n');
writeFileSync(join(pkg,'README.md'),'# PairLobby CLI\n\nRequires Node.js 22.18+. Run `pairlobby help`. Install agent instructions with `pairlobby install-skill claude` or `pairlobby install-skill codex`. Skills do not automatically start a runtime listener; see https://pairlobby.com/agent-setup.html.\n');
const roots=new Set();
for(const input of Object.keys(result.metafile.inputs)) {
    if(!input.includes('node_modules/')) continue;
    let parent=dirname(resolve(input));
    while(parent!==dirname(parent)) {if(existsSync(join(parent,'package.json'))){roots.add(parent);break;}parent=dirname(parent);}
}
let notices='Third-party components bundled into PairLobby.\n';
for(const root of roots){const metadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));notices+=`\n## ${metadata.name} ${metadata.version}\n`;for(const file of readdirSync(root).filter(name=>/^(license|licence|copying|notice)(\.|$)/i.test(name))) {try{notices+=readFileSync(join(root,file),'utf8')+'\n';}catch{}}}
writeFileSync(join(pkg,'THIRD_PARTY_NOTICES.txt'),notices);
execFileSync('npm',['pack','--pack-destination',output],{cwd:pkg,stdio:'pipe'});
const archive=join(output,'pairlobby-cli-0.1.0-demo.1.tgz');
writeFileSync(archive+'.sha256',createHash('sha256').update(readFileSync(archive)).digest('hex')+'  '+archive.split('/').at(-1)+'\n');
console.log(JSON.stringify({archive,bytes:readFileSync(archive).length}));
