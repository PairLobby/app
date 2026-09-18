import {copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const output=resolve(process.argv[2]??'../frontend/public');mkdirSync(output,{recursive:true});
for(const file of ['install.sh','install.ps1','install.mjs'])copyFileSync(join('scripts/installers',file),join(output,file));
console.log(`Installers copied to ${output}`);
