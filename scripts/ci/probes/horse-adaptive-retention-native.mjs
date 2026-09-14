import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = (s) => createHash('sha256').update(s).digest('hex');
export function oldEmptyBatch(now, marker) {
  const from = now - 40 * 86400000,
    through = from + 3600000;
  const actor = hash('retention actor'),
    source = hash(marker);
  const key = hash(['adaptive-journal-v1', actor, source, from, through].join('|'));
  const payload = JSON.stringify([1, key, actor, from, through, source, [], []]);
  return { key, payload, digest: hash(payload), actor, from, through, source };
}

export async function exerciseRetention({ c, otherConnection, retention, losePruneReply }) {
  const results = [];
  const now = Number(
    (await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint n')).rows[0].n
  );
  const original = (await c.query('SELECT * FROM horse_adaptive_observation_journal LIMIT 1'))
    .rows[0];
  assert.ok(original);
  await c.query(
    'TRUNCATE horse_adaptive_journal_work,horse_adaptive_observation_batches,horse_adaptive_observation_journal'
  );
  const insertBatch = async (n, state, completionDays = 40) => {
    const b = oldEmptyBatch(now, 'retention-' + n);
    await c.query(
      `INSERT INTO horse_adaptive_observation_batches
      (batch_key,batch_digest,actor_key,source_digest,from_ms,through_ms,observation_count,rejected,canonical_payload,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,0,'[]',$7,clock_timestamp()-interval '40 days')`,
      [b.key, b.digest, b.actor, b.source, b.from, b.through, b.payload]
    );
    if (state)
      await c.query(
        `INSERT INTO horse_adaptive_journal_work
      (batch_key,batch_digest,observations,payload,state,completed_at)
      VALUES($1,$2,0,$3,$4,clock_timestamp()-make_interval(days=>$5))`,
        [b.key, b.digest, state === 'completed' ? null : b.payload, state, completionDays]
      );
    return b;
  };
  for (let n = 0; n < 101; n++) await insertBatch(n, 'completed');
  const queued = await insertBatch('queued', 'queued');
  const quarantine = await insertBatch('quarantine', 'quarantined');
  const recentCompleted = await insertBatch('recent-completed', 'completed', 31);
  const recentSource = await insertBatch('recent-source');
  await c.query('UPDATE horse_adaptive_observation_batches SET through_ms=$1 WHERE batch_key=$2', [
    now - 29 * 86400000,
    recentSource.key,
  ]);
  const insertFact = (label, recordedDays, observedDays) =>
    c.query(
      `INSERT INTO horse_adaptive_observation_journal
    (observation_id,hand_id,actor_key,session_key,observed_at_ms,partition,scope_key,origin,payload,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()-make_interval(days=>$10))`,
      [
        label,
        original.hand_id,
        original.actor_key,
        original.session_key,
        now - observedDays * 86400000,
        original.partition,
        original.scope_key,
        original.origin,
        original.payload,
        recordedDays,
      ]
    );
  // Synthetic storage-lifecycle fixtures; public payload qualification was
  // independently exercised through actual completed controllers above.
  for (let n = 0; n < 1005; n++) await insertFact('expired:' + n, 40, 40);
  await insertFact('keep:observation', 40, 29);
  await insertFact('keep:recorded', 31, 40);
  await insertFact('keep:both', 31, 29);
  const prune = () => retention.pruneAdaptiveJournal();
  await c.query('SET ROLE service_role');
  assert.deepEqual(await prune(), {
    status: 'pruned',
    completedWork: 100,
    batches: 100,
    observations: 1000,
  });
  await c.query('RESET ROLE');
  const rows = async (table) =>
    Number((await c.query('SELECT count(*) n FROM ' + table)).rows[0].n);
  assert.equal(await rows('horse_adaptive_observation_journal'), 8);
  assert.equal(await rows('horse_adaptive_journal_work'), 4);
  for (const b of [queued, quarantine, recentCompleted, recentSource]) {
    assert.equal(
      (
        await c.query(
          'SELECT canonical_payload FROM horse_adaptive_observation_batches WHERE batch_key=$1',
          [b.key]
        )
      ).rows[0].canonical_payload,
      b.payload
    );
  }
  assert.equal(
    (
      await c.query(`SELECT count(*)::int n FROM horse_adaptive_journal_work w
    WHERE NOT EXISTS(SELECT 1 FROM horse_adaptive_observation_batches b WHERE b.batch_key=w.batch_key)`)
    ).rows[0].n,
    0
  );
  assert.deepEqual(await prune(), {
    status: 'pruned',
    completedWork: 1,
    batches: 1,
    observations: 5,
  });
  assert.deepEqual(
    (
      await c.query(
        'SELECT observation_id FROM horse_adaptive_observation_journal ORDER BY observation_id'
      )
    ).rows.map((x) => x.observation_id),
    ['keep:both', 'keep:observation', 'keep:recorded']
  );
  assert.deepEqual(await prune(), {
    status: 'pruned',
    completedWork: 0,
    batches: 0,
    observations: 0,
  });
  results.push({
    case: 'fixed pass budgets, both independent fact clocks, source cutoff, all unfinished/quarantine and recent completed receipt dependencies retained',
    passed: true,
  });

  const queue = async (b) =>
    (await c.query('SELECT fn_queue_horse_adaptive_batch($1) value', [b.payload])).rows[0].value;
  assert.equal((await queue(queued)).status, 'durable');
  assert.equal((await queue(quarantine)).status, 'durable');
  assert.equal((await queue(recentCompleted)).status, 'durable');
  assert.equal((await queue(oldEmptyBatch(now, 'new-expired'))).reason, 'source_expired');
  assert.equal((await queue(recentSource)).reason, 'source_expired');
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0))"
  );
  assert.deepEqual(await prune(), { status: 'unavailable', reason: 'capacity_busy' });
  assert.equal((await queue(oldEmptyBatch(now, 'busy-new'))).reason, 'capacity_busy');
  assert.equal((await queue(queued)).status, 'durable');
  await otherConnection.query('ROLLBACK');
  results.push({
    case: 'old accepted work replays; stale new work refused even with retained receipt; shared admission/prune reservation never waits',
    passed: true,
  });

  const locked = await insertBatch('locked', 'completed');
  await insertFact('expired:locked', 40, 40);
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    'SELECT 1 FROM horse_adaptive_journal_work WHERE batch_key=$1 FOR UPDATE',
    [locked.key]
  );
  await otherConnection.query(
    "SELECT 1 FROM horse_adaptive_observation_journal WHERE observation_id='expired:locked' FOR UPDATE"
  );
  assert.deepEqual(await prune(), {
    status: 'pruned',
    completedWork: 0,
    batches: 0,
    observations: 0,
  });
  assert.equal(
    (
      await c.query(
        'SELECT count(*)::int n FROM horse_adaptive_observation_batches WHERE batch_key=$1',
        [locked.key]
      )
    ).rows[0].n,
    1
  );
  await otherConnection.query('ROLLBACK');
  losePruneReply();
  assert.deepEqual(await prune(), { status: 'unknown' });
  assert.equal(
    (
      await c.query('SELECT count(*)::int n FROM horse_adaptive_journal_work WHERE batch_key=$1', [
        locked.key,
      ])
    ).rows[0].n,
    0
  );
  assert.deepEqual(await prune(), {
    status: 'pruned',
    completedWork: 0,
    batches: 0,
    observations: 0,
  });
  results.push({
    case: 'locked rows skip without dropping dependent receipt; committed lost prune reply remains unknown and retry is bounded',
    passed: true,
  });

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const p = (
      await c.query(
        "SELECT has_function_privilege($1,'fn_prune_horse_adaptive_journal()','EXECUTE') execute",
        [role]
      )
    ).rows[0];
    assert.equal(p.execute, role === 'service_role');
    for (const table of [
      'horse_adaptive_journal_work',
      'horse_adaptive_observation_batches',
      'horse_adaptive_observation_journal',
    ]) {
      assert.equal(
        (await c.query("SELECT has_table_privilege($1,$2,'DELETE') allowed", [role, table])).rows[0]
          .allowed,
        false
      );
    }
  }
  results.push({
    case: 'only service RPC can prune; direct app deletion remains denied on every learner table',
    passed: true,
  });
  return results;
}
