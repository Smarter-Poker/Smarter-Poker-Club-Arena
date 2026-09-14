import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=(name,args=[])=>spawnSync(process.execPath,[fileURLToPath(new URL(name,import.meta.url)),...args],{stdio:'inherit'});
const ordinary=run('./check-money-trigger-declared.mjs',process.argv.slice(2));
if(ordinary.error||ordinary.status===null)process.exit(2);
if(ordinary.status===0)process.exit(0);
if(ordinary.status!==1)process.exit(ordinary.status);
// Only a genuine policy refusal can enter trusted historical recovery.
const proof=run('./await-money-trigger-proof.mjs');
process.exit(proof.error||proof.status===null?2:proof.status);
