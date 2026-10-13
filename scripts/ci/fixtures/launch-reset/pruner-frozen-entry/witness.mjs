import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const { default: pg } = await import(pathToFileURL(process.env.PRUNER_PG_MODULE).href);
const a = new pg.Client(),
  b = new pg.Client(),
  o = new pg.Client();
await Promise.all([a.connect(), b.connect(), o.connect()]);
const guards = [
  '  -- Retention never holds the maintenance lane while the platform is frozen.\n  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;\n',
  '  -- Recheck after admission before the policy and accounting reads.\n  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;\n',
];
const identity = `SELECT pg_get_functiondef(p.oid) definition, p.proowner, p.prosecdef,
 p.proconfig, p.proacl FROM pg_proc p WHERE p.oid='public.sp_prune_hand_history(integer)'::regprocedure`;
try {
  const preimage = readFileSync(process.env.PRUNER_PREIMAGE, 'utf8');
  assert.equal(
    createHash('md5').update(preimage).digest('hex'),
    'c978edad9c8a6b2e93a4cb3016ab96ec'
  );
  await o.query('CREATE ROLE postgres');
  await o.query(readFileSync(process.env.PRUNER_BOOTSTRAP, 'utf8'));
  await o.query(readFileSync(process.env.PRUNER_DEPENDENCIES, 'utf8'));
  await o.query(
    preimage +
      `; ALTER FUNCTION public.sp_prune_hand_history(integer) OWNER TO postgres;
    REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.sp_prune_hand_history(integer) TO postgres`
  );
  const before = (await o.query(identity)).rows[0];
  await o.query(`CREATE TABLE public.pruner_freeze_fixture(value boolean, flip boolean, calls integer);
    INSERT INTO public.pruner_freeze_fixture VALUES(true,false,0);
    CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE plpgsql VOLATILE
    SET search_path TO public,pg_temp AS $$DECLARE answer boolean; BEGIN
      UPDATE public.pruner_freeze_fixture SET calls=calls+1
      RETURNING CASE WHEN flip THEN calls>1 ELSE value END INTO answer; RETURN answer; END$$;
    INSERT INTO public.hand_history(id,has_human,created_at)
      VALUES('10000000-0000-4000-8000-000000000123',true,now()-interval '40 days')`);
  const rows = async () =>
    (await o.query('SELECT to_jsonb(h) row FROM public.hand_history h ORDER BY id')).rows;
  const retained = await rows();
  await a.query(
    'BEGIN; LOCK public.chip_ledger,public.hand_history_retention_policy IN ACCESS EXCLUSIVE MODE'
  );
  const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const old = b
    .query("SET statement_timeout='2s'; SELECT public.sp_prune_hand_history(250)")
    .catch((e) => e);
  const deadline = Date.now() + 1500;
  while (
    !(
      await o.query(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1
      AND relation='public.hand_history_retention_policy'::regclass AND NOT granted) yes`,
        [pid]
      )
    ).rows[0].yes
  ) {
    assert.ok(Date.now() < deadline, 'Frozen preimage did not enter the policy relation');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await old).code, '57014');
  await b.query("SET statement_timeout='2s'");
  const migration = readFileSync(process.env.PRUNER_MIGRATION, 'utf8');
  await o.query(migration);
  const after = (await o.query(identity)).rows[0];
  let stripped = after.definition;
  for (const guard of guards) {
    assert.equal(
      stripped.split(guard).length - 1,
      1,
      'Each authoritative freeze observation must remain once'
    );
    stripped = stripped.replace(guard, '');
  }
  assert.equal(stripped, before.definition, 'Only the two entry guards may change');
  assert.equal(
    createHash('md5').update(after.definition).digest('hex'),
    'd899ca6bd7ded6ca33850c6d6e59ffed'
  );
  for (const key of ['proowner', 'prosecdef', 'proconfig', 'proacl'])
    assert.deepEqual(after[key], before[key]);
  for (const value of [true, null]) {
    await o.query('UPDATE public.pruner_freeze_fixture SET value=$1,flip=false,calls=0', [value]);
    await b.query('BEGIN');
    assert.equal((await b.query('SELECT public.sp_prune_hand_history(250) n')).rows[0].n, 0);
    assert.equal(
      (
        await o.query(
          `SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND
      (locktype='advisory' OR relation IN('chip_ledger'::regclass,'hand_history_retention_policy'::regclass))`,
          [pid]
        )
      ).rows[0].n,
      0
    );
    await b.query('COMMIT');
    assert.deepEqual(await rows(), retained);
  }
  // The first observation admits the lane; a deterministic second observation
  // changes to frozen before any policy or accounting relation is touched.
  await o.query('UPDATE public.pruner_freeze_fixture SET value=false,flip=true,calls=0');
  await b.query('BEGIN');
  assert.equal((await b.query('SELECT public.sp_prune_hand_history(250) n')).rows[0].n, 0);
  assert.equal(
    (
      await o.query(
        `SELECT count(*)::int n FROM pg_locks WHERE pid=$1
    AND relation IN('chip_ledger'::regclass,'hand_history_retention_policy'::regclass)`,
        [pid]
      )
    ).rows[0].n,
    0
  );
  await b.query('COMMIT');
  assert.equal((await o.query('SELECT calls FROM public.pruner_freeze_fixture')).rows[0].calls, 2);
  assert.deepEqual(await rows(), retained);
  await a.query('COMMIT');
  await o.query('UPDATE public.pruner_freeze_fixture SET value=false,flip=false,calls=0');
  assert.equal((await b.query('SELECT public.sp_prune_hand_history(250) n')).rows[0].n, 0);
  assert.deepEqual(await rows(), retained);
  await a.query('BEGIN; SELECT pg_advisory_xact_lock(530090,1)');
  assert.equal((await b.query('SELECT public.sp_prune_hand_history(250) n')).rows[0].n, 0);
  await a.query('COMMIT');
  await b.query('BEGIN; SELECT public.sp_prune_hand_history(250)');
  assert.equal(
    (await a.query('SELECT pg_try_advisory_xact_lock(530090,1) yes')).rows[0].yes,
    false
  );
  await b.query('COMMIT');
  assert.equal((await a.query('SELECT pg_try_advisory_xact_lock(530090,1) yes')).rows[0].yes, true);
  await assert.rejects(
    o.query(migration),
    (e) => e.code === '55000' && e.message.includes('PRUNER_FROZEN_ENTRY_SOURCE_CHANGED')
  );
  await o.query('ROLLBACK');
  console.log(
    JSON.stringify({
      qualified: true,
      original_source_md5: 'c978edad9c8a6b2e93a4cb3016ab96ec',
      frozen_preimage_enters_locked_policy_relation: true,
      frozen_and_unknown_return_before_all_locks: true,
      second_freeze_observation_refuses_before_relation_access: true,
      retained_rows_byte_identical: true,
      normal_empty_and_human_parity: true,
      original_installer_and_shared_lane_preserved: true,
      exact_body_and_authority_preserved: true,
      replay_refused: true,
      full_eligible_horse_prune_fixture_run: false,
      freeze_observations_fixture_only: true,
      production_actions: false,
    })
  );
} finally {
  await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK'), o.query('ROLLBACK')]);
  await Promise.all([a.end(), b.end(), o.end()]);
}
