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
const remap = (sql) =>
  sql
    .replaceAll('public.', schema + '.')
    .replaceAll('search_path = public, pg_temp', 'search_path = ' + schema + ', pg_temp');
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
async function rejectUnchanged(request, reason) {
  const before = await read();
  await assert.rejects(save(request), { code: '40001' }, reason);
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

try {
  await Promise.all(clients.map((client) => client.connect()));
  await control.query('CREATE SCHEMA ' + schema);
  await control.query(`DO $roles$ BEGIN
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $roles$;`);
  await control.query(`CREATE TABLE ${schema}.engine_maintenance_break (
    id boolean PRIMARY KEY CHECK(id), phase text NOT NULL CHECK(phase IN ('last_hand','counting_down')),
    announced_at timestamptz NOT NULL, break_started_at timestamptz, break_ends_at timestamptz,
    reason text NOT NULL, declared_by text, ownership_token uuid NOT NULL,
    enforce_freeze boolean NOT NULL, updated_at timestamptz NOT NULL);
    ALTER TABLE ${schema}.engine_maintenance_break ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role;`);
  await control.query(definition('fn_save_engine_maintenance_break'));
  await control.query(definition('fn_clear_engine_maintenance_break'));

  // Reproduce the production orphan against the previously deployed function.
  await seed();
  await rejectUnchanged(fresh(), 'baseline orphan blocks the next hour');
  await control.query(remap(migration));

  const expired = await seed();
  const request = fresh();
  await save(request);
  check((await read()).ownership_token, newOwner, 'new hour owns expired orphan');
  check((await read()).phase, 'last_hand', 'renewal begins at announcement');
  check((await read()).enforce_freeze, true, 'new announcement still freezes admission');
  await rejectUnchanged(expired, 'retired delayed announcement cannot reclaim');
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

  await seed({
    phase: 'counting_down',
    announced: stamp(-12 * 60000),
    started: stamp(-10 * 60000),
    ends: stamp(-5 * 60000),
  });
  await save(fresh());
  check((await read()).ownership_token, newOwner, 'expired countdown can start a later hour');

  await seed({ phase: 'counting_down', ends: stamp(60000) });
  await rejectUnchanged(fresh(), 'recorded future end remains protected');

  for (const [patch, reason] of [
    [{ announced: stamp(30000) }, 'future-dated announcement'],
    [{ announced: stamp(-3 * 60000) }, 'stale new announcement'],
    [{ phase: 'counting_down', started: stamp(0), ends: stamp(5 * 60000) }, 'countdown takeover'],
    [{ started: stamp(0) }, 'announcement carrying a countdown start'],
    [{ ends: stamp(5 * 60000) }, 'announcement carrying an end'],
  ]) {
    await seed();
    await rejectUnchanged(fresh(newOwner, patch), reason);
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
  await seed();
  await save(fresh(), writer);
  check((await read()).ownership_token, newOwner, 'service can renew through definer and RLS');
  await writer.query('RESET ROLE');
  const metadata = (
    await control.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [
      signature,
    ])
  ).rows[0];
  check(metadata.prosecdef, true, 'definer preserved');
  check(metadata.proconfig.includes('statement_timeout=45s'), true, 'statement ceiling preserved');
  check(metadata.proconfig.includes('lock_timeout=40s'), true, 'lock ceiling preserved');

  // Admission holding the shared boundary still wins before the new announcement.
  await seed();
  const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock_shared(530090,1)');
  const pending = save(fresh(), writer);
  await waitForAdvisoryWait(pid);
  check((await read()).ownership_token, oldOwner, 'blocked announcement has not renewed');
  await holder.query('COMMIT');
  await pending;
  check((await read()).ownership_token, newOwner, 'renewal follows prior entry transaction');

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
  console.log(JSON.stringify({ probe: 'expired-maintenance-owner', checks, result: 'passed' }));
} finally {
  await holder.query('ROLLBACK').catch(() => {});
  await control.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {});
  await Promise.all(clients.map((client) => client.end().catch(() => {})));
}
