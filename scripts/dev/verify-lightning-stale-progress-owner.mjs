// Isolated native fixture only. No provider, environment credential or live path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../../server/package.json', import.meta.url))('pg');
const [socket, port, migration] = process.argv.slice(2);
assert(socket?.startsWith('/') && /^\d+$/.test(port ?? '') && migration);
const source = fs.readFileSync(migration, 'utf8');
const executable = sql => sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
const forward = executable(source.split('-- Rollback:')[0]);
const rollback = executable(source.split('-- Rollback:')[1].split('\n').slice(1).map(line => line.replace(/^-- ?/, '')).join('\n'));
const client = new Client({host:socket,port:Number(port),database:'postgres',user:os.userInfo().username});
const sig = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)';
await client.connect();
try {
 await client.query('BEGIN');
 const read = async () => (await client.query('SELECT md5(prosrc) AS hash,pg_get_functiondef(oid) AS source,proacl::text AS acl,proowner::text AS owner FROM pg_proc WHERE oid=$1::regprocedure',[sig])).rows[0];
 const baseline = await read();
 assert.equal(baseline.hash,'8e06bde427b2b38939194c4ebb16c7de');
 await client.query(forward); // exact repeat accepts, not merely a marker.
 const refuse = async (label, mutation, sql, expected) => {
  await client.query('SAVEPOINT drift');
  await client.query(mutation);
  let error;
  try { await client.query(sql); } catch (e) { error=e; }
  assert.equal(error?.code,'P0001',`${label} must refuse`);
  assert.match(error.message,expected);
  await client.query('ROLLBACK TO SAVEPOINT drift');
  assert.deepEqual(await read(),baseline,`${label} rollback restores exact owner`);
  console.log(`PASS ${label}`);
 };
 await refuse('marked patched body drift',baseline.source.replace('STALE GROUPS KEEP DISJOINT PROGRESS.','STALE GROUPS KEEP DISJOINT PROGRESS. drift'),forward,/patched owner drifted/);
 await refuse('invoker security drift',`ALTER FUNCTION ${sig} SECURITY DEFINER`,forward,/security or grants/);
 await refuse('ordinary execute drift',`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`,forward,/security or grants/);
 await refuse('rollback refuses patched drift',baseline.source.replace('STALE GROUPS KEEP DISJOINT PROGRESS.','STALE GROUPS KEEP DISJOINT PROGRESS. drift'),rollback,/rollback owner drifted/);
 await client.query(rollback);
 const before=await read();
 assert.equal(before.hash,'a66e718780e9d873a62ee826411d546a');
 assert.equal(before.acl,baseline.acl);assert.equal(before.owner,baseline.owner);
 await client.query('SAVEPOINT preimage');
 await client.query(before.source.replace('-- A RETRIED REQUEST IS ANSWERED WITH THE PASS IT RAN.','-- altered original owner'));
 let error;try { await client.query(forward); }catch(e){error=e;}
 assert.equal(error?.code,'P0001');assert.match(error.message,/preimage differs/);
 await client.query('ROLLBACK TO SAVEPOINT preimage');
 await client.query(forward);await client.query(forward);
 assert.deepEqual(await read(),baseline);
 console.log('PASS exact rollback/preimage refusal/reapply twice');
 await client.query('ROLLBACK');
} finally {await client.end();}
