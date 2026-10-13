import { pathToFileURL } from 'node:url';
const { default: pg } = await import(pathToFileURL(process.env.PRUNER_PG_MODULE).href);
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const a = new pg.Client(),
  b = new pg.Client(),
  o = new pg.Client();
await a.connect();
await b.connect();
await o.connect();
try {
  const base = process.env.PRUNER_SOURCE_ROOT;
  await o.query('CREATE ROLE postgres');
  await o.query(readFileSync(process.env.PRUNER_BOOTSTRAP, 'utf8'));
  await o.query(readFileSync(base + '/ordinary-dependencies.sql', 'utf8'));
  await o.query(
    readFileSync(base + '/original.sql', 'utf8') +
      '; ALTER FUNCTION public.sp_prune_hand_history(integer) OWNER TO postgres; REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.sp_prune_hand_history(integer) TO postgres'
  );
  assert.equal((await b.query('SELECT sp_prune_hand_history(250) n')).rows[0].n, 0);
  await o.query(
    "INSERT INTO hand_history(id,has_human,created_at) VALUES('10000000-0000-0000-0000-000000000123',true,now()-interval '40 days')"
  );
  const retained = (
    await o.query(
      "SELECT to_jsonb(h) j FROM hand_history h WHERE id='10000000-0000-0000-0000-000000000123'"
    )
  ).rows[0].j;
  assert.equal((await b.query('SELECT sp_prune_hand_history(250) n')).rows[0].n, 0);
  await a.query(
    'BEGIN; SELECT pg_advisory_xact_lock(530090,1); LOCK public.chip_ledger,public.hand_history_retention_policy IN ACCESS EXCLUSIVE MODE'
  );
  const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const old = b
    .query("SET statement_timeout='2s'; SELECT sp_prune_hand_history(250)")
    .catch((e) => e);
  const deadline = Date.now() + 1500;
  while (
    !(
      await o.query(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='hand_history_retention_policy'::regclass AND NOT granted) yes`
      )
    ).rows[0].yes
  ) {
    assert.ok(Date.now() < deadline, 'Original reader did not enter the policy relation lock');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await old).code, '57014');
  await b.query('RESET statement_timeout');
  await o.query(readFileSync(process.env.PRUNER_MIGRATION, 'utf8'));
  const after = (
    await o.query(
      "SELECT pg_get_functiondef('sp_prune_hand_history(integer)'::regprocedure) definition"
    )
  ).rows[0].definition;
  assert.equal(after, readFileSync(base + '/expected.sql', 'utf8'));
  await assert.rejects(
    o.query(readFileSync(process.env.PRUNER_MIGRATION, 'utf8')),
    (e) => e.code === '55000' && e.message.includes('PRUNER_SETTLEMENT_LANE_SOURCE_CHANGED')
  );
  await o.query('ROLLBACK');
  await b.query('BEGIN');
  assert.equal((await b.query('SELECT sp_prune_hand_history(250) n')).rows[0].n, 0);
  assert.equal(
    (
      await o.query(
        `SELECT count(*)::int n FROM pg_locks WHERE pid=${pid} AND relation IN('chip_ledger'::regclass,'hand_history_retention_policy'::regclass)`
      )
    ).rows[0].n,
    0
  );
  await b.query('COMMIT');
  await a.query('COMMIT');
  assert.equal((await b.query('SELECT sp_prune_hand_history(250) n')).rows[0].n, 0);
  assert.deepEqual(
    (
      await o.query(
        "SELECT to_jsonb(h) j FROM hand_history h WHERE id='10000000-0000-0000-0000-000000000123'"
      )
    ).rows[0].j,
    retained
  );
  assert.equal(
    (await b.query('SELECT pg_try_advisory_xact_lock_shared(530090,1) yes')).rows[0].yes,
    true
  );
  // Original transaction-level lane permits ordinary concurrent readers and
  // does not let an installer interrupt an already admitted transaction.
  await b.query('BEGIN; SELECT pg_advisory_xact_lock_shared(530090,1)');
  assert.equal(
    (await a.query('SELECT pg_try_advisory_xact_lock(530090,1) yes')).rows[0].yes,
    false
  );
  await b.query('COMMIT');
  assert.equal((await a.query('SELECT pg_try_advisory_xact_lock(530090,1) yes')).rows[0].yes, true);
  console.log(
    JSON.stringify({
      qualified: true,
      original_reader_enters_policy_relation_access: true,
      new_pruner_returns_zero_before_relation_access: true,
      exact_original_body_and_authority_preserved: true,
      transaction_lane_release: true,
      replay_refused: true,
      ordinary_empty_prune_before_after_returns_zero: true,
      retained_human_history_byte_identical: true,
      full_eligible_horse_prune_fixture_run: false,
      production_actions: false,
    })
  );
} finally {
  await a.end();
  await b.end();
  await o.end();
}
