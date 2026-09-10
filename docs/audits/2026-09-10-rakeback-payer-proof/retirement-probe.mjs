#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const { Client } = createRequire(import.meta.url)('pg');
const socket=process.env.PGHOST;
assert.match(socket||'',/^\/tmp\/ca-rakeback-payer\.[A-Za-z0-9]+$/,'Only the disposable local Unix socket is permitted');
const config={host:socket,port:55473,user:'postgres',database:'payer_test',application_name:'local_rakeback_retirement'};
const db=new Client(config); await db.connect();
assert.equal((await db.query("SELECT inet_server_addr() IS NULL AND current_database()='payer_test' AS local_only")).rows[0].local_only,true);
const here=new URL('.',import.meta.url);
const definitions=JSON.parse(readFileSync(new URL('retirement-installed.json',here),'utf8'))
 .filter(x=>/^(atomic_pay_player_rakeback|credit_player_rakeback)/.test(x.signature));
const proposal=readFileSync(new URL('../../../supabase/migrations/20260910070710_retire_unbound_rakeback_payment_rpcs.sql',here),'utf8');
const results=[];
async function setup() {
 for(const f of definitions) {
  await db.query(f.definition);
  await db.query('REVOKE ALL ON FUNCTION public.'+f.signature+' FROM PUBLIC,anon,authenticated');
  await db.query('GRANT EXECUTE ON FUNCTION public.'+f.signature+' TO service_role');
 }
}
async function rejected(name,prepare,pattern) {
 await setup();await prepare();
 await assert.rejects(db.query(proposal),pattern);await db.query('ROLLBACK');
 results.push({name,pass:true});console.log('PASS '+name);
}
try {
 await setup();
 await rejected('changed body refuses retirement',()=>db.query("CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(p_user_id uuid,p_amount numeric) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'changed'; END $$"),/requires re-review/);
 await rejected('unexpected role grant refuses retirement',()=>db.query('GRANT EXECUTE ON FUNCTION public.atomic_pay_player_rakeback(uuid,numeric) TO authenticated'),/grants changed/);
 await rejected('new stored caller refuses retirement',()=>db.query("CREATE FUNCTION public.test_new_rakeback_caller() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.credit_player_rakeback(NULL,1); END $$"),/new or changed nested reference/);
 await db.query('DROP FUNCTION public.test_new_rakeback_caller()');
 await rejected('catalog dependency refuses retirement',()=>db.query("CREATE FUNCTION public.test_rakeback_dependency() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT public.atomic_pay_player_rakeback(NULL::uuid,1::numeric); END"),/stored dependencies/);
 await db.query('DROP FUNCTION public.test_rakeback_dependency()');
 await setup();await db.query(proposal);
 const snapshot=async()=> (await db.query("SELECT (SELECT count(*) FROM wallet_transactions) wallets,(SELECT count(*) FROM chip_ledger) journal,(SELECT count(*) FROM wallet_credit_idempotency) idem")).rows;
 const before=await snapshot();
 const calls=[
  "SELECT public.atomic_pay_player_rakeback('00000000-0000-4000-8000-000000000201',15)",
  "SELECT public.atomic_pay_player_rakeback('00000000-0000-4000-8000-000000000501','00000000-0000-4000-8000-000000000201',15,'00000000-0000-4000-8000-000000000601','retirement-test')",
  "SELECT public.credit_player_rakeback('00000000-0000-4000-8000-000000000201',15,'rakeback','retirement-test')"
 ];
 for(const role of ['anon','authenticated','service_role']) {
  const c=new Client(config);await c.connect();
  try {
   await c.query('SET ROLE '+role);
   for(let i=0;i<calls.length;i++) {
    await assert.rejects(c.query(calls[i]),e=>e.code==='42501'&&/permission denied for function/.test(e.message));
    results.push({name:role+' door '+(i+1)+' denied before execution',pass:true});
   }
  }finally{await c.end();}
 }
 assert.deepEqual(await snapshot(),before);
 for(const f of definitions) {
  const x=(await db.query('SELECT md5(prosrc) body FROM pg_proc WHERE oid=$1::regprocedure',['public.'+f.signature])).rows[0];
  assert.equal(x.body,f.md5);
 }
 results.push({name:'denied calls leave evidence unchanged and preserve installed bodies',pass:true});
 writeFileSync(new URL('retirement-proof.json',here),JSON.stringify({captured_at:new Date().toISOString(),isolation:'temporary Unix socket, no network listener',results,passed:results.length},null,2)+'\n');
 console.log(JSON.stringify({passed:results.length}));
}finally{await db.end();}
