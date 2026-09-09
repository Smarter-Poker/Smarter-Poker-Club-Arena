import pg from 'pg';
import assert from 'node:assert/strict';
import fs from 'node:fs';

assert.ok(process.env.PGHOST?.startsWith('/'), 'Requires an isolated Unix socket');
assert.ok(
  ['journal_test', 'maintenance_test'].includes(process.env.PGUSER),
  'Requires test DB owner'
);
const root = new URL('../../../../../', import.meta.url);
const schema = 'maintenance_expiry_probe';
const baseline = fs.readFileSync(
  new URL(
    'supabase/migrations/20260908042800_maintenance_announcement_and_entry_purchases_are_serialized.sql',
    root
  ),
  'utf8'
);
const migration = fs.readFileSync(
  new URL(
    'supabase/migrations/20260909001350_expired_maintenance_owners_cannot_block_a_new_hour.sql',
    root
  ),
  'utf8'
);
const lifetimeMigration = fs.readFileSync(
  new URL(
    'supabase/migrations/20260909180615_maintenance_ownership_fits_process_lifetime.sql',
    root
  ),
  'utf8'
);
const remap = (sql) =>
  sql
    .replaceAll('public.', schema + '.')
    .replaceAll(
      'search_path = public, auth, pg_temp',
      'search_path = ' + schema + ', auth, pg_temp'
    )
    .replaceAll('search_path = public, pg_temp', 'search_path = ' + schema + ', pg_temp')
    .replaceAll("routine_schema = 'public'", "routine_schema = '" + schema + "'");
function definition(name) {
  const start = baseline.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  assert.ok(start >= 0, name);
  const end = baseline.indexOf('$function$;', start);
  assert.ok(end > start, name);
  return remap(baseline.slice(start, end + '$function$;'.length));
}
const control = new pg.Client();
const holder = new pg.Client();
const writer = new pg.Client();
const clients = [control, holder, writer];
const oldOwner = '11111111-1111-4111-8111-111111111111';
const newOwner = '22222222-2222-4222-8222-222222222222';
const otherOwner = '33333333-3333-4333-8333-333333333333';
const signature =
  schema +
  '.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)';
let checks = 0;
function check(actual, expected, reason) {
  assert.deepEqual(actual, expected, reason);
  checks++;
}
const stamp = (delta) => new Date(Date.now() + delta).toISOString();
const fresh = (token = newOwner, patch = {}) => ({
  phase: 'last_hand',
  announced: stamp(0),
  started: null,
  ends: null,
  reason: 'Scheduled Engine Maintenance',
  version: 'new-build',
  token,
  ...patch,
});
const values = (x) => [x.phase, x.announced, x.started, x.ends, x.reason, x.version, x.token];
const save = (x, db = control) =>
  db.query(
    'SELECT ' + schema + '.fn_save_engine_maintenance_break($1,$2,$3,$4,$5,$6,$7)',
    values(x)
  );
const claim = (expected, replacement, db = control) =>
  db.query('SELECT ' + schema + '.fn_claim_engine_maintenance_break($1,$2,$3) AS result', [
    expected,
    replacement,
    'replacement-build',
  ]);
const read = async () =>
  (await control.query('SELECT to_jsonb(b) AS row FROM ' + schema + '.engine_maintenance_break b'))
    .rows[0]?.row;
async function seed(patch = {}) {
  await control.query('DELETE FROM ' + schema + '.engine_maintenance_break');
  const row = fresh(oldOwner, { announced: stamp(-120 * 60000), version: 'old-build', ...patch });
  await control.query(
    'INSERT INTO ' +
      schema +
      '.engine_maintenance_break ' +
      '(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,ownership_token,enforce_freeze,updated_at) ' +
      'VALUES(true,$1,$2,$3,$4,$5,$6,$7,true,clock_timestamp())',
    values(row)
  );
  return row;
}
async function rejectUnchanged(request, reason, code = '40001') {
  const before = await read();
  await assert.rejects(save(request), { code }, reason);
  checks++;
  check(await read(), before, reason + ': no state change');
}
async function waitForAdvisoryWait(pid) {
  for (let i = 0; i < 100; i++) {
    const row = (await control.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid]))
      .rows[0];
    if (row?.wait_event === 'advisory') {
      checks++;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('writer did not wait for the existing maintenance boundary');
}
async function asBrowserRole(role, body) {
  assert.ok(['anon', 'authenticated'].includes(role), 'fixed browser test role');
  await holder.query('SET ROLE ' + role);
  await holder.query("SELECT set_config('request.jwt.claim.role',$1,false)", [role]);
  try {
    return await body(holder);
  } finally {
    await holder.query('RESET ROLE');
    await holder.query("SELECT set_config('request.jwt.claim.role','',false)");
  }
}

try {
  await Promise.all(clients.map((client) => client.connect()));
  await control.query('CREATE SCHEMA ' + schema);
  await control.query(`DO $roles$ BEGIN
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $roles$;`);
  await control.query(`CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.role',true),'')::text
    $$;`);
  await control.query(`CREATE TABLE ${schema}.engine_maintenance_break (
    id boolean PRIMARY KEY CHECK(id), phase text NOT NULL CHECK(phase IN ('last_hand','counting_down')),
    announced_at timestamptz NOT NULL, break_started_at timestamptz, break_ends_at timestamptz,
    reason text NOT NULL, declared_by text, ownership_token uuid NOT NULL,
    enforce_freeze boolean NOT NULL, updated_at timestamptz NOT NULL);
    ALTER TABLE ${schema}.engine_maintenance_break ENABLE ROW LEVEL SECURITY;
    CREATE POLICY maintenance_break_is_public
      ON ${schema}.engine_maintenance_break FOR SELECT TO anon, authenticated USING (true);
    GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role;
    GRANT SELECT ON ${schema}.engine_maintenance_break TO anon, authenticated;`);
  await control.query(`CREATE TABLE ${schema}.engine_maintenance_thaws (
    freeze_started_at timestamptz PRIMARY KEY,
    thawed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    frozen_seconds numeric NOT NULL,
    shifted jsonb NOT NULL,
    thawed_by text
  );
  ALTER TABLE ${schema}.engine_maintenance_thaws ENABLE ROW LEVEL SECURITY;
  -- Reproduce the historical Supabase public-schema defaults. The ownership
  -- migration must remove these grants itself instead of relying on an already
  -- hardened fixture that production did not have.
  GRANT ALL ON ${schema}.engine_maintenance_thaws TO anon, authenticated;`);
  await control.query(`
    CREATE TABLE ${schema}.table_seats(
      id uuid PRIMARY KEY, left_at timestamptz, sit_out_at timestamptz);
    CREATE TABLE ${schema}.table_waitlist(
      id uuid PRIMARY KEY, hold_expires_at timestamptz);
    CREATE TABLE ${schema}.tournaments(
      id uuid PRIMARY KEY, addon_period_ends_at timestamptz,
      status text, on_break boolean, level_started_at timestamptz);
    CREATE TABLE ${schema}.chip_transactions(
      id uuid PRIMARY KEY, reversible_until timestamptz);
    CREATE TABLE ${schema}.tournament_bounty_awards(
      id uuid PRIMARY KEY, reveal_deadline_at timestamptz);
    CREATE TABLE ${schema}.tournament_players(
      id uuid PRIMARY KEY, rebuy_prompt_until timestamptz);
    CREATE TABLE ${schema}.tables(
      id uuid PRIMARY KEY, bomb_pot_next_due_at timestamptz,
      break_eligible_since timestamptz, cluster_id uuid);
    CREATE TABLE ${schema}.cash_player_session(
      id uuid PRIMARY KEY, closed_at timestamptz, stay_running boolean,
      stay_last_tick_at timestamptz NOT NULL);
    CREATE TABLE ${schema}.cash_rejoin_constraints(
      id uuid PRIMARY KEY, expires_at timestamptz NOT NULL);
    CREATE TABLE ${schema}.cash_seat_moves(
      id uuid PRIMARY KEY, state text, expires_at timestamptz NOT NULL);
    CREATE TABLE ${schema}.engine_presence_parked(
      table_id uuid PRIMARY KEY, disconnect_states jsonb NOT NULL,
      parked_at timestamptz NOT NULL);
    CREATE TABLE ${schema}.hand_state_snapshots(
      id uuid PRIMARY KEY, disconnect_states jsonb NOT NULL,
      is_complete boolean NOT NULL, updated_at timestamptz NOT NULL);
  `);
  // The lifetime migration wraps the already-deployed checkpointed thaw. This
  // isolated probe needs only its signature and an observable result; the full
  // fn_thaw_platform behavior has its own PostgreSQL runtime harness.
  await control.query(`CREATE FUNCTION ${schema}.fn_thaw_platform(
      p_freeze_started timestamptz,
      p_frozen_seconds numeric,
      p_thawed_by text DEFAULT NULL::text
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = ${schema}, pg_temp
    AS $$
    DECLARE v_shifted jsonb; v_effective_seconds numeric;
    BEGIN
      IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
        RETURN jsonb_build_object(
          'ok',false,'complete',false,'reason','implausible_frozen_seconds');
      END IF;
      INSERT INTO ${schema}.engine_maintenance_thaws(
        freeze_started_at,frozen_seconds,shifted,thawed_by
      ) VALUES(p_freeze_started,p_frozen_seconds,'{}'::jsonb,p_thawed_by)
      ON CONFLICT(freeze_started_at) DO NOTHING;
      PERFORM set_config('app.freeze_bypass','on',true);
      SELECT shifted,frozen_seconds INTO v_shifted,v_effective_seconds
        FROM ${schema}.engine_maintenance_thaws
       WHERE freeze_started_at=p_freeze_started FOR UPDATE;
      IF NOT (v_shifted ? 'sit_out_at') THEN
        UPDATE ${schema}.table_seats
           SET sit_out_at=sit_out_at+make_interval(secs=>v_effective_seconds)
         WHERE left_at IS NULL AND sit_out_at IS NOT NULL;
        v_shifted := v_shifted || jsonb_build_object('sit_out_at',1);
      END IF;
      IF NOT (v_shifted ? '_probe_partial') THEN
        v_shifted := v_shifted || jsonb_build_object('_probe_partial',true);
        UPDATE ${schema}.engine_maintenance_thaws
           SET shifted=v_shifted, thawed_at=clock_timestamp()
         WHERE freeze_started_at=p_freeze_started;
        RETURN jsonb_build_object(
          'ok',true,'complete',false,'steps_this_call',jsonb_build_array('sit_out_at'),
          'shifted',v_shifted);
      END IF;
      v_shifted := v_shifted || jsonb_build_object(
        'sit_out_at',0,'hold_expires_at',0,'addon_period_ends_at',0,
        'reversible_until',0,'reveal_deadline_at',0,'rebuy_prompt_until',0,
        'bomb_pot_next_due_at',0,'cash_stay_last_tick_at',0,
        'cash_rejoin_expires_at',0,'level_started_at',0,
        'cluster_break_eligible_since',0,'cluster_move_expires_at',0,
        'reconnect_presence',0,'reconnect_snapshots',0,'complete',true
      );
      UPDATE ${schema}.engine_maintenance_thaws
         SET shifted=v_shifted, thawed_at=clock_timestamp()
       WHERE freeze_started_at=p_freeze_started;
      RETURN jsonb_build_object('ok', true, 'complete', true, 'shifted', v_shifted);
    END $$;
    REVOKE ALL ON FUNCTION ${schema}.fn_thaw_platform(timestamptz,numeric,text)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION ${schema}.fn_thaw_platform(timestamptz,numeric,text)
      TO service_role;`);
  await control.query(definition('fn_save_engine_maintenance_break'));
  await control.query(definition('fn_claim_engine_maintenance_break'));
  await control.query(definition('fn_clear_engine_maintenance_break'));

  // Reproduce the production orphan against the previously deployed function.
  await seed();
  await rejectUnchanged(fresh(), 'baseline orphan blocks the next hour');
  await control.query(remap(migration));
  await control.query(remap(lifetimeMigration));

  // A bridge engine that is still serving when the v3 migration lands keeps
  // its historical three-argument thaw contract. The wrapper must bind that
  // call to the active break identity and must never fabricate v3 per-target
  // receipts from a caller that does not possess the owner token.
  const bridgeBreak = await seed({
    phase: 'counting_down',
    announced: stamp(-7 * 60000),
    started: stamp(-5 * 60000),
    ends: stamp(-1000),
  });
  await writer.query('SET ROLE service_role');
  const wrongLegacyIdentity = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3) AS result', [
      stamp(-4 * 60000),
      300,
      'bridge-wrong-identity',
    ])
  ).rows[0].result;
  check(
    wrongLegacyIdentity.reason,
    'maintenance_identity_mismatch',
    'legacy bridge refuses a different freeze identity'
  );
  let legacyResult = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3) AS result', [
      bridgeBreak.started,
      300,
      'bridge-engine',
    ])
  ).rows[0].result;
  check(legacyResult.complete, false, 'legacy bridge preserves checkpoint installments');
  legacyResult = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3) AS result', [
      bridgeBreak.started,
      300,
      'bridge-engine',
    ])
  ).rows[0].result;
  await writer.query('RESET ROLE');
  check(legacyResult.complete, true, 'legacy bridge can finish the running engine thaw');
  check(
    Number(
      (
        await control.query(
          `SELECT count(*) AS n FROM ${schema}.engine_maintenance_thaw_targets`
        )
      ).rows[0].n
    ),
    0,
    'legacy bridge cannot mint v3 target receipts'
  );
  check(
    Number(
      (await control.query(`SELECT count(*) AS n FROM ${schema}.engine_maintenance_thaws`)).rows[0]
        .n
    ),
    1,
    'legacy bridge keeps its historical aggregate checkpoint'
  );
  await control.query(`DELETE FROM ${schema}.engine_maintenance_break`);
  await control.query(`DELETE FROM ${schema}.engine_maintenance_thaws`);

  const reconnectOne = (
    await control.query(
      `SELECT ${schema}.fn_thaw_reconnect_states(
         $1::jsonb,100000,400000
       ) AS state`,
      [
        JSON.stringify({
          player: {
            state: 'DISCONNECTED',
            reconnectDeadlineMs: 101000,
            graceDeadlineMs: 101000,
            reconnectGrantedAtMs: 71000,
          },
        }),
      ]
    )
  ).rows[0].state;
  const reconnectTwo = (
    await control.query(
      `SELECT ${schema}.fn_thaw_reconnect_states($1::jsonb,100000,410500) AS state`,
      [JSON.stringify(reconnectOne)]
    )
  ).rows[0].state;
  check(reconnectOne.player.reconnectDeadlineMs, 401000, 'first reconnect interval credited');
  check(reconnectTwo.player.reconnectDeadlineMs, 411500, 'only reconnect suffix credited');
  check(reconnectTwo.player.graceDeadlineMs, 411500, 'grace suffix uses its own deadline');
  check(
    (
      await control.query(
        `SELECT ${schema}.fn_thaw_reconnect_states($1::jsonb,100000,410500) AS state`,
        [JSON.stringify(reconnectTwo)]
      )
    ).rows[0].state,
    reconnectTwo,
    'reconnect suffix replay is idempotent'
  );
  const reconnectLong = (
    await control.query(
      `SELECT ${schema}.fn_thaw_reconnect_states($1::jsonb,100000,1360000) AS state`,
      [
        JSON.stringify({
          player: {
            state: 'DISCONNECTED',
            reconnectDeadlineMs: 101000,
            graceDeadlineMs: 101000,
            reconnectGrantedAtMs: 100000,
          },
        }),
      ]
    )
  ).rows[0].state;
  check(
    reconnectLong.player.reconnectDeadlineMs,
    1361000,
    'reconnect interval longer than fifteen minutes is credited in full'
  );

  const expired = await seed();
  const request = fresh();
  await rejectUnchanged(request, 'a new declaration cannot overwrite an uncredited break');
  const adopted = (await claim(oldOwner, newOwner)).rows[0].result;
  check(adopted.ok, true, 'replacement explicitly adopts the persisted break');
  check((await read()).ownership_token, newOwner, 'replacement owns adopted orphan');
  check((await read()).phase, expired.phase, 'adoption preserves the original phase');
  check((await read()).enforce_freeze, true, 'new announcement still freezes admission');
  await rejectUnchanged(expired, 'retired delayed announcement cannot reclaim', '57014');
  await rejectUnchanged(fresh(oldOwner), 'retired fresh attempt cannot replace active owner');
  const cleared = (
    await control.query(
      'SELECT ' + schema + '.fn_clear_engine_maintenance_break($1,$2,$3,$4,$5,$6) AS cleared',
      [
        expired.phase,
        expired.announced,
        expired.started,
        expired.ends,
        expired.reason,
        expired.token,
      ]
    )
  ).rows[0].cleared;
  check(cleared, false, 'old exact cleanup cannot delete renewed row');
  check((await read()).ownership_token, newOwner, 'renewed owner survives old cleanup');

  await save({ ...request, phase: 'counting_down', started: stamp(0), ends: stamp(5 * 60000) });
  check((await read()).phase, 'counting_down', 'same owner can advance normally');
  await rejectUnchanged(fresh(otherOwner), 'active countdown cannot be shortened');

  await seed({ announced: stamp(-7.5 * 60000) });
  await rejectUnchanged(fresh(), 'eight-minute adoption grace remains protected');

  const oldCountdown = await seed({
    phase: 'counting_down',
    announced: stamp(-12 * 60000),
    started: stamp(-10 * 60000),
    ends: stamp(-5 * 60000),
  });
  await rejectUnchanged(fresh(), 'expired countdown cannot be erased by a later declaration');
  check(
    (await claim(oldCountdown.token, newOwner)).rows[0].result.ok,
    true,
    'expired countdown is adopted for its mandatory thaw'
  );
  check((await read()).ownership_token, newOwner, 'adopter owns expired countdown');

  await seed({ phase: 'counting_down', ends: stamp(60000) });
  await rejectUnchanged(fresh(), 'recorded future end remains protected');

  for (const [patch, reason, code] of [
    [{ announced: stamp(30000) }, 'future-dated announcement', '57014'],
    [{ announced: stamp(-3 * 60000) }, 'stale new announcement', '57014'],
    [
      { phase: 'counting_down', started: stamp(0), ends: stamp(5 * 60000) },
      'countdown takeover',
      '40001',
    ],
    [{ started: stamp(0) }, 'announcement carrying a countdown start', '57014'],
    [{ ends: stamp(5 * 60000) }, 'announcement carrying an end', '57014'],
  ]) {
    await seed();
    await rejectUnchanged(fresh(newOwner, patch), reason, code);
  }
  await seed();
  await assert.rejects(save(fresh(null)), { code: '22004' });
  checks++;

  // Actual service-only execution, not only a text pin.
  for (const role of ['anon', 'authenticated']) {
    await writer.query('SET ROLE ' + role);
    await assert.rejects(save(fresh(), writer), { code: '42501' });
    checks++;
    await writer.query('RESET ROLE');
  }
  await writer.query('SET ROLE service_role');
  const serviceSeed = await seed();
  check(
    (await claim(serviceSeed.token, newOwner, writer)).rows[0].result.ok,
    true,
    'service can adopt through definer and RLS'
  );
  check((await read()).ownership_token, newOwner, 'service adoption is durable');
  await writer.query('RESET ROLE');
  const metadata = (
    await control.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [
      signature,
    ])
  ).rows[0];
  check(metadata.prosecdef, true, 'definer preserved');
  check(metadata.proconfig.includes('statement_timeout=6s'), true, 'statement ceiling bounded');
  check(metadata.proconfig.includes('lock_timeout=5s'), true, 'lock ceiling bounded');

  // Admission holding the shared boundary completes before a competing save,
  // which still cannot steal the persisted generation afterward.
  await seed();
  const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock_shared(530090,1)');
  const pending = save(fresh(), writer).then(
    () => ({ accepted: true }),
    (error) => ({ accepted: false, code: error.code })
  );
  await waitForAdvisoryWait(pid);
  check((await read()).ownership_token, oldOwner, 'blocked announcement has not renewed');
  await holder.query('COMMIT');
  check(
    await pending,
    { accepted: false, code: '40001' },
    'competing save is refused after the prior entry transaction'
  );
  check((await read()).ownership_token, oldOwner, 'blocked save did not steal ownership');

  // A call can reach PostgREST before :55 but wait behind an entry transaction
  // until after :55. The database samples time after the shared/exclusive
  // serialization point and must reject the late row rather than surfacing a
  // maintenance promise the engine has already stopped waiting for.
  await seed();
  const lateRequest = fresh(newOwner, { announced: stamp(-119_800) });
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock_shared(530090,1)');
  const late = save(lateRequest, writer).then(
    () => ({ accepted: true }),
    (error) => ({ accepted: false, code: error.code })
  );
  await waitForAdvisoryWait(pid);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await holder.query('COMMIT');
  check(await late, { accepted: false, code: '57014' }, 'queued declaration expires at :55');
  check((await read()).ownership_token, oldOwner, 'late declaration leaves prior row unchanged');

  // A writer that renews the old token while holding the boundary is re-read by
  // the contender after the lock. Expiry is not decided from an earlier snapshot.
  await seed();
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock(530090,1)');
  await save(fresh(oldOwner), holder);
  const loser = save(fresh(newOwner), writer).then(
    () => ({ accepted: true }),
    (error) => ({ accepted: false, code: error.code })
  );
  await waitForAdvisoryWait(pid);
  await holder.query('COMMIT');
  check(await loser, { accepted: false, code: '40001' }, 'active renewal wins the race');
  check((await read()).ownership_token, oldOwner, 'racing contender cannot steal owner');

  // A harmless early call is a prepared wait, not a terminal refusal and not
  // a 250ms polling loop.  The database owns the exact due instant.
  const prepared = await seed({
    phase: 'counting_down',
    announced: stamp(-2 * 60000),
    started: stamp(0),
    ends: stamp(5000),
  });
  await writer.query('SET ROLE service_role');
  const notDue = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3,$4,$5) AS result', [
      prepared.announced,
      prepared.started,
      1,
      prepared.token,
      'probe-early',
    ])
  ).rows[0].result;
  await writer.query('RESET ROLE');
  check(notDue.reason, 'maintenance_break_not_due', 'early thaw remains prepared');
  check(notDue.retryable, true, 'early thaw is safe to continue at its boundary');
  check(Number(notDue.retry_after_ms) > 4000, true, 'early thaw returns a real backoff');
  check(
    Number(
      (await control.query(`SELECT count(*) AS n FROM ${schema}.engine_maintenance_thaws`)).rows[0]
        .n
    ),
    0,
    'prepared wait does not create a thaw checkpoint'
  );

  // The visible countdown is over, but the row is still the thaw identity.
  // Both predicates must stay closed between installments, and each thaw call
  // must serialize on the exclusive half of the admission boundary.  The
  // deadline below also proves that a processing/retry tail is credited once.
  const seatId = '44444444-4444-4444-8444-444444444444';
  await control.query(
    `INSERT INTO ${schema}.table_seats(id,left_at,sit_out_at)
     VALUES($1,NULL,clock_timestamp()+interval '10 minutes')`,
    [seatId]
  );
  const seatBefore = Number(
    (
      await control.query(
        `SELECT extract(epoch FROM sit_out_at) AS seconds
           FROM ${schema}.table_seats WHERE id=$1`,
        [seatId]
      )
    ).rows[0].seconds
  );
  const thawable = await seed({
    phase: 'counting_down',
    announced: stamp(-23 * 60000),
    started: stamp(-21 * 60000),
    ends: stamp(-16 * 60000),
  });
  check(
    (await control.query('SELECT ' + schema + '.fn_platform_frozen() AS frozen')).rows[0].frozen,
    true,
    'platform stays frozen while an expired recoverable row awaits thaw completion'
  );
  check(
    (await control.query('SELECT ' + schema + '.fn_entry_purchases_frozen() AS frozen')).rows[0]
      .frozen,
    true,
    'entry stays frozen between thaw installments'
  );
  await writer.query('SET ROLE service_role');
  const wrongOwner = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3,$4,$5) AS result', [
      thawable.announced,
      thawable.started,
      300,
      otherOwner,
      'wrong-owner',
    ])
  ).rows[0].result;
  await writer.query('RESET ROLE');
  check(wrongOwner.reason, 'maintenance_ownership_changed', 'wrong owner cannot thaw');
  check(
    Number(
      (await control.query(`SELECT count(*) AS n FROM ${schema}.engine_maintenance_thaws`)).rows[0]
        .n
    ),
    0,
    'wrong owner creates no checkpoint'
  );
  await writer.query('SET ROLE service_role');
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock_shared(530090,1)');
  const thawing = writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3,$4,$5) AS result', [
    thawable.announced,
    thawable.started,
    300,
    thawable.token,
    'probe',
  ]);
  await waitForAdvisoryWait(pid);
  await holder.query('COMMIT');
  let result = (await thawing).rows[0].result;
  check(result.complete, false, 'first installment commits a partial checkpoint');
  const midThawAdoption = (await claim(thawable.token, newOwner)).rows[0].result;
  check(midThawAdoption.ok, true, 'replacement adopts a partially checkpointed thaw');
  const retiredThaw = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3,$4,$5) AS result', [
      thawable.announced,
      thawable.started,
      300,
      thawable.token,
      'retired-probe',
    ])
  ).rows[0].result;
  check(retiredThaw.reason, 'maintenance_ownership_changed', 'retired thaw owner is fenced');
  const thawOwner = newOwner;
  let calls = 1;
  while (result.complete !== true && calls < 20) {
    const delay = Math.max(0, Number(result.retry_after_ms ?? 0));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    result = (
      await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3,$4,$5) AS result', [
        thawable.announced,
        thawable.started,
        300,
        thawOwner,
        'probe',
      ])
    ).rows[0].result;
    calls++;
  }
  if (result.complete !== true) {
    console.error(JSON.stringify({ calls, finalThawResult: result }));
  }
  check(result.complete, true, 'checkpointed thaw reaches its certified boundary');
  check(result.released, true, 'certified thaw releases the exact generation');
  check(
    (await read()) ?? null,
    null,
    'final thaw installment exact-clears the durable break in the same transaction'
  );
  await writer.query('RESET ROLE');
  const seatAfter = Number(
    (
      await control.query(
        `SELECT extract(epoch FROM sit_out_at) AS seconds
           FROM ${schema}.table_seats WHERE id=$1`,
        [seatId]
      )
    ).rows[0].seconds
  );
  const credited = Number(result.effective_frozen_seconds);
  check(credited > 900, true, 'a persisted owner older than fifteen minutes is fully recovered');
  check(
    Math.abs(seatAfter - seatBefore - credited) < 0.01,
    true,
    'processing and retry tail is credited exactly once on the deadline'
  );
  const targetCredits = (
    await control.query(
      `SELECT min(credited_seconds)::float8 AS low,max(credited_seconds)::float8 AS high
         FROM ${schema}.engine_maintenance_thaw_targets
        WHERE freeze_started_at=$1`,
      [thawable.started]
    )
  ).rows[0];
  check(targetCredits.low, credited, 'every target receipt reaches the release duration');
  check(targetCredits.high, credited, 'no target receipt exceeds the release duration');

  // A response lost after commit is recovered from the exact identity receipt
  // and cannot shift the deadline a second time.
  await writer.query('SET ROLE service_role');
  const replay = (
    await writer.query('SELECT ' + schema + '.fn_thaw_platform($1,$2,$3,$4,$5) AS result', [
      thawable.announced,
      thawable.started,
      300,
      thawOwner,
      'probe-replay',
    ])
  ).rows[0].result;
  await writer.query('RESET ROLE');
  check(replay.reason, 'release_receipt_recovered', 'lost release response is recovered');
  const seatReplay = Number(
    (
      await control.query(
        `SELECT extract(epoch FROM sit_out_at) AS seconds
           FROM ${schema}.table_seats WHERE id=$1`,
        [seatId]
      )
    ).rows[0].seconds
  );
  check(seatReplay, seatAfter, 'release receipt replay does not double-shift a target');
  const creditedThroughMs = new Date(result.credited_through_at).getTime();
  for (const role of ['anon', 'authenticated']) {
    await asBrowserRole(role, async (browser) => {
      await assert.rejects(
        browser.query(`SELECT * FROM ${schema}.engine_maintenance_thaws`),
        { code: '42501' },
        role + ' cannot read the private thaw ledger'
      );
      checks++;
      await assert.rejects(
        browser.query(`SELECT * FROM ${schema}.engine_maintenance_thaw_targets`),
        { code: '42501' },
        role + ' cannot read private per-target receipts'
      );
      checks++;
      const boundary = (
        await browser.query(
          `SELECT ${schema}.fn_active_maintenance_release_boundary() AS release_target`
        )
      ).rows[0].release_target;
      check(
        new Date(boundary).getTime(),
        creditedThroughMs,
        role + ' sees only the exact public release boundary'
      );
      check(
        (await browser.query(`SELECT ${schema}.fn_platform_frozen() AS frozen`)).rows[0].frozen,
        true,
        role + ' sees the active certificate hold platform admission'
      );
      check(
        (await browser.query(`SELECT ${schema}.fn_entry_purchases_frozen() AS frozen`)).rows[0]
          .frozen,
        true,
        role + ' sees the active certificate hold entry admission'
      );
      const state = (await browser.query(`SELECT * FROM ${schema}.fn_maintenance_break_state()`))
        .rows[0];
      check(state.phase, 'recovering', role + ' sees the certificate recovery state');
      check(
        new Date(state.break_ends_at).getTime(),
        creditedThroughMs,
        role + ' sees the exact public recovery endpoint'
      );
    });
  }
  check(
    (await control.query('SELECT ' + schema + '.fn_platform_frozen() AS frozen')).rows[0].frozen,
    true,
    'complete ledger holds admission through the certified future endpoint'
  );
  const recovering = (
    await control.query('SELECT * FROM ' + schema + '.fn_maintenance_break_state()')
  ).rows[0];
  check(recovering.phase, 'recovering', 'public state exposes the certified release wait');
  const releaseDelayMs = Math.max(0, creditedThroughMs - Date.now()) + 100;
  await new Promise((resolve) => setTimeout(resolve, releaseDelayMs));
  for (const role of ['anon', 'authenticated']) {
    await asBrowserRole(role, async (browser) => {
      await assert.rejects(
        browser.query(`SELECT * FROM ${schema}.engine_maintenance_thaws`),
        { code: '42501' },
        role + ' still cannot read the expired private thaw ledger'
      );
      checks++;
      await assert.rejects(
        browser.query(`SELECT * FROM ${schema}.engine_maintenance_thaw_targets`),
        { code: '42501' },
        role + ' still cannot read expired per-target receipts'
      );
      checks++;
      check(
        (
          await browser.query(
            `SELECT ${schema}.fn_active_maintenance_release_boundary() AS release_target`
          )
        ).rows[0].release_target,
        null,
        role + ' receives no private history after certificate expiry'
      );
      check(
        (await browser.query(`SELECT ${schema}.fn_platform_frozen() AS frozen`)).rows[0].frozen,
        false,
        role + ' sees platform admission open after certificate expiry'
      );
      check(
        (await browser.query(`SELECT ${schema}.fn_entry_purchases_frozen() AS frozen`)).rows[0]
          .frozen,
        false,
        role + ' sees entry admission open after certificate expiry'
      );
      check(
        (await browser.query(`SELECT * FROM ${schema}.fn_maintenance_break_state()`)).rows.length,
        0,
        role + ' sees no maintenance state after certificate expiry'
      );
    });
  }
  check(
    (await control.query('SELECT ' + schema + '.fn_platform_frozen() AS frozen')).rows[0].frozen,
    false,
    'platform unfreezes only after the certified credited endpoint'
  );
  check(
    (await control.query('SELECT * FROM ' + schema + '.fn_maintenance_break_state()')).rows.length,
    0,
    'public maintenance state clears after the credited endpoint'
  );
  console.log(JSON.stringify({ probe: 'expired-maintenance-owner', checks, result: 'passed' }));
} finally {
  await holder.query('ROLLBACK').catch(() => {});
  await control.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {});
  await Promise.all(clients.map((client) => client.end().catch(() => {})));
}
