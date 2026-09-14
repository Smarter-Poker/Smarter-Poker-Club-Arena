import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export async function exerciseJournalWork({
  root,
  options,
  c,
  otherConnection,
  source,
  readSource,
  actor,
  journal,
  work,
  loseAppendReply,
  loseFinishReply,
}) {
  const results = [],
    snapshots = [];
  for (let n = 1; n <= 8; n++) {
    const s = await readSource({
      actorId: actor,
      fromMs: source.source.fromMs + n,
      throughMs: source.source.throughMs,
    });
    assert.equal(s.status, 'snapshot');
    assert.equal(s.observations.length, 12);
    snapshots.push(s);
  }
  const prepare = (s) => journal.prepareAdaptiveJournalBatch(s);
  const queue = (s) => work.enqueueAdaptiveJournalWork(s);
  const processOne = () => work.processAdaptiveJournalWork();
  const claim = async (token) =>
    (await c.query('SELECT fn_claim_horse_adaptive_batch($1) value', [token])).rows[0].value;
  const finish = async (key, token, outcome) =>
    (await c.query('SELECT fn_finish_horse_adaptive_batch($1,$2,$3) value', [key, token, outcome]))
      .rows[0].value;
  const state = async (key) =>
    (
      await c.query(
        'SELECT state,payload,lease_token,attempts,available_at>clock_timestamp() backoff FROM horse_adaptive_journal_work WHERE batch_key=$1',
        [key]
      )
    ).rows[0];
  const clear = () => c.query('TRUNCATE horse_adaptive_journal_work');
  const count = async () =>
    Number((await c.query('SELECT count(*) n FROM horse_adaptive_observation_journal')).rows[0].n);

  const b = prepare(snapshots[0]);
  assert.equal((await queue(snapshots[0])).status, 'durable');
  assert.equal((await queue(snapshots[0])).status, 'durable');
  assert.equal((await state(b.batchKey)).state, 'queued');
  assert.equal(
    (await c.query('SELECT count(*)::integer n FROM horse_adaptive_journal_work')).rows[0].n,
    1
  );
  const falseFinishToken = randomUUID(),
    claimed = await claim(falseFinishToken);
  assert.equal(claimed.batchKey, b.batchKey);
  assert.equal(
    (await finish(b.batchKey, falseFinishToken, 'recorded')).status,
    'receipt_unconfirmed'
  );
  assert.equal((await state(b.batchKey)).state, 'leased');
  assert.equal((await finish(b.batchKey, randomUUID(), 'recorded')).status, 'lease_lost');
  await c.query(
    "UPDATE horse_adaptive_journal_work SET lease_until=clock_timestamp()-interval '1 second' WHERE batch_key=$1",
    [b.batchKey]
  );
  assert.equal((await finish(b.batchKey, falseFinishToken, 'recorded')).status, 'lease_lost');
  const before = await count();
  // Simulate process-memory loss with no hand/source payload passed to the child.
  const restarted = JSON.parse(
    execFileSync(
      process.execPath,
      [
        root + '/scripts/ci/probes/horse-adaptive-work-restart-child.mjs',
        JSON.stringify({ root, options }),
      ],
      { encoding: 'utf8' }
    )
  );
  assert.equal(restarted.result.status, 'completed');
  assert.equal(restarted.result.batchKey, b.batchKey);
  assert.deepEqual(restarted.calls, [
    'fn_claim_horse_adaptive_batch',
    'fn_append_horse_adaptive_observations',
    'fn_finish_horse_adaptive_batch',
  ]);
  assert.equal((await state(b.batchKey)).payload, null);
  assert.equal(await count(), before);
  assert.equal((await finish(b.batchKey, falseFinishToken, 'recorded')).status, 'lease_lost');
  results.push({
    case: 'durable queued payload survives a process loss and expired claim; old worker cannot acknowledge; no false completion before exact receipt',
    passed: true,
  });

  await clear();
  assert.equal((await queue(snapshots[1])).status, 'durable');
  const second = prepare(snapshots[1]);
  loseAppendReply();
  assert.equal((await processOne()).status, 'deferred');
  assert.equal((await state(second.batchKey)).state, 'queued');
  assert.equal((await state(second.batchKey)).backoff, true);
  assert.equal((await processOne()).status, 'idle');
  assert.equal((await journal.readAdaptiveJournalBatch(second.batchKey)).status, 'prepared');
  await c.query(
    'UPDATE horse_adaptive_journal_work SET available_at=clock_timestamp() WHERE batch_key=$1',
    [second.batchKey]
  );
  assert.equal((await processOne()).status, 'completed');
  assert.equal(await count(), before);
  const owner = (await state(second.batchKey)).lease_token;
  assert.equal((await finish(second.batchKey, owner, 'recorded')).status, 'completed');
  results.push({
    case: 'lost committed write reply defers with backoff then replays exact bytes and acknowledges idempotently',
    passed: true,
  });

  await clear();
  await queue(snapshots[2]);
  loseFinishReply();
  assert.equal((await processOne()).status, 'unknown');
  assert.equal((await state(prepare(snapshots[2]).batchKey)).state, 'completed');
  assert.equal((await processOne()).status, 'idle');
  assert.equal(await count(), before);
  results.push({
    case: 'lost committed acknowledgment remains unknown to caller while durable work is complete',
    passed: true,
  });

  await clear();
  await queue(snapshots[3]);
  await queue(snapshots[4]);
  await c.query('BEGIN');
  const one = await claim(randomUUID());
  const two = (
    await otherConnection.query('SELECT fn_claim_horse_adaptive_batch($1) value', [randomUUID()])
  ).rows[0].value;
  assert.equal(two.status, 'claimed');
  assert.notEqual(one.batchKey, two.batchKey);
  await c.query('COMMIT');
  assert.equal((await processOne()).status, 'idle');
  await clear();
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0))"
  );
  assert.equal((await queue(snapshots[5])).reason, 'capacity_busy');
  await otherConnection.query('ROLLBACK');
  assert.equal((await queue(snapshots[5])).status, 'durable');
  results.push({
    case: 'concurrent claims skip a locked job and capacity contention refuses without waiting',
    passed: true,
  });

  const six = prepare(snapshots[5]),
    changed = JSON.parse(six.payload);
  changed[6] = [['test_gap', 1]];
  assert.equal(
    (await c.query('SELECT fn_queue_horse_adaptive_batch($1) value', [JSON.stringify(changed)]))
      .rows[0].value.reason,
    'batch_conflict'
  );
  assert.equal((await state(six.batchKey)).payload, six.payload);
  const token = randomUUID();
  await claim(token);
  assert.equal((await finish(six.batchKey, token, 'rejected')).status, 'quarantined');
  assert.equal((await state(six.batchKey)).payload, six.payload);
  assert.equal((await processOne()).status, 'idle');
  results.push({
    case: 'conflicting enqueue cannot replace payload; rejected work stays visible and uncounted',
    passed: true,
  });

  await clear();
  // Owner-seeded placeholders only exercise database capacity, never the worker.
  await c.query(
    "INSERT INTO horse_adaptive_journal_work(batch_key,batch_digest,observations,payload) SELECT lpad(to_hex(n),64,'0'),repeat('f',64),0,'[]' FROM generate_series(1,256)n"
  );
  assert.equal((await queue(snapshots[6])).reason, 'queue_full');
  await clear();
  await c.query(
    "INSERT INTO horse_adaptive_journal_work(batch_key,batch_digest,observations,payload) SELECT lpad(to_hex(n),64,'0'),repeat('f',64),0,repeat('x',16777216) FROM generate_series(1,4)n"
  );
  assert.equal((await queue(snapshots[6])).reason, 'queue_full');
  await clear();
  assert.equal((await queue(snapshots[6])).status, 'durable');
  results.push({
    case: 'native unfinished-work bounds refuse the 257th job and bytes above64MiB',
    passed: true,
  });

  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    for (const sql of [
      'SELECT * FROM horse_adaptive_journal_work',
      'DELETE FROM horse_adaptive_journal_work',
      'UPDATE horse_adaptive_journal_work SET state=state',
    ])
      await assert.rejects(c.query(sql), (e) => e.code === '42501');
    if (role !== 'service_role') {
      for (const [sql, args] of [
        ['SELECT fn_queue_horse_adaptive_batch($1)', [b.payload]],
        ['SELECT fn_claim_horse_adaptive_batch($1)', [randomUUID()]],
        ['SELECT fn_finish_horse_adaptive_batch($1,$2,$3)', [b.batchKey, randomUUID(), 'recorded']],
      ])
        await assert.rejects(c.query(sql, args), (e) => e.code === '42501');
    }
    await c.query('RESET ROLE');
  }
  await clear();
  results.push({
    case: 'durable work RPCs are service-only and all direct application table access is denied',
    passed: true,
  });
  return results;
}
