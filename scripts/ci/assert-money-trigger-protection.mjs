// Deferred activation guard. Does not wait for a proof in the long PR job.
import {pathToFileURL} from 'node:url';
export function assertProtection(rule,app){
 if(!/^\d+$/.test(app||''))throw Error('trusted reporting app identity not configured');
 const refs=rule?.conditions?.ref_name;
 // Deliberately support only explicit main targeting with zero exclusions.
 // Unknown/missing conditions and all exclusion patterns fail closed.
 if(rule?.target!=='branch'||rule.enforcement!=='active'||!Array.isArray(rule.bypass_actors)||rule.bypass_actors.length!==0||!Array.isArray(refs?.include)||!refs.include.includes('refs/heads/main')||!Array.isArray(refs.exclude)||refs.exclude.length!==0)throw Error('protection is not an applicable active no-bypass main branch rule with zero exclusions');
 const checks=rule.rules?.find(x=>x.type==='required_status_checks')?.parameters?.required_status_checks;
 if(!Array.isArray(checks)||!checks.some(x=>x.context==='Money trigger declaration authority'&&String(x.integration_id)===app))throw Error('dedicated exact-source money trigger check is not required');
}
async function main(){
 const repo=process.env.GITHUB_REPOSITORY,app=process.env.MONEY_TRIGGER_REPORTER_APP_ID;
 if(repo!=='Smarter-Poker/Smarter-Poker-Club-Arena')throw Error('wrong repository');
 const r=await fetch(`https://api.github.com/repos/${repo}/rulesets/21163380`,{headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('cannot establish actual required-check configuration');
 assertProtection(await r.json(),app);
 console.log('Dedicated app-bound money-trigger required context configured; GitHub enforces its exact-head verdict independently.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
