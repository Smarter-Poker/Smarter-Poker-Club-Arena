// Isolated native PostgreSQL only. Actual unchanged appearance RPC; scoped timestamp/receipt fixture.
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../../server/package.json', import.meta.url))('pg');
const [port, migration, stream, host = '127.0.0.1', database = 'postgres', user = os.userInfo().username] = process.argv.slice(2);
assert(/^\d+$/.test(port ?? '') && migration && stream);
const options={host,port:Number(port),database,user};
const db=new Client(options); await db.connect();
const source=fs.readFileSync(migration,'utf8');
const ownerSource=fs.readFileSync(new URL('../../supabase/migrations/20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl.sql',import.meta.url),'utf8');
const rpc=ownerSource.slice(ownerSource.indexOf('CREATE OR REPLACE FUNCTION public.fn_patch_table_appearance('),ownerSource.indexOf('REVOKE ALL ON FUNCTION public.fn_patch_table_appearance('));
assert(fs.readFileSync(new URL('./fixtures/theme-row-versions.sql',import.meta.url),'utf8').endsWith(rpc),'fixture must execute the exact installed appearance RPC source');

const forward=source.split('-- Rollback:')[0];
const rollback=source.split('-- Rollback:')[1].split('\n').slice(1).map(l=>l.replace(/^-- ?/,'')).join('\n');
const uid='11111111-1111-4111-8111-111111111111';
const call=async(c,id,felt)=>(await c.query('SELECT fn_patch_table_appearance($1,$2,\'ALL\',$3::jsonb) AS value',[uid,`22222222-2222-4222-8222-${String(id).padStart(12,'0')}`,JSON.stringify({table_id:felt})])).rows[0].value;
const events=async()=> (await db.query('SELECT kind,row_data FROM theme_events ORDER BY n')).rows;
const meta=async()=> (await db.query("SELECT md5(prosrc) hash,proacl::text acl,proowner::text owner,prosecdef,proconfig FROM pg_proc WHERE oid='public.update_user_theme_settings_timestamp()'::regprocedure")).rows[0];
try {
 await db.query(fs.readFileSync(new URL('./fixtures/theme-row-versions.sql',import.meta.url),'utf8'));
 const before=await meta(); assert.equal(before.hash,'da5ac28a58c8b4bb30209bf0d3d7082c');
 await call(db,1,'carbon_red'); const bad=await events();
 assert.equal(bad[0].row_data.updated_at,bad[1].row_data.updated_at);
 console.log('PASS failure-before: first INSERT/UPDATE different fields share one version');
 await db.query('TRUNCATE user_theme_settings,customization_settings_mutation_receipts,theme_events RESTART IDENTITY');
 await db.query(forward); await db.query(forward); const after=await meta();
 assert.equal(after.hash,'ba1df5a065cbb19f3763fc13a4048b7b');assert.deepEqual({...after,hash:before.hash},before);
 const first=await call(db,2,'carbon_red');
 assert.equal((await db.query('SELECT (SELECT (row_data->>\'updated_at\')::timestamptz FROM theme_events WHERE n=2) > (SELECT (row_data->>\'updated_at\')::timestamptz FROM theme_events WHERE n=1) AS strict')).rows[0].strict,true);
 assert.deepEqual(await call(db,2,'carbon_red'),first); assert.equal((await events()).length,2);
 await assert.rejects(()=>call(db,2,'jade_city'),e=>e.code==='22023');
 // Future timestamp exercises +1µs floor, irrespective of wall clock.
 await db.query("UPDATE user_theme_settings SET updated_at='2100-01-01'::timestamptz");
 // Trigger owns timestamps, so set future preimage through an isolated trigger-free INSERT.
 await db.query("INSERT INTO user_theme_settings(user_id,game_type,updated_at) VALUES($1,'NLH','2100-01-01+00')",[uid]);
 await db.query("UPDATE user_theme_settings SET table_id='carbon_red' WHERE game_type='NLH'");
 assert.equal((await db.query("SELECT updated_at='2100-01-01 00:00:00.000001+00'::timestamptz AS strict FROM user_theme_settings WHERE game_type='NLH'")).rows[0].strict,true);
 const other=new Client(options);await other.connect();
 try {
  await db.query('BEGIN'); const a=await call(db,3,'jade_city');
  let completed=false; const pending=call(other,4,'carbon_red').then(v=>{completed=true;return v;});
  await new Promise(r=>setTimeout(r,100));assert.equal(completed,false,'second device waits for locked first write');
  await db.query('COMMIT'); const b=await pending;
  assert.equal((await db.query('SELECT $1::timestamptz > $2::timestamptz AS strict',[b.updated_at,a.updated_at])).rows[0].strict,true);
 } finally {await other.end();}
 fs.writeFileSync(stream,JSON.stringify({before:bad,after:(await events()).slice(0,2)},null,2));
 console.log('PASS strict first-save versions / exact replay / request collision / future floor / serialized devices');
 await db.query(rollback);assert.deepEqual(await meta(),before);await db.query(forward);
 await db.query('BEGIN');await db.query('ALTER FUNCTION public.update_user_theme_settings_timestamp() SECURITY DEFINER');
 await assert.rejects(()=>db.query(forward),/security\/config\/grants drift/);await db.query('ROLLBACK');
 console.log('PASS guarded exact rollback / reapply / security drift refuses');
} finally {await db.end();}
