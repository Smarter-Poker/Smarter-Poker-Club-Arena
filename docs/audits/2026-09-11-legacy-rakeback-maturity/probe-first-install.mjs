#!/usr/bin/env node
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
  const entry = readFileSync(new URL('00-apply-legacy-repair.sql', import.meta.url), 'utf8');
  const paidCount = mode === 'first-install-all' ? 2 : 1;
  const baselineAuthority = await query(
    "SELECT oid::regprocedure::text signature,md5(prosrc) md5 FROM pg_proc WHERE oid IN('fn_claim_rakeback(uuid)'::regprocedure,'fn_close_settlement_period(uuid)'::regprocedure,'fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure) ORDER BY 1"
  );
  const absent = await query(
    "SELECT to_regprocedure('fn_ca_legacy_period_maturity()') maturity,to_regprocedure('fn_ca_legacy_round3_wallet_receipt()') receipt,to_regprocedure('fn_lock_rakeback_payer_clubs(uuid[])') admission,to_regclass('ca_cash_bank_receipts') source_bank"
  );
  assert.deepEqual(absent[0], {
    maturity: null,
    receipt: null,
    admission: null,
    source_bank: null,
  });
  if (paidCount === 1)
    await test('atomic first-install lock refusal preserves all original owners and creates no partial guard', async () => {
      const lock = await client('install_ddl_blocker', null);
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE wallet_transactions IN ROW EXCLUSIVE MODE');
      try {
        await assert.rejects(query(entry), (e) => e.code === '55P03');
        await query('ROLLBACK');
        assert.deepEqual(
          await query(
            "SELECT oid::regprocedure::text signature,md5(prosrc) md5 FROM pg_proc WHERE oid IN('fn_claim_rakeback(uuid)'::regprocedure,'fn_close_settlement_period(uuid)'::regprocedure,'fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure) ORDER BY 1"
          ),
          baselineAuthority
        );
        assert.equal(
          (await query("SELECT to_regprocedure('fn_ca_legacy_period_maturity()') value"))[0].value,
          null
        );
        assert.equal(
          (await query("SELECT to_regprocedure('fn_lock_rakeback_payer_clubs(uuid[])') value"))[0]
            .value,
          null
        );
      } finally {
        await lock.query('ROLLBACK');
        await lock.end();
      }
    });
  await test(
    'exact atomic first installation overlaps actual old Round3 ' +
      (paidCount === 2 ? 'all' : 'partially') +
      ' stale two-period caller',
    async () => {
      await reset({ agent: 100, treasury: 100 });
      await query(
        "INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,rakeback_earned) VALUES($1,$2,$3,'2026-08-24','2026-08-30',100,.15,15,15)",
        [uid(502), uid(201), uid(900)]
      );
      await query(
        "INSERT INTO rakeback_daily_state(club_id,day,rows_seen) SELECT $1,d::date,1 FROM generate_series('2026-08-24'::date,'2026-08-30'::date,'1 day')d",
        [uid(900)]
      );
      await query(
        "INSERT INTO rakeback_daily_user(club_id,day,user_id,cents) VALUES($1,'2026-08-24',$2,10000)",
        [uid(900), uid(201)]
      );
      const ledgerBefore = new Set((await query('SELECT id FROM chip_ledger')).map((x) => x.id));
      const blocker = await client('first_install_agent_blocker', null),
        old = await client('first_install_original_round3', 'service_role');
      const sql =
        "SELECT fn_settle_round3_agents_to_players('" +
        uid(999) +
        "','2026-08-24T00:00:00Z','2026-09-07T00:00:00Z') result";
      try {
        await old.query("SET statement_timeout='7s'");
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM club_members WHERE user_id=$1 FOR UPDATE', [uid(101)]);
        const pending = old.query(sql).then(
          (v) => ({ rows: v.rows }),
          (e) => ({ error: { code: e.code, message: e.message } })
        );
        const wait = await observeWait(db, 'first_install_original_round3');
        const money = await snapshot();
        await query(entry);
        assert.deepEqual(await snapshot(), money);
        const guards = await query(
          "SELECT tgname FROM pg_trigger WHERE tgname IN('ca_legacy_period_maturity','ca_legacy_round3_wallet_receipt') ORDER BY tgname"
        );
        assert.equal(guards.length, 2);
        assert.equal((await query(closeSql))[0].result.payout, 15);
        if (paidCount === 2)
          assert.equal(
            (await query('SELECT fn_close_settlement_period($1) result', [uid(502)]))[0].result
              .payout,
            15
          );
        const before = await snapshot(),
          periods = await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id');
        await blocker.query('COMMIT');
        const result = await pending;
        assert.equal(result.error?.code, '23514');
        assert.equal(result.error.message, 'Round3 requires the unique unpaid period receipt');
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(
          await query('SELECT row_to_json(p) value FROM rakeback_periods p ORDER BY id'),
          periods
        );
        const retry = (await query(sql))[0].result;
        assert.equal(retry.amount, paidCount === 1 ? 15 : 0);
        const state = await snapshot();
        assert.equal(state.player, '30.00');
        assert.equal(state.treasury, paidCount === 1 ? '85.00' : '70.00');
        assert.equal(state.agent, paidCount === 1 ? '85.00' : '100.00');
        assert.equal(state.receipts, 2);
        assert.equal(state.linked_receipts, 2);
        assert.equal(state.wallet_rows, 2);
        const legs = (
          await query(
            'SELECT id,from_type,from_entity_id,to_type,to_entity_id,amount,category FROM chip_ledger'
          )
        ).filter((x) => !ledgerBefore.has(x.id));
        let treasury = 0,
          agent = 0,
          player = 0,
          suspense = 0;
        for (const leg of legs) {
          assert.equal(Number(leg.amount), 15);
          if (
            leg.from_type === 'club_treasury' &&
            leg.from_entity_id === uid(900) &&
            leg.to_type === 'settlement_suspense'
          ) {
            treasury += 15;
            suspense += 15;
          } else if (
            leg.from_type === 'settlement_suspense' &&
            leg.to_type === 'player_wallet' &&
            leg.to_entity_id === uid(201)
          ) {
            player += 15;
            suspense -= 15;
          } else if (
            leg.from_type === 'player_wallet' &&
            leg.from_entity_id === uid(101) &&
            leg.to_type === 'player_wallet' &&
            leg.to_entity_id === uid(201)
          ) {
            agent += 15;
            player += 15;
          } else assert.fail('Unexpected first-install leg ' + JSON.stringify(leg));
        }
        assert.equal(treasury, paidCount * 15);
        assert.equal(agent, (2 - paidCount) * 15);
        assert.equal(player, 30);
        assert.equal(suspense, 0);
        assert.equal(legs.length, paidCount + 2);
        outcomes.push({
          evidence: 'actual_first_install',
          baselineAuthority,
          wait,
          guards,
          installed_while_original_frame_waited: true,
          table_fence_absent_before_call: true,
          result,
          retry,
          state,
          legs,
          treasury_debits: treasury,
          agent_debits: agent,
          player_credits: player,
          suspense_net: suspense,
        });
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.all([blocker.end(), old.end()]);
      }
    }
  );
  const authority = await query(
    "SELECT oid::regprocedure::text signature,md5(prosrc) prosrc_md5,prosecdef,pg_get_userbyid(proowner) owner,proacl::text acl FROM pg_proc WHERE oid IN('fn_claim_rakeback(uuid)'::regprocedure,'fn_close_settlement_period(uuid)'::regprocedure,'fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure,'fn_ca_legacy_period_maturity()'::regprocedure,'fn_ca_legacy_round3_wallet_receipt()'::regprocedure) ORDER BY 1"
  );
  writeFileSync(
    new URL(mode + '-proof.json', import.meta.url),
    JSON.stringify({ captured_at: new Date().toISOString(), mode, outcomes, authority }, null, 2) +
      '\n'
  );
  console.log(JSON.stringify({ mode, passed: outcomes.filter((x) => x.pass).length }));
} finally {
  await db.end();
}
