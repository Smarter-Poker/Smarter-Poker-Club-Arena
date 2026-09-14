import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function exerciseObservationCapture({
  c,
  otherConnection,
  actor,
  source,
  readSource,
  journal,
  capture,
  loseReply,
}) {
  const results = [];
  let serial = 100;
  const request = () => ({
    actorId: actor,
    fromMs: source.source.fromMs + ++serial,
    throughMs: source.source.throughMs,
  });
  const keyOf = (r) =>
    createHash('sha256')
      .update(['horse-source-request-v1', r.actorId, r.fromMs, r.throughMs].join('|'))
      .digest('hex');
  const clear = () =>
    c.query('TRUNCATE horse_observation_capture_work,horse_adaptive_journal_work');
  const state = async (key) =>
    (
      await c.query(
        'SELECT state,lease_token,batch_key,batch_digest,observations,reason,available_at>clock_timestamp() backoff FROM horse_observation_capture_work WHERE request_key=$1',
        [key]
      )
    ).rows[0];
  const count = async () =>
    Number((await c.query('SELECT count(*) n FROM horse_adaptive_journal_work')).rows[0].n);
  const claim = async (token) =>
    (await c.query('SELECT fn_claim_horse_observation_capture($1) value', [token])).rows[0].value;
  const finish = async (key, token, payload, reason = null) =>
    (
      await c.query('SELECT fn_finish_horse_observation_capture($1,$2,$3,$4) value', [
        key,
        token,
        payload,
        reason,
      ])
    ).rows[0].value;
  const prepared = async (r) => journal.prepareAdaptiveJournalBatch(await readSource(r));
  await clear();
  const a = request();
  loseReply('admit');
  assert.equal((await capture.admitObservationCapture(a)).status, 'unknown');
  assert.equal((await capture.admitObservationCapture(a)).state, 'queued');
  assert.equal(await count(), 0);
  loseReply('finish');
  assert.equal((await capture.processObservationCapture()).status, 'unknown');
  const stored = await state(keyOf(a));
  assert.equal(stored.state, 'admitted');
  assert.equal(await count(), 1);
  const payload = (
    await c.query('SELECT payload FROM horse_adaptive_journal_work WHERE batch_key=$1', [
      stored.batch_key,
    ])
  ).rows[0].payload;
  assert.equal((await finish(keyOf(a), stored.lease_token, payload)).status, 'admitted');
  assert.equal((await capture.admitObservationCapture(a)).state, 'admitted');
  assert.equal(await count(), 1);
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('horse-source-capacity-v1',0))"
  );
  try {
    assert.equal((await capture.admitObservationCapture(request())).reason, 'capacity_busy');
    assert.equal((await capture.admitObservationCapture(a)).state, 'admitted');
  } finally {
    await otherConnection.query('ROLLBACK');
  }
  results.push({
    case: 'lost admission and queued-payload acknowledgment replay one original request and one exact durable batch',
    passed: true,
  });

  await clear();
  const b = request();
  await capture.admitObservationCapture(b);
  loseReply('claim');
  assert.equal((await capture.processObservationCapture()).status, 'unavailable');
  const old = await state(keyOf(b));
  assert.equal(old.state, 'leased');
  await c.query(
    "UPDATE horse_observation_capture_work SET lease_until=clock_timestamp()-interval '1 second' WHERE request_key=$1",
    [keyOf(b)]
  );
  const leasedHealth = (await c.query('SELECT fn_horse_learning_work_health() value')).rows[0].value
    .capture;
  assert.equal(leasedHealth.unfinished, 1);
  assert.equal(leasedHealth.leased, 1);
  assert.equal(leasedHealth.expiredLeases, 1);
  assert.equal(leasedHealth.ready, 1);
  const bPayload = await prepared(b);
  assert.equal((await finish(keyOf(b), old.lease_token, bPayload.payload)).status, 'lease_lost');
  assert.equal((await capture.processObservationCapture()).status, 'admitted');
  assert.equal(await count(), 1);
  results.push({
    case: 'lost claim retains original scope; expired token cannot enqueue; later claim resumes it',
    passed: true,
  });

  await clear();
  const first = request(),
    second = request();
  await capture.admitObservationCapture(first);
  await capture.admitObservationCapture(second);
  await c.query('BEGIN');
  const one = await claim(randomUUID());
  const two = (
    await otherConnection.query('SELECT fn_claim_horse_observation_capture($1) value', [
      randomUUID(),
    ])
  ).rows[0].value;
  assert.notEqual(one.requestKey, two.requestKey);
  await c.query('COMMIT');
  const wrong = await prepared(second);
  await assert.rejects(
    finish(keyOf(first), one.leaseToken, wrong.payload),
    /HORSE_CAPTURE_SCOPE_MISMATCH/
  );
  assert.equal(await count(), 0);
  assert.equal((await state(keyOf(first))).state, 'leased');
  results.push({
    case: 'concurrent claims skip locked requests and mismatched actor/window payloads cannot be admitted',
    passed: true,
  });

  await clear();
  const backpressure = request();
  await capture.admitObservationCapture(backpressure);
  const lease = await claim(randomUUID());
  await c.query(
    "INSERT INTO horse_adaptive_journal_work(batch_key,batch_digest,observations,payload) SELECT md5(i::text)||md5(i::text),repeat('a',64),0,'[]' FROM generate_series(1,256) i"
  );
  const wanted = await prepared(backpressure);
  const refused = await finish(lease.requestKey, lease.leaseToken, wanted.payload);
  assert.equal(refused.status, 'deferred');
  assert.equal(refused.reason, 'queue_full');
  assert.equal((await state(lease.requestKey)).state, 'queued');
  assert.equal((await state(lease.requestKey)).backoff, true);
  await c.query('TRUNCATE horse_adaptive_journal_work');
  await c.query('UPDATE horse_observation_capture_work SET available_at=clock_timestamp()');
  assert.equal((await capture.processObservationCapture()).status, 'admitted');
  results.push({
    case: 'journal buffer pressure defers the original acquisition with backoff; later admission succeeds without dropping scope',
    passed: true,
  });

  await clear();
  const unavailable = request();
  await capture.admitObservationCapture(unavailable);
  let l = await claim(randomUUID());
  assert.equal(
    (await finish(l.requestKey, l.leaseToken, null, 'transport_error')).status,
    'deferred'
  );
  assert.equal((await state(l.requestKey)).reason, 'source_unavailable');
  await c.query('UPDATE horse_observation_capture_work SET available_at=clock_timestamp()');
  l = await claim(randomUUID());
  assert.equal(
    (await finish(l.requestKey, l.leaseToken, null, 'source_budget_exceeded')).status,
    'gap'
  );
  assert.equal((await state(l.requestKey)).state, 'gap');
  assert.equal(await count(), 0);
  results.push({
    case: 'transport uncertainty remains retryable; declared source overflow remains an explicit gap without a partial batch',
    passed: true,
  });

  await clear();
  const capacity = [];
  for (let n = 0; n < 256; n++) {
    const r = request();
    capacity.push({
      request_key: keyOf(r),
      actor_id: r.actorId,
      from_ms: r.fromMs,
      through_ms: r.throughMs,
    });
  }
  await c.query(
    'INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms) SELECT request_key,actor_id,from_ms,through_ms FROM jsonb_to_recordset($1::jsonb) AS x(request_key text,actor_id uuid,from_ms bigint,through_ms bigint)',
    [JSON.stringify(capacity)]
  );
  assert.equal((await capture.admitObservationCapture(request())).reason, 'capture_queue_full');
  const original = {
    actorId: capacity[0].actor_id,
    fromMs: capacity[0].from_ms,
    throughMs: capacity[0].through_ms,
  };
  assert.equal((await capture.admitObservationCapture(original)).status, 'durable');
  const fullHealth = (await c.query('SELECT fn_horse_learning_work_health() value')).rows[0].value
    .capture;
  assert.equal(fullHealth.status, 'snapshot');
  assert.equal(fullHealth.unfinished, 256);
  const overflow = request();
  await c.query(
    'INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms) VALUES($1,$2,$3,$4)',
    [keyOf(overflow), actor, overflow.fromMs, overflow.throughMs]
  );
  assert.deepEqual(
    (await c.query('SELECT fn_horse_learning_work_health() value')).rows[0].value.capture,
    { version: 1, status: 'unavailable', reason: 'queue_budget_exceeded' }
  );
  results.push({
    case: 'the 257th unfinished request refuses while an existing request remains replayable; corrupted oversized queue health refuses instead of truncating',
    passed: true,
  });

  await clear();
  const at = Number(
    (await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint n')).rows[0].n
  );
  const expired = { actorId: actor, fromMs: at - 86400000 + 500, throughMs: at - 86400000 + 1500 };
  assert.equal((await capture.admitObservationCapture(expired)).status, 'durable');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await capture.processObservationCapture()).status, 'gap');
  assert.equal((await state(keyOf(expired))).reason, 'source_expired');
  const health = (await c.query('SELECT fn_horse_learning_work_health() value')).rows[0].value;
  assert.equal(health.capture.status, 'snapshot');
  assert.equal(health.capture.gaps, 1);
  assert.equal(health.capture.unfinished, 1);
  assert.equal(health.journal.unfinished, 0);
  assert.ok(!JSON.stringify(health).includes(actor));
  results.push({
    case: 'a naturally expired source window becomes a retained gap before any source read',
    passed: true,
  });

  const originalGap = keyOf(expired);
  await c.query(
    "INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms,state,batch_key,batch_digest,observations,admitted_at) SELECT md5(i::text)||md5(i::text),$1,0,1,'admitted',repeat('a',64),repeat('b',64),0,clock_timestamp()-interval '33 days' FROM generate_series(1,101) i",
    [actor]
  );
  assert.deepEqual(await capture.pruneObservationCaptures(), { status: 'pruned', requests: 100 });
  assert.equal((await state(originalGap)).state, 'gap');
  assert.equal(
    Number(
      (
        await c.query(
          "SELECT count(*) n FROM horse_observation_capture_work WHERE state='admitted'"
        )
      ).rows[0].n
    ),
    1
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    await assert.rejects(
      c.query('DELETE FROM horse_observation_capture_work'),
      (e) => e.code === '42501'
    );
    if (role !== 'service_role') {
      await assert.rejects(
        c.query('SELECT fn_claim_horse_observation_capture($1)', [randomUUID()]),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT fn_admit_horse_observation_capture($1,$2,$3)', [actor, 1000, 2000]),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT fn_finish_horse_observation_capture($1,$2,$3,$4)', [
          originalGap,
          randomUUID(),
          null,
          null,
        ]),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT fn_prune_horse_observation_captures()'),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        c.query('SELECT fn_horse_learning_work_health()'),
        (e) => e.code === '42501'
      );
    }
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'retention removes at most 100 old admitted receipts and preserves unresolved gaps; callers cannot bypass service RPCs',
    passed: true,
  });
  await clear();
  return results;
}
