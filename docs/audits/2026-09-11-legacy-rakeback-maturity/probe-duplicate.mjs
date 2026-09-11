#!/usr/bin/env node
import { proveLegacyAggregate } from './aggregate-proof.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const outcomes = [];
const mode = process.argv[2] || 'maturity';
const baseline = mode === 'before' || mode === 'guards';
async function client(name, role = 'service_role') {
  assert.match(process.env.PGHOST || '', /^\/tmp\/ca-rakeback-payer\.[A-Za-z0-9_]+$/);
  const c = new Client({
    host: process.env.PGHOST,
    port: 55473,
    user: 'postgres',
    database: 'payer_test',
    application_name: name,
  });
  await c.connect();
  if (role) await c.query('SET ROLE ' + role);
  await c.query("SELECT set_config('request.jwt.claim.role',$1,false)", [role || 'service_role']);
  return c;
}
const db = await client('payer_admin', null);
async function query(sql, params = []) {
  return (await db.query(sql, params)).rows;
}
async function reset({ assigned = true, agent = 25, treasury = 20, period = 501 } = {}) {
  if (mode !== 'before') await query('TRUNCATE chip_ledger_idem');
  await query(
    'TRUNCATE rake_records,rake_attributions,rakeback_period_payouts,rakeback_periods,club_members,agents,clubs,union_clubs,rakeback_daily_user,rakeback_daily_state,chip_ledger,wallet_transactions,chip_transactions,wallet_credit_idempotency,ca_ledger_mutation_log,settlement_locks'
  );
  await query(
    "INSERT INTO clubs(id,name,owner_id,chip_treasury) VALUES($1,'Synthetic payer club',$2,$3)",
    [uid(900), uid(990), treasury]
  );
  await query('INSERT INTO union_clubs(union_id,club_id) VALUES($1,$2)', [uid(999), uid(900)]);
  await query(
    "INSERT INTO club_members(club_id,user_id,role,chip_balance,agent_id,player_rakeback_pct) VALUES($1,$2,'player',0,$3,.15),($1,$4,'agent',$5,NULL,0)",
    [uid(900), uid(201), assigned ? uid(101) : null, uid(101), agent]
  );
  await query(
    "INSERT INTO agents(id,user_id,club_id,role,commission_rate,player_rakeback_rate) VALUES($1,$2,$3,'agent',.25,.15)",
    [uid(1), uid(101), uid(900)]
  );
  await query(
    "INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned) VALUES($1,$2,$3,'2026-08-31','2026-09-06',100,.15,15,15)",
    [uid(period), uid(201), uid(900)]
  );
  await query(
    "INSERT INTO rakeback_daily_state(club_id,day,rows_seen) SELECT $1,d::date,1 FROM generate_series('2026-08-31'::date,'2026-09-06'::date,'1 day')d",
    [uid(900)]
  );
  await query(
    "INSERT INTO rakeback_daily_user(club_id,day,user_id,cents) VALUES($1,'2026-08-31',$2,10000)",
    [uid(900), uid(201)]
  );
}
const closeSql = "SELECT public.fn_close_settlement_period('" + uid(501) + "') result";
const claimSql = "SELECT public.fn_claim_rakeback('" + uid(900) + "') result";
const weeklySql =
  "SELECT public.fn_settle_round3_agents_to_players('" +
  uid(999) +
  "','2026-08-31T07:00:00Z','2026-09-07T07:00:00Z') result";
async function snapshot() {
  return (
    await query(
      "SELECT (SELECT chip_treasury::text FROM clubs WHERE id=$1) treasury,(SELECT chip_balance::text FROM club_members WHERE user_id=$2) agent,(SELECT chip_balance::text FROM club_members WHERE user_id=$3) player,(SELECT count(*)::int FROM rakeback_period_payouts) receipts,(SELECT count(*)::int FROM rakeback_period_payouts p JOIN wallet_transactions w ON w.id=p.wallet_transaction_id AND w.related_entity_id=p.id AND w.user_id=p.user_id AND w.amount=p.payout_amount) linked_receipts,(SELECT count(*)::int FROM chip_ledger WHERE category='rakeback') legs,(SELECT count(*)::int FROM wallet_transactions WHERE category='rakeback') wallet_rows",
      [uid(900), uid(101), uid(201)]
    )
  )[0];
}
async function observeWait(c, app) {
  for (let i = 0; i < 200; i++) {
    const rows = await c.query(
      'SELECT wait_event_type,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1',
      [app]
    );
    if (rows.rows[0]?.wait_event_type === 'Lock' && rows.rows[0].blockers.length) {
      return rows.rows[0];
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('No observed lock wait for ' + app);
}
async function race(firstSql, secondSql, label) {
  await reset({ agent: 100 });
  const blocker = await client(label + '_blocker', null);
  const a = await client(label + '_a'),
    b = await client(label + '_b', secondSql === claimSql ? 'authenticated' : 'service_role');
  if (secondSql === claimSql)
    await b.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(201)]);
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM club_members WHERE user_id=$1 FOR UPDATE', [uid(101)]);
  const first = a.query(firstSql).then(
    (value) => ({ value: value.rows }),
    (error) => ({ error: { code: error.code, message: error.message } })
  );
  const waitA = await observeWait(db, label + '_a');
  const second = b.query(secondSql).then(
    (value) => ({ value: value.rows }),
    (error) => ({ error: { code: error.code, message: error.message } })
  );
  let waitB;
  if (baseline && secondSql === claimSql) {
    await second;
    waitB = { completed_while_weekly_waited: true };
  } else waitB = await observeWait(db, label + '_b');
  await blocker.query('COMMIT');
  const callResults = await Promise.all([first, second]);
  const state = await snapshot();
  await Promise.all([a.end(), b.end(), blocker.end()]);
  return { state, waitA, waitB, callResults };
}
async function test(name, fn) {
  await fn();
  outcomes.push({ name, pass: true });
  console.log('PASS ' + name);
}
try {
  async function actor(sql) {
    const a = await client('maturity_authenticated', 'authenticated');
    try {
      await a.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid(201)]);
      return (await a.query(sql)).rows;
    } finally {
      await a.end();
    }
  }
  async function seedOpen({ zero = false } = {}) {
    await query(
      "INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned) VALUES($1,$2,$3,(statement_timestamp() AT TIME ZONE 'UTC')::date,(statement_timestamp() AT TIME ZONE 'UTC')::date+6,$4,.15,$5,$5)",
      [uid(502), uid(201), uid(900), zero ? 0 : 100, zero ? 0 : 15]
    );
    await query(
      "INSERT INTO rakeback_daily_state(club_id,day,rows_seen) SELECT $1,(statement_timestamp() AT TIME ZONE 'UTC')::date+n,1 FROM generate_series(0,6)n",
      [uid(900)]
    );
    if (!zero)
      await query(
        "INSERT INTO rakeback_daily_user(club_id,day,user_id,cents) VALUES($1,(statement_timestamp() AT TIME ZONE 'UTC')::date,$2,10000)",
        [uid(900), uid(201)]
      );
  }
  const original = JSON.parse(
    readFileSync(new URL('installed-catalog.json', import.meta.url), 'utf8')
  ).functions.find((f) => f.signature === 'fn_close_settlement_period(uuid)').definition;
  await query(
    original.replace('public.fn_close_settlement_period(', 'public.test_original_close(')
  );
  await test('legacy-only schema has no captured source prerequisites', async () => {
    const r = (
      await query(
        "SELECT to_regclass('public.hand_atomic_commits') hand,to_regclass('public.ca_cash_bank_receipts') bank,to_regprocedure('public.fn_ca_rakeback_period_has_captured(uuid,uuid,date,date)') helper"
      )
    )[0];
    assert.deepEqual(r, { hand: null, bank: null, helper: null });
  });
  await test('UI club-scoped claim pays mature period and leaves same-club open period accruing', async () => {
    await reset({ treasury: 100 });
    await seedOpen();
    const openBefore = await query(
      'SELECT row_to_json(p) value FROM rakeback_periods p WHERE id=$1',
      [uid(502)]
    );
    const result = (await actor(claimSql))[0].result;
    assert.equal(result.total_payout, 15);
    assert.equal(result.periods_claimed, 1);
    assert.deepEqual(
      await query('SELECT row_to_json(p) value FROM rakeback_periods p WHERE id=$1', [uid(502)]),
      openBefore
    );
    const s = await snapshot();
    assert.equal(s.player, '15.00');
    assert.equal(s.agent, '25.00');
    assert.equal(s.treasury, '85.00');
    assert.equal(s.receipts, 1);
    assert.equal(s.wallet_rows, 1);
    assert.equal(s.linked_receipts, 1);
    outcomes.push({ evidence: 'same_club_mixed', result, money: s, open_period_unchanged: true });
  });
  await test('direct low-level close refuses open period before any mutation', async () => {
    await reset();
    await seedOpen();
    const before = await snapshot();
    const row = await query('SELECT row_to_json(p) value FROM rakeback_periods p WHERE id=$1', [
      uid(502),
    ]);
    const result = (
      await query('SELECT public.fn_close_settlement_period($1) result', [uid(502)])
    )[0].result;
    assert.equal(result.deferred, 'earning_period_open');
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      await query('SELECT row_to_json(p) value FROM rakeback_periods p WHERE id=$1', [uid(502)]),
      row
    );
  });
  for (const zero of [false, true])
    await test(
      'captured original ' +
        (zero ? 'zero' : 'positive') +
        ' open close rolls back at status fence',
      async () => {
        await reset({ treasury: 100 });
        await seedOpen({ zero });
        const before = await snapshot();
        const row = await query('SELECT row_to_json(p) value FROM rakeback_periods p WHERE id=$1', [
          uid(502),
        ]);
        await assert.rejects(
          query('SELECT public.test_original_close($1)', [uid(502)]),
          (e) =>
            e.code === '40001' &&
            e.message === 'Legacy period payment requires a closed earning period'
        );
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(
          await query('SELECT row_to_json(p) value FROM rakeback_periods p WHERE id=$1', [
            uid(502),
          ]),
          row
        );
      }
    );
  await test('already-paid history is unchanged by claim and replay', async () => {
    await reset();
    await actor(claimSql);
    const before = await query('SELECT row_to_json(p) value FROM rakeback_periods p');
    const money = await snapshot();
    await actor(claimSql);
    await query(closeSql);
    assert.deepEqual(await query('SELECT row_to_json(p) value FROM rakeback_periods p'), before);
    assert.deepEqual(await snapshot(), money);
  });
  await test('UTC maturity and cold scan remain correct after UTC rollover across session timezones', async () => {
    const states = [];
    for (const zone of ['UTC', 'Pacific/Honolulu']) {
      await reset();
      await query('TRUNCATE rakeback_daily_state,rakeback_daily_user');
      await query(
        "UPDATE rakeback_periods SET period_start=(statement_timestamp() AT TIME ZONE 'UTC')::date-1,period_end=(statement_timestamp() AT TIME ZONE 'UTC')::date-1"
      );
      await query(
        "INSERT INTO rake_records(hand_id,club_id,created_at,rake_amount,player_contributions,rake_method) VALUES($1,$2,date_trunc('day',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '23 hours 30 minutes',100,jsonb_build_object($3::text,1),'WEIGHTED_CONTRIBUTED')",
        [uid(701), uid(900), uid(201)]
      );
      await query('INSERT INTO rake_attributions VALUES($1,$2,100)', [uid(701), uid(201)]);
      await query("SELECT set_config('TimeZone',$1,false)", [zone]);
      try {
        const result = (await query(closeSql))[0].result;
        assert.equal(result.payout, 15);
        assert.equal(result.from_rollup, false);
        states.push(await snapshot());
      } finally {
        await query("SET TIME ZONE 'UTC'");
      }
    }
    assert.deepEqual(states[0], states[1]);
  });
  await test('final journal failure rolls back the unchanged legacy funding path', async () => {
    await reset();
    const before = await snapshot();
    const a = await client('maturity_fault', 'authenticated');
    try {
      await a.query(
        "SELECT set_config('request.jwt.claim.sub',$1,false),set_config('test.fail_journal','1',false)",
        [uid(201)]
      );
      await assert.rejects(
        a.query(claimSql),
        (e) => e.message === 'injected final journal failure'
      );
    } finally {
      await a.end();
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal((await query('SELECT status FROM rakeback_periods'))[0].status, 'pending');
  });
  await test('captured original existing-receipt branch cannot finalize an open period', async () => {
    await reset({ treasury: 100 });
    await seedOpen();
    await query(
      "INSERT INTO rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at) VALUES($1,$2,$3,100,15,15,'paid',now())",
      [uid(502), uid(900), uid(201)]
    );
    const before = await snapshot();
    const periods = await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id');
    const receipts = await query(
      'SELECT row_to_json(p) value FROM rakeback_period_payouts p ORDER BY id'
    );
    await assert.rejects(
      query('SELECT public.test_original_close($1)', [uid(502)]),
      (e) =>
        e.code === '40001' && e.message === 'Legacy period payment requires a closed earning period'
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id'),
      periods
    );
    assert.deepEqual(
      await query('SELECT row_to_json(p) value FROM rakeback_period_payouts p ORDER BY id'),
      receipts
    );
  });
  await test('expired historical period remains unchanged on low-level replay', async () => {
    await reset();
    await query("UPDATE rakeback_periods SET status='expired'");
    const before = await query('SELECT row_to_json(p) value FROM rakeback_periods p');
    const money = await snapshot();
    const result = (await query(closeSql))[0].result;
    assert.equal(result.skipped, 'expired');
    assert.deepEqual(await query('SELECT row_to_json(p) value FROM rakeback_periods p'), before);
    assert.deepEqual(await snapshot(), money);
  });
  await proveLegacyAggregate({
    assert,
    query,
    reset,
    snapshot,
    client,
    observeWait,
    test,
    outcomes,
    uid,
    readFileSync,
    rootURL: import.meta.url,
    claimSql,
    closeSql,
    db,
  });
  const authority = await query(
    "SELECT p.oid::regprocedure::text signature,md5(p.prosrc) prosrc_md5,p.prosecdef,pg_get_userbyid(p.proowner) owner,p.proacl::text acl FROM pg_proc p WHERE p.oid IN('public.fn_claim_rakeback(uuid)'::regprocedure,'public.fn_close_settlement_period(uuid)'::regprocedure,'public.fn_ca_legacy_period_maturity()'::regprocedure,'public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_ca_legacy_round3_wallet_receipt()'::regprocedure) ORDER BY signature"
  );
  writeFileSync(
    new URL('duplicate-proof.json', import.meta.url),
    JSON.stringify({ captured_at: new Date().toISOString(), outcomes, authority }, null, 2) + '\n'
  );
  console.log(JSON.stringify({ passed: outcomes.filter((x) => x.pass).length }));
} finally {
  await db.end();
}
