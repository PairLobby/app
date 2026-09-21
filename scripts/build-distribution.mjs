import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const output=resolve(process.argv[2]??'artifacts');
const version=JSON.parse(readFileSync('packages/cli/src/release.json','utf8')).version;
if(process.argv[3]&&process.argv[3]!==version)throw new Error('Release override must match packages/cli/src/release.json');
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw new Error('Invalid release version');
const stage=mkdtempSync(join(tmpdir(),'pairlobby-release-'));
const pkg=join(stage,'package');mkdirSync(join(pkg,'dist'),{recursive:true});mkdirSync(join(pkg,'skills/pairlobby'),{recursive:true});mkdirSync(output,{recursive:true});
const result=await build({entryPoints:['packages/cli/dist/main.js'],outfile:join(pkg,'dist/main.mjs'),bundle:true,external:['blessed'],platform:'node',format:'esm',target:'node22',metafile:true,legalComments:'eof',banner:{js:"import { createRequire as __pairlobbyCreateRequire } from 'node:module'; const require = __pairlobbyCreateRequire(import.meta.url);"}});
chmodSync(join(pkg,'dist/main.mjs'),0o755);
mkdirSync(join(pkg,'node_modules'),{recursive:true});
cpSync('node_modules/blessed',join(pkg,'node_modules/blessed'),{recursive:true});
cpSync('integrations/claude-code/SKILL.md',join(pkg,'skills/pairlobby/SKILL.md'));
writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@pairlobby/cli',version,description:'PairLobby rooms for humans and their coding agents',type:'module',dependencies:{blessed:'0.1.81'},bundledDependencies:['blessed'],bin:{pairlobby:'dist/main.mjs'},engines:{node:'>=22.18.0'},files:['dist','skills','README.md','THIRD_PARTY_NOTICES.txt']},null,2)+'\n');
cpSync('docs/cli-readme.md',join(pkg,'README.md'));
const roots=new Set([resolve('node_modules/blessed')]);
for(const input of Object.keys(result.metafile.inputs)) {
    if(!input.includes('node_modules/')) continue;
    let parent=dirname(resolve(input));
    while(parent!==dirname(parent)) {if(existsSync(join(parent,'package.json'))){roots.add(parent);break;}parent=dirname(parent);}
}
let notices='Third-party components bundled into PairLobby.\n';
for(const root of roots){const metadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));notices+=`\n## ${metadata.name} ${metadata.version}\n`;for(const file of readdirSync(root).filter(name=>/^(license|licence|copying|notice)(\.|$)/i.test(name))) {try{notices+=readFileSync(join(root,file),'utf8')+'\n';}catch{}}}
writeFileSync(join(pkg,'THIRD_PARTY_NOTICES.txt'),notices);
execFileSync('npm',['pack','--pack-destination',output],{cwd:pkg,stdio:'pipe'});
const archive=join(output,`pairlobby-cli-${version}.tgz`);
writeFileSync(archive+'.sha256',createHash('sha256').update(readFileSync(archive)).digest('hex')+'  '+archive.split('/').at(-1)+'\n');
console.log(JSON.stringify({archive,bytes:readFileSync(archive).length}));
