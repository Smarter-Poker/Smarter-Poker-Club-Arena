import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const socket = process.argv[2];
assert(socket?.startsWith('/tmp/codex-throwables-db.') && socket.endsWith('/socket'), 'Only the task-owned local Unix socket is allowed');
const config = { host: socket, port: 55437, user: 'throwable_test', database: 'postgres', connectionTimeoutMillis: 5000 };
const admin = new pg.Client(config);
await admin.connect();
const directory = (await admin.query('show data_directory')).rows[0].data_directory;
assert.equal(fs.realpathSync(directory), fs.realpathSync(path.join(path.dirname(socket), 'data')));
assert.equal((await admin.query('select inet_server_addr() as addr')).rows[0].addr, null);
const name = `throwable_contract_${crypto.randomBytes(6).toString('hex')}`;
await admin.query(`create database ${name}`);
config.database = name;
const clients = new Set();
const results = [];
async function connect(uid) {
  const c = new pg.Client(config); await c.connect(); clients.add(c);
  await c.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role','authenticated',false)", [uid ?? '']);
  return c;
}
const db = await connect();
const root = path.dirname(new URL(import.meta.url).pathname);
const functions = fs.readFileSync(path.join(root, 'production-functions-20260908.sql'), 'utf8');
await db.query(fs.readFileSync(path.join(root, 'local-schema.sql'), 'utf8'));
await db.query(functions);
async function user({ vip = false, tier = null, expired = false, diamonds = 10, used = 0, previous = 0 } = {}) {
  const id = crypto.randomUUID();
  await db.query("insert into profiles(id,is_vip,vip_tier,vip_expires_at,diamonds,diamond_balance) values($1,$2,$3,case when $4 then now()-interval '1 day' else null end,$5,$5)", [id,vip,tier,expired,diamonds]);
  if (used) await db.query("insert into throw_usage(user_id,throwable_id,paid_diamonds,created_at) select $1,'beer',false,now()-interval '10 seconds' from generate_series(1,$2::int)", [id,used]);
  if (previous) await db.query("insert into throw_usage(user_id,throwable_id,paid_diamonds,created_at) select $1,'beer',false,(date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')-interval '1 millisecond' from generate_series(1,$2::int)", [id,previous]);
  return id;
}
async function use(c, request = crypto.randomUUID(), item = 'beer') {
  return (await c.query('select fn_use_throwable_v2($1,$2) as result',[item,request])).rows[0].result;
}
async function balance(uid) { return (await db.query('select diamonds from profiles where id=$1',[uid])).rows[0].diamonds; }
async function count(table, uid) { return Number((await db.query(`select count(*) from ${table} where user_id=$1`,[uid])).rows[0].count); }
async function check(name, fn) { await fn(); results.push({ name, passed: true }); }
async function pack(uid, uses, age = 1) {
  return (await db.query("insert into feature_purchases(user_id,feature,uses_remaining,created_at) values($1,'throwable',$2,now()-make_interval(days=>$3)) returning id",[uid,uses,age])).rows[0].id;
}

try {
  await check('Unauthenticated use writes nothing', async () => { assert.equal((await use(db)).error, 'Authentication Required'); });
  await check('500th VIP throw is free', async () => {
    const id = await user({ vip:true, used:499 }); const c = await connect(id); const r = await use(c);
    assert.equal(r.source,'vip_monthly'); assert.equal(r.free_remaining,0); assert.equal(await balance(id),10);
  });
  await check('501st VIP throw charges exactly one diamond', async () => {
    const id = await user({ vip:true, used:500 }); const c = await connect(id); const r = await use(c);
    assert.equal(r.source,'diamonds'); assert.equal(await balance(id),9); assert.equal(await count('diamond_transactions',id),1);
  });
  await check('UTC month excludes prior-month usage despite session timezone', async () => {
    const id = await user({ vip:true, previous:500 }); const c = await connect(id); await c.query("set timezone='Pacific/Honolulu'");
    assert.equal((await use(c)).free_remaining,499);
  });
  await check('Expired VIP with a null tier receives no VIP allowance', async () => {
    const id = await user({ vip:true, expired:true }); const c = await connect(id); assert.equal((await use(c)).source,'diamonds');
  });
  await check('Lifetime remains unlimited above 500', async () => {
    const id = await user({ vip:true, tier:'lifetime', expired:true, used:700 }); const c = await connect(id);
    assert.equal((await use(c)).source,'lifetime_vip'); assert.equal(await balance(id),10);
  });
  await check('Oldest pack is consumed before diamonds', async () => {
    const id = await user(); const first = await pack(id,2,2); const second = await pack(id,8,1); const c = await connect(id);
    assert.equal((await use(c)).source,'purchased'); assert.equal(await balance(id),10);
    assert.equal((await db.query('select uses_remaining from feature_purchases where id=$1',[first])).rows[0].uses_remaining,1);
    assert.equal((await db.query('select uses_remaining from feature_purchases where id=$1',[second])).rows[0].uses_remaining,8);
  });
  await check('Eight concurrent retries spend once and replay seven receipts', async () => {
    const id = await user(); const cs = await Promise.all(Array.from({ length:8 },()=>connect(id))); const req=crypto.randomUUID();
    const rs=await Promise.all(cs.map(c=>use(c,req)));
    assert.equal(rs.filter(r=>r.idempotent).length,7); assert.equal(await balance(id),9);
    assert.equal(await count('throw_usage',id),1); assert.equal(await count('throwable_use_receipts',id),1);
  });
  await check('Concurrent different requests enforce the account cooldown', async () => {
    const id=await user(); const cs=await Promise.all(Array.from({ length:4 },()=>connect(id))); const rs=await Promise.all(cs.map(c=>use(c)));
    assert.equal(rs.filter(r=>r.success).length,1); assert.equal(rs.filter(r=>r.code==='RATE_LIMITED').length,3); assert.equal(await balance(id),9);
  });
  await check('Insufficient diamonds leave all records unchanged', async () => {
    const id=await user({ diamonds:0 }); const c=await connect(id); assert.equal((await use(c)).success,false);
    assert.equal(await count('throw_usage',id),0); assert.equal(await count('throwable_use_receipts',id),0); assert.equal(await count('diamond_transactions',id),0);
  });
  await check('A receipt insertion failure rolls back the charge and usage atomically', async () => {
    const id=await user(); const c=await connect(id);
    await db.query("create function test_receipt_failure() returns trigger language plpgsql as $$ begin raise exception 'Injected receipt failure'; end $$; create trigger fail_receipt before insert on throwable_use_receipts for each row execute function test_receipt_failure()");
    await assert.rejects(()=>use(c),/Injected receipt failure/);
    await db.query('drop trigger fail_receipt on throwable_use_receipts');
    assert.equal(await balance(id),10); assert.equal(await count('throw_usage',id),0); assert.equal(await count('diamond_transactions',id),0);
  });
  let observedBug;
  await check('Reproduce: a locked valid pack is skipped and a diamond is wrongly charged', async () => {
    const id=await user(); const credit=await pack(id,1); const locker=await connect(id); const c=await connect(id);
    await locker.query('begin'); await locker.query('select id from feature_purchases where id=$1 for update',[credit]);
    try { observedBug=await use(c); assert.equal(observedBug.source,'diamonds'); assert.equal(await balance(id),9); }
    finally { await locker.query('rollback'); }
  });
  const v2=functions.slice(functions.indexOf('CREATE OR REPLACE FUNCTION public.fn_use_throwable_v2'));
  assert.equal((v2.match(/FOR UPDATE SKIP LOCKED/g)||[]).length,1);
  await db.query(fs.readFileSync(path.resolve(root, '../../supabase/migrations/20260908021633_throwable_wait_for_owned_pack_credit.sql'), 'utf8'));
  await check('Candidate fix waits for the pack row and consumes credit without a diamond debit', async () => {
    const id=await user(); const credit=await pack(id,1); const locker=await connect(id); const c=await connect(id);
    await locker.query('begin'); await locker.query('select id from feature_purchases where id=$1 for update',[credit]);
    const pending=use(c);
    try {
      const deadline=Date.now()+3000; let blocked=false;
      while(Date.now()<deadline) {
        blocked=(await db.query('select wait_event_type from pg_stat_activity where pid=$1',[c.processID])).rows[0]?.wait_event_type==='Lock';
        if(blocked)break;
        await new Promise(r=>setTimeout(r,10));
      }
      assert(blocked,'The request must wait for its owned pack');
      await locker.query('commit'); const r=await pending;
      assert.equal(r.source,'purchased'); assert.equal(await balance(id),10);
    } finally { await locker.query('rollback'); }
  });
  await check('Reproduce: a delayed transaction records an old usage time and bypasses cooldown', async () => {
    const id=await user(); const c=await connect(id);
    await c.query('begin'); await c.query('select pg_sleep(1.6)');
    assert.equal((await use(c)).success,true); await c.query('commit');
    assert.equal((await use(c)).success,true); assert.equal(await balance(id),8);
  });
  await db.query(fs.readFileSync(path.resolve(root, '../../supabase/migrations/20260908023324_throwable_record_actual_consumption_time.sql'), 'utf8'));
  for (const kind of ['diamonds','vip','lifetime','pack']) await check(`Cooldown uses actual consumption time for ${kind} after a delayed transaction`, async () => {
    const id=await user({ vip:kind==='vip'||kind==='lifetime', tier:kind==='lifetime'?'lifetime':null });
    if(kind==='pack')await pack(id,2);
    const c=await connect(id); const req=crypto.randomUUID();
    await c.query('begin'); await c.query('select pg_sleep(1.6)');
    assert.equal((await use(c,req)).success,true); await c.query('commit');
    assert.equal((await use(c)).code,'RATE_LIMITED');
    assert.equal((await use(c,req)).idempotent,true);
    assert.equal(await count('throw_usage',id),1);
  });
  await db.query(fs.readFileSync(path.resolve(root, '../../supabase/migrations/20260908040103_throwable_member_monthly_allowance.sql'), 'utf8'));
  await check('30th member throw is free even with zero diamonds', async () => {
    const id=await user({ used:29,diamonds:0 }); const c=await connect(id); const r=await use(c);
    assert.equal(r.source,'member_monthly'); assert.equal(r.free_remaining,0); assert.equal(await balance(id),0);
  });
  await check('Member allowance precedes a purchased pack', async () => {
    const id=await user(); const credit=await pack(id,2); const c=await connect(id);
    assert.equal((await use(c)).source,'member_monthly');
    assert.equal((await db.query('select uses_remaining from feature_purchases where id=$1',[credit])).rows[0].uses_remaining,2);
  });
  await check('After 30 member throws, packs precede diamonds', async () => {
    const id=await user({used:30}); await pack(id,1); const c=await connect(id);
    assert.equal((await use(c)).source,'purchased'); assert.equal(await balance(id),10);
  });
  await check('31st member throw with no pack costs exactly one diamond', async () => {
    const id=await user({used:30}); const c=await connect(id);
    assert.equal((await use(c)).source,'diamonds'); assert.equal(await balance(id),9);
  });
  await check('VIP still has 500 and Lifetime remains unlimited after the member policy', async () => {
    const id=await user({vip:true,used:499}); const c=await connect(id);
    assert.equal((await use(c)).free_remaining,0);
    const lifetime=await user({vip:true,tier:'lifetime',used:900});
    assert.equal((await use(await connect(lifetime))).source,'lifetime_vip');
  });
  await check('Expired VIP falls back to the ordinary member allowance', async () => {
    const id=await user({vip:true,expired:true}); const c=await connect(id);
    assert.equal((await use(c)).source,'member_monthly'); assert.equal(await balance(id),10);
  });
  await check('Concurrent member requests cannot overrun the last free throw', async () => {
    const id=await user({used:29}); const cs=await Promise.all(Array.from({length:4},()=>connect(id)));
    const rs=await Promise.all(cs.map(c=>use(c)));
    assert.equal(rs.filter(r=>r.success).length,1); assert.equal(rs.filter(r=>r.code==='RATE_LIMITED').length,3);
    assert.equal(await balance(id),10); assert.equal(await count('throw_usage',id),30);
  });
  fs.writeFileSync(path.join(root,'local-postgres-results.json'),JSON.stringify({postgres:(await db.query('select version()')).rows[0].version,scope:'Exported production functions on synthetic local tables; not production RLS, triggers, HTTP auth, or browser verification.',results,observedBug,candidateAppliedToThisLocalDatabase:true},null,2)+'\n');
  console.log(`${results.length} PostgreSQL contract checks passed. Locked-pack charge and delayed-transaction cooldown bugs reproduced; exact local migrations verified.`);
} finally {
  await Promise.all([...clients].map(c=>c.end())); await admin.end();
}
