import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export async function exerciseObservationalTuner({
  root,
  c,
  actor,
  day,
  initial,
  request,
  record,
  reset,
  state,
  loseReply,
  prepare,
  complete,
  progress,
}) {
  const results = [];
  await reset();
  const attempted = { ...request(), intent: 'observational_only' };
  assert.equal((await record(attempted)).changed, true);
  const authored = { ...structuredClone(initial), tightness: 1.5, aggression: 0.75 };
  const unchanged = request();
  unchanged.expectedProfile = authored;
  unchanged.nextProfile = structuredClone(authored);
  unchanged.audit.modsBefore = { tightness: 1.5, aggression: 0.75, bluffFreq: 1 };
  unchanged.audit.modsAfter = { ...unchanged.audit.modsBefore };
  await reset();
  await c.query('UPDATE profiles SET horse_profile=$2 WHERE id=$1', [actor, authored]);
  assert.equal((await record(unchanged)).reason, 'invalid_modifiers');
  results.push({
    case: 'prior writer accepted a mutation labeled observational and refused an exact no-op audit for authored modifiers outside its mutation range',
    passed: true,
  });
  await reset();
  assert.deepEqual(await record(request()), { status: 'recorded', changed: true, replayed: false });

  await c.query(
    readFileSync(
      root + '/supabase/migrations/20260914020727_enforce_observational_horse_tuner_audits.sql',
      'utf8'
    )
  );
  await c.query(
    "UPDATE profiles SET horse_profile=jsonb_set(horse_profile,'{persona,gtoAdherence}','0.7') WHERE id=$1",
    [actor]
  );
  assert.deepEqual(await record(request()), { status: 'recorded', changed: true, replayed: true });
  assert.equal((await state()).profile.persona.gtoAdherence, 0.7);
  results.push({
    case: 'forward refusal preserves exact historical receipt replay without rewriting a subsequently edited profile',
    passed: true,
  });
  globalThis.horseTunerObservationNative = { recordHorseTunerUpdate: record };
  const source = readFileSync(
    root + '/server/dist/services/HorseTunerObservationalAudit.js',
    'utf8'
  ).replace(
    /import \{\s*recordHorseTunerUpdate\s*,?\s*\} from '\.\/HorseTunerAtomicWrite\.js';/,
    'const {recordHorseTunerUpdate}=globalThis.horseTunerObservationNative;'
  );
  const { recordObservationalHorseStudy: observe } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  await reset();
  const observation = request();
  observation.audit.stats.review_all_big_loss = 7;
  await c.query('SET ROLE service_role');
  loseReply();
  assert.deepEqual(await observe(observation), { status: 'unknown' });
  assert.deepEqual(await observe(observation), {
    status: 'recorded',
    changed: false,
    replayed: true,
  });
  await c.query('RESET ROLE');
  assert.deepEqual(await state(), { profile: initial, audits: 1, receipts: 1 });
  const audit = (
    await c.query('SELECT stats,mods_before,mods_after,reasons FROM horse_self_tune_log')
  ).rows[0];
  assert.equal(audit.stats.proposed_tightness, 1.02);
  assert.equal(audit.stats.review_all_big_loss, 7);
  assert.equal(audit.stats.causal_permission, 0);
  assert.deepEqual(audit.mods_after, audit.mods_before);
  assert.ok(audit.reasons.some((r) => r.includes('not applied')));
  results.push({
    case: 'real compiled observational adapter records diagnostics once after a lost committed reply, preserving profile and applied modifiers',
    passed: true,
  });

  await reset();
  assert.deepEqual(await record(attempted), {
    status: 'unavailable',
    reason: 'causal_permission_missing',
  });
  assert.deepEqual(await record({ ...request(), intent: 'causal' }), {
    status: 'unavailable',
    reason: 'invalid_request',
  });
  assert.deepEqual(await state(), { profile: initial, audits: 0, receipts: 0 });
  assert.deepEqual(await record(request()), {
    status: 'unavailable',
    reason: 'causal_permission_missing',
  });
  for (const value of [0.84, 0.85, 1.18, 1.19]) {
    await reset();
    const bounded = request();
    bounded.nextProfile.tightness = value;
    bounded.audit.modsAfter.tightness = value;
    const result = await record(bounded);
    assert.equal(result.status, 'unavailable');
    assert.equal(
      result.reason,
      value >= 0.85 && value <= 1.18 ? 'causal_permission_missing' : 'invalid_modifiers'
    );
  }
  await reset();
  const leakOnly = request();
  leakOnly.intent = 'observational_only';
  leakOnly.nextProfile = { ...structuredClone(initial), leaks: { new_detector: 7 } };
  leakOnly.audit.modsAfter = { ...leakOnly.audit.modsBefore };
  assert.equal((await record(leakOnly)).reason, 'causal_permission_missing');
  assert.deepEqual(await state(), { profile: initial, audits: 0, receipts: 0 });
  results.push({
    case: 'new diagnostic mutations refuse with explicit or omitted intent; bounds, forged intent and leak-only changes cannot bypass the gate',
    passed: true,
  });

  for (const profile of ['lag', null, { bluff_freq: 0.9 }, authored]) {
    await reset();
    await c.query('UPDATE profiles SET horse_profile=$2::jsonb WHERE id=$1', [
      actor,
      JSON.stringify(profile),
    ]);
    const r = request();
    r.expectedProfile = profile;
    const object = profile && typeof profile === 'object' ? profile : {};
    r.audit.modsBefore = {
      tightness: object.tightness ?? 1,
      aggression: object.aggression ?? 1,
      bluffFreq: object.bluffFreq ?? object.bluff_freq ?? 1,
    };
    assert.deepEqual(await observe(r), { status: 'recorded', changed: false, replayed: false });
    assert.deepEqual(await state(), { profile, audits: 1, receipts: 1 });
  }
  results.push({
    case: 'string, null, alias and out-of-tuner-range authored profiles retain their exact JSON types and values in accepted no-change audits',
    passed: true,
  });

  await reset();
  await c.query(
    "UPDATE profiles SET horse_profile=jsonb_set(horse_profile,'{persona,gtoAdherence}','0.5') WHERE id=$1",
    [actor]
  );
  assert.equal((await observe(request())).reason, 'profile_changed');
  assert.equal((await state()).audits, 0);
  assert.equal((await state()).profile.persona.gtoAdherence, 0.5);
  await reset();
  await c.query(
    'CREATE TRIGGER fixture_fail BEFORE INSERT ON horse_self_tune_log FOR EACH ROW EXECUTE FUNCTION fixture_fail_audit()'
  );
  assert.deepEqual(await observe(request()), { status: 'unknown' });
  assert.deepEqual(await state(), { profile: initial, audits: 0, receipts: 0 });
  await c.query('DROP TRIGGER fixture_fail ON horse_self_tune_log');
  results.push({
    case: 'observational audits retain CAS and atomic failure behavior instead of certifying an unrecorded study',
    passed: true,
  });

  await reset();
  await c.query('TRUNCATE horse_tuner_study_completions,horse_tuner_study_rosters');
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await c.query('INSERT INTO profiles VALUES($1,true,$2)', [second, initial]);
  assert.equal((await prepare(day, 2, [actor, second])).status, 'prepared');
  assert.equal((await observe(request())).status, 'recorded');
  assert.equal(await complete(day, 2, [actor, second]), false);
  assert.deepEqual(await progress(day), { status: 'snapshot', horseIds: [actor] });
  assert.equal((await observe({ ...request(), horseId: second })).status, 'recorded');
  assert.equal(await complete(day, 2, [actor, second]), true);
  assert.equal(
    Number(
      (await c.query('SELECT count(*) n FROM horse_tuner_write_receipts WHERE profile_changed'))
        .rows[0].n
    ),
    0
  );
  const profiles = (await c.query('SELECT horse_profile FROM profiles ORDER BY id')).rows;
  assert.deepEqual(
    profiles.map((p) => p.horse_profile),
    [initial, initial]
  );
  results.push({
    case: 'two unchanged observational receipts complete only their original acknowledged study cohort; no profile was tuned',
    passed: true,
  });

  for (const role of ['anon', 'authenticated']) {
    await c.query('SET ROLE ' + role);
    await assert.rejects(
      c.query('SELECT fn_record_horse_tuner_update($1)', [
        JSON.stringify({ version: 1, ...request(), intent: 'observational_only' }),
      ]),
      (e) => e.code === '42501'
    );
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'forward writer preserves application-role denial after the audit-only contract change',
    passed: true,
  });
  return results;
}
