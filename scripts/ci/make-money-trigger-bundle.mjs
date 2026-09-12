// Emits ONLY data. Do not include uncommitted files or credentials.
import {execFileSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:5000000});
const headSha=git('rev-parse','HEAD').trim(),base=process.argv[2]||'origin/main';
const files=git('diff','--name-only','--diff-filter=AMR',`${base}...${headSha}`).trim().split('\n').filter(p=>/^supabase\/migrations\/[^/]+\.sql$/.test(p)).map(path=>({path,sql:git('show',`${headSha}:${path}`)}));
const policy=JSON.parse(git('show',`${headSha}:scripts/ci/money-trigger-recovery-policy.json`));
const records={};for(const p of policy){const f=`supabase/migrations/${p.declarationVersion}_${p.declarationName}.sql`;if(!/^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/.test(f))throw Error('invalid declaration path');records[f]=git('show',`${headSha}:${f}`)}
const data=deflateSync(JSON.stringify({headSha,files,records})).toString('base64');if(data.length>48000)throw Error('bundle too large');console.log(data);
