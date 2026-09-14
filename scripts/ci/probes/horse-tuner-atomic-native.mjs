import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const { Client } = createRequire(root + '/server/package.json')('pg');
const pg = process.env.HORSE_PROOF_PG_BIN,
  output = process.argv[2];
if (!pg || !output) throw Error('Existing PG binary and new output required');
const dir = mkdtempSync('/tmp/horse-tuner-native-'),
  data = dir + '/data',
  socket = dir + '/socket';
mkdirSync(socket, { mode: 0o700 });
let running = false,
  c,
  other,
  proof;
const results = [];
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  day = '2026-09-13';
const initial = {
  style: 'lag',
  persona: { gtoAdherence: 0.9 },
  tightness: 1,
  aggression: 1,
  bluffFreq: 1,
};
const request = () => ({
  horseId: actor,
  runDate: day,
  expectedProfile: structuredClone(initial),
  nextProfile: { ...structuredClone(initial), tightness: 1.02 },
  audit: {
    hands: 500,
    stats: { vpip: 0.6 },
    modsBefore: { tightness: 1, aggression: 1, bluffFreq: 1 },
    modsAfter: { tightness: 1.02, aggression: 1, bluffFreq: 1 },
    reasons: ['bounded change'],
  },
});
try {
  execFileSync(
    pg + '/initdb',
    ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'],
    { stdio: 'pipe' }
  );
  execFileSync(
    pg + '/pg_ctl',
    [
      '-D',
      data,
      '-l',
      dir + '/postgres.log',
      '-o',
      '-k ' +
        socket +
        " -p 55439 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
      '-w',
      'start',
    ],
    { stdio: 'pipe' }
  );
  running = true;
  const options = {
    host: socket,
    port: 55439,
    user: 'postgres',
    database: 'postgres',
    statement_timeout: 7000,
  };
  c = new Client(options);
  other = new Client(options);
  await c.connect();
  await other.connect();
  await c.query(
    'CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean,horse_profile jsonb)'
  );
  await c.query(
    readFileSync(root + '/supabase/migrations/20260822220000_horse_self_tune_log.sql', 'utf8')
  );
  await c.query(
    readFileSync(
      root + '/supabase/migrations/20260913203740_atomically_record_horse_tuner_updates.sql',
      'utf8'
    )
  );
  const reset = async () => {
    await c.query('TRUNCATE profiles,horse_self_tune_log,horse_tuner_write_receipts');
    await c.query('INSERT INTO profiles VALUES($1,true,$2)', [actor, initial]);
  };
  const state = async () =>
    (
      await c.query(
        "SELECT jsonb_build_object('profile',(SELECT horse_profile FROM profiles WHERE id=$1),'audits',(SELECT count(*) FROM horse_self_tune_log),'receipts',(SELECT count(*) FROM horse_tuner_write_receipts)) value",
        [actor]
      )
    ).rows[0].value;
  let loseReply = false;
  const calls = [];
  globalThis.horseTunerNative = {
    supabase: {
      rpc(name, p) {
        calls.push(name);
        assert.equal(name, 'fn_record_horse_tuner_update');
        return {
          async abortSignal(signal) {
            assert.ok(signal instanceof AbortSignal);
            try {
              const r = await c.query('SELECT fn_record_horse_tuner_update($1) value', [
                p.p_payload,
              ]);
              if (loseReply) {
                loseReply = false;
                throw Error('lost committed reply');
              }
              return { data: r.rows[0].value, error: null };
            } catch (error) {
              return { data: null, error };
            }
          },
        };
      },
    },
  };
  const source = readFileSync(
    root + '/server/dist/services/HorseTunerAtomicWrite.js',
    'utf8'
  ).replace(
    /import \{ supabase \} from '\.\/supabase\.js';/,
    'const {supabase}=globalThis.horseTunerNative;'
  );
  const { recordHorseTunerUpdate: record } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  await reset();
  // Reproduce the two old writes: a newer authored edit is overwritten and
  // an independent audit failure cannot roll the accepted profile back.
  await c.query(
    "UPDATE profiles SET horse_profile=jsonb_set(horse_profile,'{persona,gtoAdherence}','0.5') WHERE id=$1",
    [actor]
  );
  await c.query('UPDATE profiles SET horse_profile=$2 WHERE id=$1', [actor, request().nextProfile]);
  await assert.rejects(
    c.query('INSERT INTO horse_self_tune_log(horse_id,run_date,hands) VALUES($1,NULL,500)', [actor])
  );
  assert.deepEqual(await state(), { profile: request().nextProfile, audits: 0, receipts: 0 });
  results.push({
    case: 'pre-change stale overwrite and profile change without audit reproduced using separate writes',
    passed: true,
  });
  await reset();
  await c.query(
    "UPDATE profiles SET horse_profile=jsonb_set(horse_profile,'{persona,gtoAdherence}','0.5') WHERE id=$1",
    [actor]
  );
  assert.deepEqual(await record(request()), { status: 'unavailable', reason: 'profile_changed' });
  let s = await state();
  assert.equal(s.profile.persona.gtoAdherence, 0.5);
  assert.equal(s.audits, 0);
  assert.equal(s.receipts, 0);
  results.push({
    case: 'compare-and-set refuses stale study and preserves newer authored profile',
    passed: true,
  });
  await reset();
  await c.query(
    "CREATE FUNCTION fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$;CREATE TRIGGER fixture_fail BEFORE INSERT ON horse_self_tune_log FOR EACH ROW EXECUTE FUNCTION fixture_fail_audit()"
  );
  assert.deepEqual(await record(request()), { status: 'unknown' });
  assert.deepEqual(await state(), { profile: initial, audits: 0, receipts: 0 });
  await c.query('DROP TRIGGER fixture_fail ON horse_self_tune_log');
  results.push({
    case: 'audit insertion failure rolls back profile and receipt in the same transaction',
    passed: true,
  });
  await c.query('SET ROLE service_role');
  loseReply = true;
  assert.deepEqual(await record(request()), { status: 'unknown' });
  assert.deepEqual(await record(request()), { status: 'recorded', changed: true, replayed: true });
  await c.query('RESET ROLE');
  s = await state();
  assert.deepEqual(s, { profile: request().nextProfile, audits: 1, receipts: 1 });
  await c.query(
    "UPDATE profiles SET horse_profile=jsonb_set(horse_profile,'{persona,gtoAdherence}','0.7') WHERE id=$1",
    [actor]
  );
  assert.deepEqual(await record(request()), { status: 'recorded', changed: true, replayed: true });
  assert.equal((await state()).profile.persona.gtoAdherence, 0.7);
  results.push({
    case: 'lost committed reply replays one audit/receipt without retuning or overwriting a later profile edit',
    passed: true,
  });
  const conflict = request();
  conflict.audit.stats.vpip = 0.4;
  assert.deepEqual(await record(conflict), { status: 'unavailable', reason: 'run_conflict' });
  results.push({
    case: 'same horse/day with different study bytes refuses instead of overwriting the audit',
    passed: true,
  });
  await reset();
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('horse-tuner-write:'||$1,0))", [
    actor,
  ]);
  const busy = (
    await other.query('SELECT fn_record_horse_tuner_update($1) value', [
      JSON.stringify({ version: 1, ...request() }),
    ])
  ).rows[0].value;
  assert.equal(busy.reason, 'writer_busy');
  await c.query('ROLLBACK');
  assert.equal((await record(request())).status, 'recorded');
  results.push({
    case: 'concurrent writer receives bounded busy refusal then safely retries',
    passed: true,
  });
  await reset();
  const unchanged = request();
  unchanged.nextProfile = structuredClone(initial);
  unchanged.audit.modsAfter = { ...unchanged.audit.modsBefore };
  assert.deepEqual(await record(unchanged), {
    status: 'recorded',
    changed: false,
    replayed: false,
  });
  assert.deepEqual(await state(), { profile: initial, audits: 1, receipts: 1 });
  results.push({
    case: 'unchanged study records an audit without rewriting the profile',
    passed: true,
  });
  await reset();
  await c.query('UPDATE profiles SET horse_profile=\'"lag"\'::jsonb WHERE id=$1', [actor]);
  const legacy = request();
  legacy.expectedProfile = 'lag';
  legacy.nextProfile = { style: 'lag', tightness: 1.02, aggression: 1, bluffFreq: 1 };
  assert.equal((await record(legacy)).status, 'recorded');
  assert.equal((await state()).profile.style, 'lag');
  results.push({
    case: 'legacy string style is preserved while applying the existing bounded dials',
    passed: true,
  });
  await reset();
  await c.query('INSERT INTO horse_self_tune_log(horse_id,run_date,hands) VALUES($1,$2,500)', [
    actor,
    day,
  ]);
  assert.deepEqual(await record(request()), {
    status: 'unavailable',
    reason: 'legacy_run_unavailable',
  });
  assert.deepEqual(await state(), { profile: initial, audits: 1, receipts: 0 });
  results.push({
    case: 'old unbound audit is not overwritten or misrepresented as this request receipt',
    passed: true,
  });
  await reset();
  const authored = request();
  authored.nextProfile.persona.gtoAdherence = 0.1;
  assert.deepEqual(await record(authored), {
    status: 'unavailable',
    reason: 'authored_profile_change',
  });
  const badMods = request();
  badMods.audit.modsAfter.tightness = 1.18;
  assert.deepEqual(await record(badMods), { status: 'unavailable', reason: 'invalid_modifiers' });
  const badBefore = request();
  badBefore.audit.modsBefore.bluffFreq = 0.5;
  assert.deepEqual(await record(badBefore), { status: 'unavailable', reason: 'invalid_modifiers' });
  const malformed = request();
  malformed.audit.hands = 299;
  assert.deepEqual(await record(malformed), { status: 'unavailable', reason: 'invalid_request' });
  assert.deepEqual(await state(), { profile: initial, audits: 0, receipts: 0 });
  results.push({
    case: 'authored fields, audit modifier mismatches and under-floor studies refuse with no writes',
    passed: true,
  });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    await assert.rejects(
      c.query('DELETE FROM horse_tuner_write_receipts'),
      (e) => e.code === '42501'
    );
    if (role !== 'service_role')
      await assert.rejects(
        c.query('SELECT fn_record_horse_tuner_update($1)', [
          JSON.stringify({ version: 1, ...request() }),
        ]),
        (e) => e.code === '42501'
      );
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'app roles cannot call the writer and no client role can mutate receipts directly',
    passed: true,
  });
  await c.query(
    readFileSync(
      root + '/supabase/migrations/20260914002716_complete_horse_tuner_studies.sql',
      'utf8'
    )
  );
  await reset();
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await c.query('INSERT INTO profiles VALUES($1,true,$2)', [second, initial]);
  let loseCompletion = false;
  let losePreparation = true;
  globalThis.horseTunerCompletionNative = {
    supabase: {
      rpc(name, p) {
        const query =
          name === 'fn_horse_tuner_recorded_horses'
            ? 'SELECT fn_horse_tuner_recorded_horses($1) value'
            : name === 'fn_complete_horse_tuner_study'
              ? 'SELECT fn_complete_horse_tuner_study($1) value'
              : name === 'fn_prepare_horse_tuner_study'
                ? 'SELECT fn_prepare_horse_tuner_study($1) value'
                : null;
        assert.ok(query);
        return {
          async abortSignal(signal) {
            assert.ok(signal instanceof AbortSignal);
            try {
              const r = await c.query(query, [p.p_run_date ?? p.p_payload]);
              if (name === 'fn_prepare_horse_tuner_study' && losePreparation) {
                losePreparation = false;
                throw Error('lost roster reply');
              }
              if (name === 'fn_complete_horse_tuner_study' && loseCompletion) {
                loseCompletion = false;
                throw Error('lost completion reply');
              }
              return { data: r.rows[0].value, error: null };
            } catch (error) {
              return { data: null, error };
            }
          },
        };
      },
    },
  };
  const completionSource = readFileSync(
    root + '/server/dist/services/HorseTunerStudyCompletion.js',
    'utf8'
  ).replace(
    /import \{ supabase \} from '\.\/supabase\.js';/,
    'const {supabase}=globalThis.horseTunerCompletionNative;'
  );
  const {
    readRecordedHorseTunes: progress,
    completeHorseTunerStudy: complete,
    prepareHorseTunerStudy: prepare,
  } = await import(
    'data:text/javascript;base64,' + Buffer.from(completionSource).toString('base64')
  );
  await c.query('SET ROLE service_role');
  assert.deepEqual(await progress(day), { status: 'snapshot', horseIds: [] });
  assert.deepEqual(await prepare(day, 2, [actor, second]), { status: 'unknown' });
  assert.deepEqual(await prepare(day, 2, [actor, second]), {
    status: 'prepared',
    studied: 2,
    horseIds: [actor, second],
  });
  assert.equal((await record(request())).status, 'recorded');
  assert.equal(await complete(day, 2, [actor, second]), false);
  assert.equal(
    (await c.query('SELECT count(*)::int n FROM horse_tuner_study_completions')).rows[0].n,
    0
  );
  assert.deepEqual(await progress(day), { status: 'snapshot', horseIds: [actor] });
  await c.query('RESET ROLE');
  results.push({
    case: 'one accepted horse cannot complete a two-horse study; no marker is written',
    passed: true,
  });

  // A new database connection only reads the durable first horse; the second
  // write resumes independently without rewriting the already accepted profile.
  await c.end();
  c = new Client(options);
  await c.connect();
  await c.query('SET ROLE service_role');
  assert.deepEqual(await progress(day), { status: 'snapshot', horseIds: [actor] });
  const secondRequest = { ...request(), horseId: second };
  assert.deepEqual(await prepare(day, 1, [actor]), {
    status: 'prepared',
    studied: 2,
    horseIds: [actor, second],
  });
  assert.equal(await complete(day, 1, [actor]), false);
  assert.equal((await record(secondRequest)).status, 'recorded');
  loseCompletion = true;
  assert.equal(await complete(day, 2, [actor, second]), false);
  assert.equal(
    (await c.query('SELECT count(*)::int n FROM horse_tuner_study_completions')).rows[0].n,
    1
  );
  assert.equal(await complete(day, 2, [actor, second]), true);
  assert.equal(await complete(day, 1, [actor]), false);
  await c.query('RESET ROLE');
  assert.deepEqual(await state(), { profile: request().nextProfile, audits: 2, receipts: 2 });
  results.push({
    case: 'new connection resumes durable progress; lost completion reply replays one immutable marker',
    passed: true,
  });

  await c.query('TRUNCATE horse_tuner_study_completions');
  await c.query('DELETE FROM horse_self_tune_log WHERE horse_id=$1', [second]);
  assert.equal(await complete(day, 2, [actor, second]), false);
  results.push({
    case: 'a receipt whose matching audit is missing cannot seal the study',
    passed: true,
  });
  await c.query('TRUNCATE horse_tuner_study_completions');
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('horse-tuner-study:'||$1,0))", [
    day,
  ]);
  const busyComplete = (
    await other.query('SELECT fn_complete_horse_tuner_study($1) value', [
      JSON.stringify({ version: 1, runDate: day, studied: 1, horseIds: [actor] }),
    ])
  ).rows[0].value;
  assert.equal(busyComplete.reason, 'study_busy');
  await c.query('ROLLBACK');
  for (const value of [
    null,
    '{',
    'x'.repeat(100001),
    JSON.stringify({ version: 1, runDate: day, studied: 2, horseIds: [actor, actor] }),
    JSON.stringify({ version: 1, runDate: day, studied: 0, horseIds: [actor] }),
    JSON.stringify({ version: 1, runDate: day, studied: 2, horseIds: [second, actor] }),
    JSON.stringify({ version: 1, runDate: day, studied: 1, horseIds: [null] }),
    JSON.stringify({ version: 1, runDate: day, studied: 1, horseIds: ['invalid'] }),
    JSON.stringify({ version: 1, runDate: '2026-02-30', studied: 0, horseIds: [] }),
    JSON.stringify({ version: 1, runDate: day, studied: 2049, horseIds: [] }),
    JSON.stringify({ version: 1, runDate: day, studied: '1', horseIds: [actor] }),
    JSON.stringify({ version: 1, runDate: day, studied: 1, horseIds: [actor], extra: true }),
    JSON.stringify({ runDate: day, version: 1, studied: 1, horseIds: [actor] }),
    JSON.stringify({ version: 1, runDate: day, studied: 1, horseIds: [actor] }, null, 2),
  ]) {
    for (const fn of ['fn_prepare_horse_tuner_study', 'fn_complete_horse_tuner_study']) {
      const r = (await c.query('SELECT ' + fn + '($1) value', [value])).rows[0].value;
      assert.equal(r.reason, 'invalid_request');
    }
  }
  assert.equal(
    (await c.query('SELECT count(*)::int n FROM horse_tuner_study_completions')).rows[0].n,
    0
  );
  results.push({
    case: 'contention and malformed/cohort/byte-budget requests refuse without a completion marker',
    passed: true,
  });
  assert.deepEqual(await prepare('2026-09-15', 1, []), {
    status: 'prepared',
    studied: 1,
    horseIds: [],
  });
  assert.equal(await complete('2026-09-15', 1, []), true);
  results.push({
    case: 'a successfully examined below-floor cohort can record explicit zero eligibility',
    passed: true,
  });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    await assert.rejects(
      c.query('DELETE FROM horse_tuner_study_completions'),
      (e) => e.code === '42501'
    );
    await assert.rejects(
      c.query('DELETE FROM horse_tuner_study_rosters'),
      (e) => e.code === '42501'
    );
    if (role !== 'service_role') {
      await assert.rejects(
        c.query('SELECT fn_prepare_horse_tuner_study($1)', ['{}']),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT * FROM horse_tuner_study_completions'),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT fn_horse_tuner_recorded_horses($1)', [day]),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT fn_complete_horse_tuner_study($1)', ['{}']),
        (e) => e.code === '42501'
      );
    }
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'player roles cannot inspect or forge study proof; service cannot directly mutate completion rows',
    passed: true,
  });
  await reset();
  await c.query(
    'CREATE TABLE horse_job_runs(job text,run_date date,claimed_at timestamptz,claimed_by text); CREATE TABLE horse_league_results(run_date date,matchup text,hands int,bb100 numeric,stderr numeric)'
  );
  const auditDay = '2026-09-14';
  await c.query("INSERT INTO horse_job_runs VALUES('self_tuner',$1,now(),'fixture')", [auditDay]);
  await c.query("INSERT INTO horse_league_results VALUES($1,'fixture',100,1,1)", [auditDay]);
  await c.query('INSERT INTO horse_self_tune_log(horse_id,run_date,hands) VALUES($1,$2,500)', [
    actor,
    auditDay,
  ]);
  const findings = async () =>
    (await c.query('SELECT fn_audit_nightly_job_health($1) value', [auditDay])).rows[0].value;
  assert.ok(
    (await findings()).some(
      (f) => f.code === 'nightly_job_incomplete' && f.evidence.individual_audit_rows === 1
    )
  );
  await c.query('DELETE FROM horse_self_tune_log WHERE run_date=$1', [auditDay]);
  assert.equal((await record({ ...request(), runDate: auditDay })).status, 'recorded');
  assert.ok((await findings()).some((f) => f.code === 'nightly_job_incomplete'));
  assert.equal((await prepare(auditDay, 1, [actor])).status, 'prepared');
  assert.equal(await complete(auditDay, 1, [actor]), true);
  assert.ok(!(await findings()).some((f) => f.code === 'nightly_job_incomplete'));
  results.push({
    case: 'the real nightly SQL audit reports partial output and clears only with the cohort completion receipt',
    passed: true,
  });
  await c.query('TRUNCATE horse_tuner_write_receipts');
  await c.query(
    "INSERT INTO horse_tuner_write_receipts(horse_id,run_date,request_hash,request_payload,profile_changed,audit_id) SELECT md5(i::text)::uuid,$1,repeat('a',64),'{}',false,i FROM generate_series(1,2049) i",
    [day]
  );
  assert.deepEqual(await progress(day), { status: 'unknown' });
  const overflow = (await c.query('SELECT fn_horse_tuner_recorded_horses($1) value', [day])).rows[0]
    .value;
  assert.equal(overflow.reason, 'horse_budget_exceeded');
  await c.query("DELETE FROM horse_tuner_write_receipts WHERE horse_id=md5('2049')::uuid");
  const bounded = await progress(day);
  assert.equal(bounded.status, 'snapshot');
  assert.equal(bounded.horseIds.length, 2048);
  results.push({
    case: 'bounded indexed progress accepts 2048 receipt identities and refuses the 2049th instead of truncating',
    passed: true,
  });
  proof = { results, calls, productionPostgrestVerified: false, productionDataWritten: false };
} finally {
  if (c) await c.end();
  if (other) await other.end();
  if (running) {
    execFileSync(pg + '/pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    running = false;
  }
  rmSync(dir, { recursive: true, force: true });
  if (proof) {
    proof.cleanup = { stopped: !running, removed: true };
    writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  }
}
