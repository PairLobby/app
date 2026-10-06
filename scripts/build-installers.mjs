import {copyFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
// The installers carry no version: install.mjs asks GitHub for the latest release when
// it runs. Copy them to the website again only when an installer itself changes.
const output=resolve(process.argv[2]??'../frontend/public');mkdirSync(output,{recursive:true});
for(const file of ['install.sh','install.ps1','install.mjs'])copyFileSync(join('scripts/installers',file),join(output,file));
console.log(`Installers copied to ${output}`);
