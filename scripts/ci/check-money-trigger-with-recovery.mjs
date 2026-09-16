import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=(name,args=[])=>spawnSync(process.execPath,[fileURLToPath(new URL(name,import.meta.url)),...args],{stdio:'inherit'});
const args=process.argv.slice(2);
const requiredAuthority=args[0]==='--required-authority';
const ordinary=run('./check-money-trigger-declared.mjs',requiredAuthority?args.slice(1):args);
if(ordinary.error||ordinary.status===null)process.exit(2);
if(ordinary.status===0)process.exit(0);
if(ordinary.status!==1)process.exit(ordinary.status);
// Only a genuine policy refusal can enter trusted historical recovery.
if(requiredAuthority){
 // Configuration is not a SQL proof. Status 3 tells CI to report deferral,
 // while GitHub independently requires the exact App's captured-head verdict.
 const protection=run('./assert-money-trigger-protection.mjs');
 if(protection.error||protection.status===null)process.exit(2);
 if(protection.status!==0)process.exit(protection.status);
 console.log('DEFERRED - ordinary declaration refused; Money trigger declaration authority must pass independently.');
 process.exit(3);
}
const proof=run('./await-money-trigger-proof.mjs');
process.exit(proof.error||proof.status===null?2:proof.status);
