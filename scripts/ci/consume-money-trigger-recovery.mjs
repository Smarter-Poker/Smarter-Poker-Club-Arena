// Unprivileged consumer: authenticated Actions provenance, exact head, exact file bytes.
// It never accepts a workspace receipt or a PR-provided artifact URL.
import fs from 'node:fs';
import {MAX_MIGRATION_BYTES} from './money-trigger-input-limits.mjs';
import {validProof} from './money-trigger-proof.mjs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from './money-trigger-recovery.mjs';
const repo=process.env.GITHUB_REPOSITORY||'Smarter-Poker/Smarter-Poker-Club-Arena';
const event=process.env.GITHUB_EVENT_PATH?JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')):{};
const head=event.pull_request?.head.sha||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),pr=event.pull_request?.number;
if(repo!=='Smarter-Poker/Smarter-Poker-Club-Arena'||!head)throw Error('Recovery requires exact repository/head');
const headers={Authorization:`Bearer ${(process.env.GITHUB_TOKEN||process.env.GH_TOKEN||execFileSync('gh',['auth','token'],{encoding:'utf8'}).trim())}`,Accept:'application/vnd.github+json'};
async function api(p){const r=await fetch(`https://api.github.com/repos/${repo}/${p}`,{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`Actions provenance unavailable ${r.status}`);return r.json()}
const id=process.env.MONEY_TRIGGER_RUN_ID;if(!/^\d+$/.test(id||''))throw Error('bounded coordinator run ID required');
const runs={workflow_runs:[await api(`actions/runs/${id}`)]};let proof;
for(const run of runs.workflow_runs){
 if(!['workflow_dispatch'].includes(run.event)||run.conclusion!=='success'||run.path!=='.github/workflows/money-trigger-recovery.yml'||run.repository.full_name!==repo||(run.event==='workflow_dispatch'&&run.head_branch!=='main')||Date.now()-Date.parse(run.updated_at)>300000)continue;
 const artifacts=await api(`actions/runs/${run.id}/artifacts`);const matches=artifacts.artifacts.filter(a=>a.name===`money-trigger-recovery-${head}`&&!a.expired);if(matches.length!==1)continue;
 const r=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${matches[0].id}/zip`,{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('artifact unavailable');const buf=Buffer.from(await r.arrayBuffer());if(buf.length>2000000)throw Error('oversized proof');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'money-proof-'));try{const zip=path.join(dir,'proof.zip');fs.writeFileSync(zip,buf);const raw=execFileSync('unzip',['-p',zip,'money-trigger-recovery.json'],{maxBuffer:2000000});const x=JSON.parse(raw);if(validProof(run,x,{repo,head,pr})){proof=x;break}}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
if(!proof)throw Error('No fresh trusted exact-head proof; wait for producer and rerun CI');
// Compare Git's complete changed migration set, not a caller-provided subset.
const base=event.pull_request?.base.sha||process.env.MONEY_TRIGGER_BASE||'origin/main';
const files=execFileSync('git',['diff','--name-only','--diff-filter=AMR',`${base}...${head}`],{encoding:'utf8'}).trim().split('\n').filter(p=>/^supabase\/migrations\/[^/]+\.sql$/.test(p));
if(files.length!==proof.results.length||new Set(proof.results.map(x=>x.path)).size!==files.length)throw Error('file coverage differs');
for(const p of files){const bytes=execFileSync('git',['show',`${head}:${p}`],{maxBuffer:MAX_MIGRATION_BYTES});if(!proof.results.some(x=>x.path===p&&x.sha256===sha256(bytes)))throw Error('migration bytes differ')}
if(!proof.recordHashes||Object.keys(proof.recordHashes).length>128)throw Error('missing record bindings');
for(const [p,h] of Object.entries(proof.recordHashes)){if(!/^supabase\/migrations\/[^/]+\.sql$/.test(p)||sha256(execFileSync('git',['show',`${head}:${p}`],{maxBuffer:MAX_MIGRATION_BYTES}))!==h)throw Error('declaration record bytes differ')}
console.log(`Trusted exact-head money-trigger proof verified for ${files.length} files.`);
