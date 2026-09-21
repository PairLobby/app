import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const output=resolve(process.argv[2]??'../frontend/public');mkdirSync(output,{recursive:true});
const version=JSON.parse(readFileSync('packages/cli/src/release.json','utf8')).version;
for(const file of ['install.sh','install.ps1'])copyFileSync(join('scripts/installers',file),join(output,file));
const template=readFileSync('scripts/installers/install.mjs','utf8');
if(!template.includes('__PAIRLOBBY_RELEASE_VERSION__'))throw new Error('Installer release marker is missing');
writeFileSync(join(output,'install.mjs'),template.replaceAll('__PAIRLOBBY_RELEASE_VERSION__',version));
console.log(`Installers copied to ${output}`);
