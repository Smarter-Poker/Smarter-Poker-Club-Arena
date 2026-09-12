import fs from 'node:fs';
import {supabaseServerHeaders} from './supabase-auth-headers.mjs';
import {inflateSync} from 'node:zlib';
import {verifyRecovery,sha256} from './money-trigger-recovery.mjs';
import {offenders} from './check-money-trigger-declared.mjs';
const repo=process.env.GITHUB_REPOSITORY, number=process.env.PR_NUMBER;
if(repo!=='Smarter-Poker/Smarter-Poker-Club-Arena')throw Error('invalid repository');
const headers={Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'};
async function gh(p){const r=await fetch(`https://api.github.com/repos/${repo}/${p}`,{headers});if(!r.ok)throw Error(`GitHub read failed ${r.status}`);return r.json()}
const policy=JSON.parse(fs.readFileSync(new URL('./money-trigger-recovery-policy.json',import.meta.url),'utf8'));
let headSha,inputs=[],pr=null,records={};
if(process.env.GITHUB_EVENT_NAME==='workflow_dispatch'){
 if(process.env.GITHUB_REF!=='refs/heads/main')throw Error('dispatch must run approved main');
 const encoded=process.env.CANDIDATE_BUNDLE||'';if(encoded.length>48000)throw Error('bundle too large');
 const bundle=JSON.parse(inflateSync(Buffer.from(encoded,'base64'),{maxOutputLength:5000000}));
 headSha=bundle.headSha;inputs=bundle.files;records=bundle.records||{};
 if(Object.keys(records).length>64||Object.entries(records).some(([p,s])=>!/^supabase\/migrations\/[^/]+\.sql$/.test(p)||typeof s!=='string'||Buffer.byteLength(s)>1000000))throw Error('invalid record data');
 if(!Array.isArray(inputs)||inputs.length>64||new Set(inputs.map(x=>x.path)).size!==inputs.length)throw Error('invalid file inventory');
 for(const f of inputs)if(!/^supabase\/migrations\/[^/]+\.sql$/.test(f.path)||typeof f.sql!=='string'||Buffer.byteLength(f.sql)>1000000)throw Error('invalid file data');
}else{
 if(process.env.GITHUB_EVENT_NAME!=='pull_request_target'||!/^\d+$/.test(number||''))throw Error('invalid event');
 pr=await gh(`pulls/${number}`);if(pr.state!=='open'||pr.base.ref!=='main')throw Error('unsupported PR');
 headSha=pr.head.sha;
 const files=[];for(let page=1;page<=30;page++){const rows=await gh(`pulls/${number}/files?per_page=100&page=${page}`);files.push(...rows);if(rows.length<100)break;if(page===30)throw Error('diff truncated')}
 for(const f of files.filter(f=>['added','modified','renamed'].includes(f.status)&&/^supabase\/migrations\/[^/]+\.sql$/.test(f.filename))){const data=await gh(`contents/${f.filename.split('/').map(encodeURIComponent).join('/')}?ref=${headSha}`);if(data.type!=='file'||data.encoding!=='base64'||data.size>1000000)throw Error('invalid migration data');inputs.push({path:f.filename,sql:Buffer.from(data.content,'base64').toString('utf8')})}
}
records={...records,...Object.fromEntries(inputs.map(f=>[f.path,f.sql]))};
if(pr)for(const p of policy){const file=`supabase/migrations/${p.declarationVersion}_${p.declarationName}.sql`;if(!(file in records)){const data=await gh(`contents/${file}?ref=${headSha}`);if(data.type!=='file'||data.encoding!=='base64'||data.size>1000000)throw Error('invalid declaration record');records[file]=Buffer.from(data.content,'base64').toString('utf8')}}
if(!/^[a-f0-9]{40}$/.test(headSha))throw Error('invalid SHA');
let live=null;if(inputs.some(x=>offenders(x.sql).length)){
 const url=process.env.SUPABASE_URL;if(url!=='https://kuklfnapbkmacvwxktbh.supabase.co')throw Error('wrong database');
 const versions=[...new Set(policy.flatMap(x=>[x.originalVersion,x.declarationVersion]))];
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!key)throw Error('missing trusted credential');
 const r=await fetch(url+'/rest/v1/rpc/fn_ci_money_trigger_recovery',{method:'POST',headers:supabaseServerHeaders(key,{'Content-Type':'application/json'}),body:JSON.stringify({p_versions:versions})});if(!r.ok)throw Error(`catalog unavailable ${r.status}`);live=await r.json();
}
const results=inputs.map(x=>verifyRecovery({...x,policy,live,headSha,files:records}));if(pr){const end=await gh(`pulls/${number}`);if(end.head.sha!==headSha)throw Error('PR advanced');}
fs.writeFileSync('money-trigger-recovery.json',JSON.stringify({version:1,repository:repo,pr:pr?Number(number):null,headSha,runId:process.env.GITHUB_RUN_ID,producedAt:new Date().toISOString(),catalogObservedAt:live?.observed_at??null,expiresAt:live?new Date(Date.parse(live.observed_at)+300000).toISOString():null,results,recordHashes:Object.fromEntries(Object.entries(records).map(([p,s])=>[p,sha256(s)]))},null,2));
console.log(`Verified ${results.length} migration files against trusted policy/live evidence.`);

fs.appendFileSync(process.env.GITHUB_OUTPUT,`head=${headSha}\n`);
