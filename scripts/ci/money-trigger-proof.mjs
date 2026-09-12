export function validProof(run,x,{repo,head,pr,now=Date.now()}){
 const age=now-Date.parse(x?.producedAt),runAge=now-Date.parse(run?.updated_at);
 const recovered=x?.results?.some(r=>r.recovered);
 const observed=Date.parse(x?.catalogObservedAt), expiry=Date.parse(x?.expiresAt);
 const catalogFresh=!recovered||(Number.isFinite(observed)&&expiry===observed+300000&&now>=observed&&now<expiry);
 return catalogFresh && run?.repository?.full_name===repo && run.path==='.github/workflows/money-trigger-recovery.yml' && run.conclusion==='success' &&
 ['pull_request_target','workflow_dispatch'].includes(run.event) && (run.event!=='workflow_dispatch'||run.head_branch==='main') &&
 Number.isFinite(age)&&Math.abs(age)<300000&&Number.isFinite(runAge)&&Math.abs(runAge)<300000 &&
 x?.version===1&&x.repository===repo&&x.headSha===head&&String(x.runId)===String(run.id)&&
 (run.event==='workflow_dispatch'?x.pr===null:x.pr===pr)&&Array.isArray(x.results)&&x.results.every(r=>/^supabase\/migrations\/[^/]+\.sql$/.test(r.path)&&/^[a-f0-9]{64}$/.test(r.sha256))&&
 x.recordHashes!==null&&typeof x.recordHashes==='object'&&!Array.isArray(x.recordHashes)&&Object.entries(x.recordHashes).every(([p,h])=>/^supabase\/migrations\/[^/]+\.sql$/.test(p)&&/^[a-f0-9]{64}$/.test(h));
}
