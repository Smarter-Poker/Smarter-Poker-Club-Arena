import {readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertClubArenaRepository} from '../../scripts/ci/repository-identity.mjs';
const scope = JSON.parse(readFileSync(new URL('../../scripts/ci/fixtures/original69-nonpaying-probe/scope.json', import.meta.url)));
const operation = scope.original_operation_id;
const md5 = '32ffc8212bcbaec490b76fb904707d3c';
const hex = /^[a-f0-9]{64}$/;
const decimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
function demand(ok) { if (!ok) throw Error('original69_probe_invalid_evidence'); }
function keys(value, expected) { demand(value && typeof value === 'object' && !Array.isArray(value)); demand(Object.keys(value).sort().join('|') === [...expected].sort().join('|')); }
export function config(env) {
  assertClubArenaRepository(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY_ID);
  demand(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1');
  demand(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') && /^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID || '') && scope.tournament_ids.includes(env.PROBE_EVENT));
  demand(/^[a-f0-9]{32}$/.test(env.PROBE_MONEY_HASH || '') && hex.test(env.PROBE_ECONOMIC_SHA256 || ''));
  demand(env.PROBE_RECEIPT_DIRECTORY && resolve(env.PROBE_RECEIPT_DIRECTORY) !== '/');
  return {schema:'original69-probe-intent/v1', operation_id:operation, tournament_id:env.PROBE_EVENT,
    money_hash:env.PROBE_MONEY_HASH, expected_economic_sha256:env.PROBE_ECONOMIC_SHA256,
    nonce:`github-run-${env.GITHUB_RUN_ID}`, run_id:env.GITHUB_RUN_ID, run_attempt:1, source_sha:env.GITHUB_SHA};
}
function durable(path, value) {
  mkdirSync(dirname(path), {recursive:true});
  const fd=openSync(path,'wx',0o600);
  try { writeFileSync(fd, JSON.stringify(value,null,2)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const dir=openSync(dirname(path),'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function validateState(state, intent) {
  keys(state,['schema','operation_id','tournament_id','state_sha256','target_state','probe_xid_status']);
  demand(state.schema === 'original69-probe-state/v1' && state.operation_id === operation && state.tournament_id === intent.tournament_id && hex.test(state.state_sha256));
  demand(state.target_state === 'quiesced' && [null,'aborted'].includes(state.probe_xid_status));
  return state;
}
export function validateRollback(body,intent) {
  keys(body,['code','details','hint','message']);
  demand(body.code === 'PZ069' && body.message === 'ORIGINAL69_PROBE_ROLLBACK_V1' && body.hint === null && typeof body.details === 'string' && Buffer.byteLength(body.details)<=4096);
  const d=JSON.parse(body.details);
  keys(d,['schema','operation_id','tournament_id','nonce','probe_xid','money_hash','canonical_md5','state_sha256','asset','source_player_count','refunded_count','refund_line_count','total_refunded','fees_reversed','refund_prize','refund_bounty','refund_fee','economic_sha256']);
  demand(d.schema === 'original69-probe-rollback/v1' && d.operation_id === operation && d.tournament_id === intent.tournament_id && d.nonce === intent.nonce);
  demand(d.money_hash === intent.money_hash && d.canonical_md5 === md5 && d.economic_sha256 === intent.expected_economic_sha256 && hex.test(d.state_sha256));
  demand(/^[0-9]{1,20}$/.test(d.probe_xid) && ['chips','diamonds'].includes(d.asset));
  for (const k of ['source_player_count','refunded_count','refund_line_count']) demand(Number.isSafeInteger(d[k]) && d[k]>=0);
  demand(d.refunded_count <= d.source_player_count);
  for (const k of ['total_refunded','fees_reversed','refund_prize','refund_bounty','refund_fee']) demand(typeof d[k] === 'string' && decimal.test(d[k]));
  return d;
}
// A fixed endpoint, one POST per call, redirects forbidden, no retry or raw error
// exposure. A dropped/truncated/oversized/error response remains UNKNOWN.
export async function rpc(env,name,args,fetcher=fetch) {
  demand(['fn_ca_original69_probe_state','fn_ca_probe_original69_abort'].includes(name));
  const base = new URL(env.SUPABASE_URL);
  demand(base.protocol === 'https:' && base.hostname === 'kuklfnapbkmacvwxktbh.supabase.co' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash && !base.port);
  demand(typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' && env.SUPABASE_SERVICE_ROLE_KEY.length>0);
  const res=await fetcher(new URL(`/rest/v1/rpc/${name}`,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
    headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
  demand(res.body);
  const reader=res.body.getReader(); const chunks=[];let size=0;
  try { for (;;) { const {done,value}=await reader.read();if(done) break;size+=value.byteLength;if(size>8192) { await reader.cancel();throw Error('original69_response_bound'); }chunks.push(value); } }
  finally {reader.releaseLock();}
  return {status:res.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
}
export async function execute(env,fetcher=fetch) {
  const intent=config(env);const dir=resolve(env.PROBE_RECEIPT_DIRECTORY);
  demand(readFileSync(`${dir}/intent.json`,'utf8') === JSON.stringify(intent,null,2)+'\n');
  // wx makes an interrupted invocation non-repeatable in its owning workspace.
  durable(`${dir}/attempt.json`,{schema:'original69-probe-attempt/v1',nonce:intent.nonce,status:'UNKNOWN',started_at:new Date().toISOString()});
  let before;let rollback;let after;
  const args={p_operation_id:operation,p_tournament_id:intent.tournament_id};
  try {
    const read=await rpc(env,'fn_ca_original69_probe_state',{...args,p_probe_xid:null},fetcher);demand(read.status===200);before=validateState(read.body,intent);
    durable(`${dir}/before.json`,before);
    const result=await rpc(env,'fn_ca_probe_original69_abort',{...args,p_expected_money_hash:intent.money_hash,p_nonce:intent.nonce},fetcher);
    demand(result.status===400);rollback=validateRollback(result.body,intent);demand(rollback.state_sha256===before.state_sha256);
    // The recognized uncaught exception is evidence of rollback, not a payment.
    durable(`${dir}/rollback.json`,rollback);
    const readback=await rpc(env,'fn_ca_original69_probe_state',{...args,p_probe_xid:rollback.probe_xid},fetcher);demand(readback.status===200);after=validateState(readback.body,intent);
    demand(after.probe_xid_status==='aborted' && after.state_sha256===before.state_sha256);
    durable(`${dir}/after.json`,after);
    durable(`${dir}/result.json`,{schema:'original69-probe-result/v1',nonce:intent.nonce,status:'ROLLED_BACK_VERIFIED',completed_at:new Date().toISOString()});
    return true;
  } catch {
    // Never serialize SQL message/DETAIL, response bodies, tokens, or raw errors.
    durable(`${dir}/result.json`,{schema:'original69-probe-result/v1',nonce:intent.nonce,status:'UNKNOWN_OR_REFUSED',completed_at:new Date().toISOString(),automatic_retry:false});
    return false;
  }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const env=process.env;
    if(process.argv[2]==='prepare') durable(`${resolve(env.PROBE_RECEIPT_DIRECTORY)}/intent.json`,config(env));
    else if(process.argv[2]==='execute') {if(!await execute(env)) process.exitCode=1;}
    else throw Error('invalid mode');
  } catch { console.error('Original69 probe refused or unknown. Preserve the owning intent; no automatic retry.');process.exitCode=1; }
}
