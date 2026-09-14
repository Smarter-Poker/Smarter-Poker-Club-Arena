import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export async function exerciseObservationDiscovery({
  root,
  c,
  otherConnection,
  discovery,
  capture,
  work,
}) {
  const results = [],
    hash = (v) => createHash('sha256').update(v).digest('hex');
  const sql = async (q, p = []) => (await c.query(q, p)).rows[0]?.value;
  await c.query(
    readFileSync(
      root + '/supabase/migrations/20260914053355_discover_bounded_horse_observation_requests.sql',
      'utf8'
    )
  );
  const step = () => sql('SELECT fn_discover_horse_observation_requests() value');
  const initial = await step();
  assert.equal(initial.status, 'source_recorded');
  assert.equal(initial.throughMs - initial.fromMs, 21600000);
  assert.equal(initial.sourceCoverage, 'not_established');
  const done = await step();
  assert.equal(done.status, 'discovered');
  assert.equal((await step()).status, 'idle');
  results.push({
    case: 'automatic database-clock epoch is durable and an empty retained source never establishes full observation coverage',
    passed: true,
  });

  const clear = () =>
    c.query(
      'TRUNCATE horse_observation_discovery_members,horse_observation_discovery_segments,horse_observation_discovery_epochs,horse_observation_capture_receipts,horse_observation_capture_work,horse_adaptive_journal_work,hand_history,hand_atomic_commits'
    );
  const at = Number(
    (await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint at')).rows[0]
      .at
  );
  const from = at - 120000,
    through = at - 1000,
    key = hash(['horse-discovery-v1', from, through].join('|'));
  const actors = Array.from(
    { length: 127 },
    (_, i) => 'eeeeeeee-eeee-4eee-8eee-' + String(i + 1).padStart(12, '0')
  );
  const seed = async () => {
    await clear();
    await c.query(
      'INSERT INTO horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms) VALUES($1,$2,$3,$2,$3)',
      [key, from, through]
    );
    for (let i = 0; i < actors.length; i += 10) {
      const id = randomUUID();
      await c.query(
        "INSERT INTO hand_history(id,created_at,players,actions) VALUES($1,to_timestamp($2::double precision/1000),$3::jsonb,'[]')",
        [
          id,
          at - 60000,
          JSON.stringify(
            actors
              .slice(i, i + 10)
              .map((userId) => ({ userId, privateCards: ['As', 'Ad'], username: 'never exported' }))
          ),
        ]
      );
    }
    await c.query(
      "INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,repeat('a',64) FROM hand_history"
    );
  };
  await seed();
  const original = await step();
  assert.equal(original.status, 'source_recorded');
  assert.equal(original.actors, 0);
  const segment = (
    await c.query('SELECT * FROM horse_observation_discovery_segments WHERE epoch_key=$1', [key])
  ).rows[0];
  assert.equal(segment.source_actors, 127);
  assert.deepEqual(segment.novel_actors, actors);
  assert.equal(segment.hands, 13);
  assert.ok(!JSON.stringify(original).includes('never exported'));
  assert.ok(!JSON.stringify(original).includes(actors[0]));
  const first = await step();
  assert.equal(first.status, 'admitted');
  assert.equal(first.actors, 32);
  await c.query('TRUNCATE hand_history,hand_atomic_commits');
  for (const count of [64, 96, 127]) {
    const r = await step();
    assert.equal(r.actors, count);
    assert.equal(r.status, count === 127 ? 'discovered' : 'admitted');
  }
  const recovered = (
    await c.query('SELECT * FROM horse_observation_discovery_segments WHERE epoch_key=$1', [key])
  ).rows[0];
  for (const field of [
    'source_digest',
    'snapshot_id',
    'read_at_ms',
    'novel_actors',
    'actor_digest',
  ])
    assert.deepEqual(recovered[field], segment[field]);
  const requests = (
    await c.query(
      'SELECT actor_id,from_ms,through_ms FROM horse_observation_capture_work ORDER BY actor_id'
    )
  ).rows;
  assert.equal(requests.length, 127);
  assert.deepEqual(
    requests.map((x) => x.actor_id),
    actors
  );
  for (const r of requests) {
    assert.equal(Number(r.from_ms), from);
    assert.equal(Number(r.through_ms), through);
  }
  results.push({
    case: '127 frozen source actors survive source removal and admit32/32/32/31 into one original parent window without private roster data',
    requests: 127,
    passed: true,
  });

  await seed();
  await step();
  await c.query(
    "CREATE FUNCTION native_discovery_member_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native_member_failure'; END $$; CREATE TRIGGER native_discovery_member_failure BEFORE INSERT ON horse_observation_discovery_members FOR EACH ROW EXECUTE FUNCTION native_discovery_member_failure()"
  );
  await assert.rejects(step(), /native_member_failure/);
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_work')).rows[0].n,
    '0'
  );
  assert.equal(
    (await c.query('SELECT admitted_actors n FROM horse_observation_discovery_segments')).rows[0].n,
    0
  );
  await c.query(
    'DROP TRIGGER native_discovery_member_failure ON horse_observation_discovery_members; DROP FUNCTION native_discovery_member_failure()'
  );
  assert.equal((await step()).actors, 32);
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('horse-discovery-step-v1',0))"
  );
  assert.equal((await step()).reason, 'discovery_busy');
  await otherConnection.query('ROLLBACK');
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('horse-source-capacity-v1',0))"
  );
  assert.equal((await step()).reason, 'capacity_busy');
  await otherConnection.query('ROLLBACK');
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_work')).rows[0].n,
    '32'
  );
  results.push({
    case: 'member failure rolls back request admissions and cursor; discovery/admission reservations refuse concurrent owners',
    passed: true,
  });

  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    for (const table of [
      'horse_observation_discovery_epochs',
      'horse_observation_discovery_segments',
      'horse_observation_discovery_members',
    ])
      await assert.rejects(c.query('SELECT * FROM ' + table + ' LIMIT 1'), /permission denied/);
    await assert.rejects(
      c.query("SELECT fn_horse_discovery_state($1,'snapshot',NULL)", [key]),
      /permission denied/
    );
    if (role === 'service_role') assert.equal((await step()).status, 'admitted');
    else {
      await assert.rejects(step(), /permission denied/);
      await assert.rejects(
        c.query('SELECT fn_prune_horse_observation_discovery()'),
        /permission denied/
      );
    }
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'only service step/prune entrypoints are callable; direct discovery tables and private receipt formatter are denied',
    passed: true,
  });

  // A thousand actors use the real capture and journal adapters. The saturated
  // queue is drained by canonical service calls, never by changing job states.
  const thousand = Array.from(
    { length: 1000 },
    (_, i) => 'dddddddd-dddd-4ddd-8ddd-' + String(i + 1).padStart(12, '0')
  );
  await clear();
  await c.query(
    'INSERT INTO horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms) VALUES($1,$2,$3,$2,$3)',
    [key, from, through]
  );
  for (let i = 0; i < thousand.length; i += 10) {
    await c.query(
      "INSERT INTO hand_history(id,created_at,players,actions) VALUES($1,to_timestamp($2::double precision/1000),$3::jsonb,'[]')",
      [
        randomUUID(),
        at - 60000,
        JSON.stringify(thousand.slice(i, i + 10).map((userId) => ({ userId }))),
      ]
    );
  }
  await c.query(
    "INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,repeat('a',64) FROM hand_history"
  );
  const started = performance.now();
  let maxStepMs = 0,
    steps = 0,
    drained = 0;
  const measuredStep = async () => {
    const before = performance.now(),
      r = await discovery.discoverObservationRequests();
    maxStepMs = Math.max(maxStepMs, performance.now() - before);
    steps++;
    return r;
  };
  assert.equal((await measuredStep()).status, 'source_recorded');
  for (let i = 1; i <= 8; i++) assert.equal((await measuredStep()).actors, i * 32);
  const saturated = await measuredStep();
  assert.equal(saturated.status, 'deferred');
  assert.equal(saturated.reason, 'capture_queue_full');
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_work')).rows[0].n,
    '256'
  );
  const drain = async (n) => {
    for (let i = 0; i < n; i++) {
      assert.equal((await capture.processObservationCapture()).status, 'admitted');
      assert.equal((await work.processAdaptiveJournalWork()).status, 'completed');
      drained++;
    }
  };
  await drain(256);
  // Fixture advances only the retry deadline, leaving source/lease/cursors intact.
  await c.query(
    "UPDATE horse_observation_discovery_epochs SET available_at=clock_timestamp()-interval '1 second'"
  );
  let total = 256;
  while (total < 1000) {
    const r = await measuredStep();
    assert.ok(['admitted', 'discovered'].includes(r.status), JSON.stringify(r));
    const n = r.actors - total;
    assert.ok(n > 0 && n <= 32);
    total = r.actors;
    await drain(n);
  }
  assert.equal(drained, 1000);
  const population = (
    await c.query(
      "SELECT (SELECT count(*) FROM horse_observation_discovery_members) members,(SELECT count(*) FROM horse_observation_capture_work WHERE state='admitted') captures,(SELECT count(*) FROM horse_adaptive_journal_work WHERE state='completed') journal"
    )
  ).rows[0];
  assert.deepEqual(population, { members: '1000', captures: '1000', journal: '1000' });
  await c.query(
    "UPDATE horse_observation_discovery_epochs SET finished_at=clock_timestamp()-interval '33 days'"
  );
  assert.deepEqual(await discovery.pruneObservationDiscovery(), {
    status: 'pruned',
    epochs: 0,
    members: 512,
    segments: 1,
  });
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_discovery_epochs')).rows[0].n,
    '1'
  );
  assert.deepEqual(await discovery.pruneObservationDiscovery(), {
    status: 'pruned',
    epochs: 1,
    members: 488,
    segments: 0,
  });
  results.push({
    case: '1000 distinct fixture actors are discovered once into original windows; canonical acquisition/journal adapters drain saturation without capacity bypass',
    actors: 1000,
    steps,
    maxStepMs,
    elapsedMs: performance.now() - started,
    observations: 0,
    limitation:
      'Isolated database/client throughput with empty public action arrays; not production pacing, source completeness or strategy qualification.',
    passed: true,
  });

  // Source refinement is independent of the admission batch, and repeated
  // actors in later segments never create a second parent-window request.
  await seed();
  await c.query('UPDATE horse_observation_discovery_epochs SET slice_through_ms=$1', [at - 50000]);
  assert.equal((await step()).status, 'source_recorded');
  for (let i = 0; i < 4; i++) await step();
  assert.equal(
    (await c.query('SELECT actors FROM horse_observation_discovery_epochs')).rows[0].actors,
    127
  );
  await c.query('UPDATE hand_history SET created_at=to_timestamp($1::double precision/1000)', [
    at - 30000,
  ]);
  assert.equal((await step()).status, 'source_recorded');
  const last = (
    await c.query(
      'SELECT novel_actors,source_actors FROM horse_observation_discovery_segments ORDER BY from_ms DESC LIMIT 1'
    )
  ).rows[0];
  assert.deepEqual(last.novel_actors, []);
  assert.equal(last.source_actors, 127);
  assert.equal((await step()).status, 'discovered');
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_work')).rows[0].n,
    '127'
  );
  results.push({
    case: 'repeated source actors in a later durable segment retain one request per original parent window',
    passed: true,
  });

  for (const [change, reason] of [
    ['UPDATE horse_observation_discovery_epochs SET segments=2048', 'segment_budget_exceeded'],
    ['UPDATE horse_observation_discovery_epochs SET actors=8192', 'actor_budget_exceeded'],
    [
      'UPDATE horse_observation_discovery_epochs SET evidence_bytes=2097152',
      'evidence_budget_exceeded',
    ],
  ]) {
    await seed();
    await c.query(change);
    const r = await step();
    assert.equal(r.status, 'gap');
    assert.equal(r.reason, reason);
    assert.equal(r.cursorMs, from);
    assert.equal(
      (await c.query('SELECT count(*) n FROM horse_observation_discovery_segments')).rows[0].n,
      '0'
    );
  }
  await seed();
  await step();
  await step();
  await c.query(
    'UPDATE horse_observation_discovery_epochs SET from_ms=from_ms-86400000,through_ms=through_ms-86400000,cursor_ms=cursor_ms-86400000,slice_through_ms=slice_through_ms-86400000'
  );
  assert.equal((await step()).reason, 'source_expired');
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_discovery_members')).rows[0].n,
    '32'
  );
  assert.equal(
    (await c.query('SELECT admitted_actors FROM horse_observation_discovery_segments')).rows[0]
      .admitted_actors,
    32
  );
  results.push({
    case: 'segment, actor, logical evidence and source-age ceilings retain explicit gaps without losing prior accepted membership',
    passed: true,
  });

  for (const change of [
    'DELETE FROM hand_atomic_commits',
    "UPDATE hand_history SET players='{}'::jsonb",
    'UPDATE hand_history SET players=\'[{"userId":"invalid"}]\'::jsonb',
    'UPDATE hand_history SET players=players||players',
  ]) {
    await seed();
    await c.query(change);
    const r = await step();
    assert.equal(r.status, 'deferred');
    assert.equal(r.cursorMs, from);
    assert.equal((await step()).reason, 'backoff');
    assert.equal(
      (await c.query('SELECT count(*) n FROM horse_observation_discovery_segments')).rows[0].n,
      '0'
    );
  }
  await seed();
  await c.query(
    "INSERT INTO hand_history(id,created_at,players,actions) SELECT gen_random_uuid(),to_timestamp($1::double precision/1000),$2::jsonb,'[]'::jsonb FROM generate_series(1,500)",
    [at - 60000, JSON.stringify([{ userId: actors[0] }])]
  );
  await c.query(
    "INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,repeat('a',64) FROM hand_history ON CONFLICT DO NOTHING"
  );
  assert.equal((await step()).status, 'refined');
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_discovery_segments')).rows[0].n,
    '0'
  );
  results.push({
    case: 'missing atomic receipts and malformed rosters defer without accepting membership; the513th source row refines before recording a partial roster',
    passed: true,
  });

  await seed();
  const originalRpc = globalThis.horseJournalNative.supabase.rpc;
  globalThis.horseJournalNative.supabase.rpc = (name, p) => {
    const call = originalRpc(name, p);
    return name === 'fn_discover_horse_observation_requests'
      ? {
          async abortSignal(signal) {
            await call.abortSignal(signal);
            throw Error('lost committed discovery reply');
          },
        }
      : call;
  };
  try {
    assert.equal((await discovery.discoverObservationRequests()).status, 'unknown');
  } finally {
    globalThis.horseJournalNative.supabase.rpc = originalRpc;
  }
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_discovery_segments')).rows[0].n,
    '1'
  );
  const recoveredReply = await discovery.discoverObservationRequests();
  assert.equal(recoveredReply.status, 'admitted');
  assert.equal(recoveredReply.actors, 32);
  results.push({
    case: 'compiled adapter treats a lost committed source-recording reply as unknown and the next call resumes saved membership without rereading source',
    passed: true,
  });

  // Retention uses its own row lock and bounded pages; no cascade or gap loss.
  await seed();
  await step();
  for (let i = 0; i < 4; i++) await step();
  await c.query(
    "UPDATE horse_observation_discovery_epochs SET finished_at=clock_timestamp()-interval '33 days'"
  );
  await otherConnection.query('BEGIN');
  await otherConnection.query('SELECT 1 FROM horse_observation_discovery_epochs FOR UPDATE');
  assert.deepEqual(await discovery.pruneObservationDiscovery(), {
    status: 'pruned',
    epochs: 0,
    members: 0,
    segments: 0,
  });
  await otherConnection.query('ROLLBACK');
  assert.deepEqual(await discovery.pruneObservationDiscovery(), {
    status: 'pruned',
    epochs: 1,
    members: 127,
    segments: 1,
  });
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_work')).rows[0].n,
    '127'
  );
  await seed();
  await c.query(
    "UPDATE horse_observation_discovery_epochs SET state='gap',reason='source_expired',finished_at=clock_timestamp()-interval '33 days'"
  );
  assert.deepEqual(await discovery.pruneObservationDiscovery(), {
    status: 'pruned',
    epochs: 0,
    members: 0,
    segments: 0,
  });
  results.push({
    case: 'retention skips a concurrently locked epoch, removes only old discovered membership and preserves capture receipts and unresolved source gaps',
    passed: true,
  });
  await c.query(
    'UPDATE horse_observation_discovery_epochs SET through_ms=$1::bigint,from_ms=$1::bigint-1000,cursor_ms=$1::bigint-1000,slice_through_ms=$1::bigint',
    [at + 3600000]
  );
  assert.deepEqual(await discovery.discoverObservationRequests(), {
    status: 'idle',
    retainedGaps: 1,
  });
  results.push({
    case: 'an idle discovery step still exposes an older unresolved gap rather than reporting an empty healthy backlog',
    passed: true,
  });
  for (const [count, state, reason] of [
    [128, 'gap', 'gap_budget_exceeded'],
    [512, 'discovered', 'retention_backlog'],
  ]) {
    await clear();
    await c.query(
      "INSERT INTO horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms,state,finished_at) SELECT encode(sha256(convert_to('retained-fixture-'||i,'UTF8')),'hex'),$1::bigint+i-1000,$1::bigint+i,CASE WHEN $3='discovered' THEN $1::bigint+i ELSE $1::bigint+i-1000 END,$1::bigint+i,$3,clock_timestamp() FROM generate_series(1,$2::integer) i",
      [at - 86400000, count, state]
    );
    assert.deepEqual(await discovery.discoverObservationRequests(), {
      status: 'unavailable',
      reason,
    });
    assert.equal(
      Number(
        (await c.query('SELECT count(*) n FROM horse_observation_discovery_epochs')).rows[0].n
      ),
      count
    );
  }
  results.push({
    case: '128 retained gaps and512 retained epochs refuse new intake without retiring unresolved evidence; thousand-member retention advances only512 per pass',
    passed: true,
  });
  return results;
}
