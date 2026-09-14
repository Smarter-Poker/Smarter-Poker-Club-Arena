import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export async function exerciseCaptureSlices({
  root,
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
  const migration =
    'supabase/migrations/20260914032826_recover_horse_observation_capture_slices.sql';
  const original = {
    actorId: actor,
    fromMs: source.source.fromMs + 777,
    throughMs: source.source.throughMs,
  };
  const keyOf = (r) =>
    createHash('sha256')
      .update(['horse-source-request-v1', r.actorId, r.fromMs, r.throughMs].join('|'))
      .digest('hex');
  const key = keyOf(original);
  const query = async (sql, params = []) => (await c.query(sql, params)).rows[0]?.value;
  const claim = (token) => query('SELECT fn_claim_horse_observation_capture($1) value', [token]);
  const finish = (token, payload = null, reason = null) =>
    query('SELECT fn_finish_horse_observation_capture($1,$2,$3,$4) value', [
      key,
      token,
      payload,
      reason,
    ]);
  const state = async () =>
    (await c.query('SELECT * FROM horse_observation_capture_work WHERE request_key=$1', [key]))
      .rows[0];
  const clear = async () =>
    c.query(
      'TRUNCATE horse_observation_capture_receipts,horse_observation_capture_work,horse_adaptive_journal_work'
    );
  const prepared = async (q) => {
    const s = await readSource({
      actorId: actor,
      fromMs: q.sliceFromMs,
      throughMs: q.sliceThroughMs,
    });
    assert.equal(s.status, 'snapshot', JSON.stringify(s));
    const b = journal.prepareAdaptiveJournalBatch(s);
    assert.equal(b.status, 'prepared');
    return b;
  };

  await c.query('TRUNCATE horse_observation_capture_work,horse_adaptive_journal_work');
  await capture.admitObservationCapture(original);
  const oldToken = randomUUID();
  await claim(oldToken);
  assert.equal((await finish(oldToken, null, 'source_budget_exceeded')).status, 'gap');
  assert.equal((await claim(randomUUID())).status, 'idle');
  results.push({ case: 'old source-budget gap is terminal and never claimed again', passed: true });
  await c.query(readFileSync(root + '/' + migration, 'utf8'));

  const firstToken = randomUUID();
  const first = await claim(firstToken);
  assert.equal(first.requestKey, key);
  assert.equal(first.sliceFromMs, original.fromMs);
  assert.equal(first.sliceThroughMs, original.throughMs);
  const refined = await finish(firstToken, null, 'source_budget_exceeded');
  const mid = original.fromMs + Math.floor((original.throughMs - original.fromMs) / 2);
  assert.deepEqual(refined, {
    version: 1,
    status: 'refined',
    requestKey: key,
    nextFromMs: original.fromMs,
    nextThroughMs: mid,
  });
  assert.equal(Number((await state()).cursor_ms), original.fromMs);
  assert.equal(Number((await state()).slice_through_ms), mid);
  assert.equal((await finish(firstToken, null, 'source_budget_exceeded')).status, 'lease_lost');
  assert.equal(Number((await state()).slice_through_ms), mid);
  results.push({
    case: 'old gap is reclaimed and refined once inside its original request without a new queue slot',
    passed: true,
  });

  loseReply('finish');
  assert.equal((await capture.processObservationCapture()).status, 'unknown');
  const afterLost = await state();
  assert.equal(afterLost.state, 'queued');
  assert.equal(afterLost.segments, 1);
  assert.equal(Number(afterLost.cursor_ms), mid);
  const saved = (
    await c.query('SELECT * FROM horse_observation_capture_receipts WHERE request_key=$1', [key])
  ).rows[0];
  const savedPayload = (
    await c.query('SELECT payload FROM horse_adaptive_journal_work WHERE batch_key=$1', [
      saved.acknowledgment.batchKey,
    ])
  ).rows[0].payload;
  await assert.rejects(claim(saved.lease_token), /HORSE_CAPTURE_TOKEN_REUSED/);
  const secondToken = randomUUID(),
    second = await claim(secondToken);
  assert.equal(second.sliceFromMs, mid);
  assert.deepEqual(await finish(saved.lease_token, savedPayload), saved.acknowledgment);
  assert.equal((await state()).lease_token, secondToken);
  assert.equal((await state()).segments, 1);
  await assert.rejects(
    finish(saved.lease_token, savedPayload + ' '),
    /HORSE_CAPTURE_BATCH_CONFLICT/
  );
  const b = await prepared(second);
  const complete = await finish(secondToken, b.payload);
  assert.equal(complete.status, 'captured');
  assert.equal(complete.segments, 2);
  assert.equal(complete.capturedObservations, source.observations.length);
  assert.deepEqual(await finish(secondToken, b.payload), complete);
  assert.equal((await capture.admitObservationCapture(original)).state, 'captured');
  assert.equal((await query('SELECT fn_horse_learning_work_health() value')).capture.unfinished, 0);
  results.push({
    case: 'lost slice acknowledgment replays immutable receipt after a newer claim, preserves new lease and completes exact remaining slice',
    observations: complete.capturedObservations,
    passed: true,
  });

  await clear();
  await capture.admitObservationCapture(original);
  const blockedToken = randomUUID(),
    blockedClaim = await claim(blockedToken);
  const blockedBatch = await prepared(blockedClaim);
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0))"
  );
  try {
    assert.equal((await finish(blockedToken, blockedBatch.payload)).status, 'deferred');
    assert.equal((await state()).segments, 0);
    assert.equal(Number((await state()).cursor_ms), original.fromMs);
    assert.equal(
      Number(
        (await c.query('SELECT count(*) n FROM horse_observation_capture_receipts')).rows[0].n
      ),
      0
    );
  } finally {
    await otherConnection.query('ROLLBACK');
  }
  await c.query(
    "UPDATE horse_observation_capture_work SET available_at=clock_timestamp()-interval '1 second' WHERE request_key=$1",
    [key]
  );
  const rollbackToken = randomUUID();
  await claim(rollbackToken);
  await c.query(`CREATE FUNCTION reject_capture_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'receipt_fixture_failure'; END $f$;
    CREATE TRIGGER reject_capture_receipt_fixture BEFORE INSERT ON horse_observation_capture_receipts FOR EACH ROW EXECUTE FUNCTION reject_capture_receipt_fixture()`);
  try {
    await assert.rejects(finish(rollbackToken, blockedBatch.payload), /receipt_fixture_failure/);
    assert.equal(
      Number((await c.query('SELECT count(*) n FROM horse_adaptive_journal_work')).rows[0].n),
      0
    );
    assert.equal((await state()).segments, 0);
    assert.equal((await state()).state, 'leased');
  } finally {
    await c.query(
      'DROP TRIGGER reject_capture_receipt_fixture ON horse_observation_capture_receipts; DROP FUNCTION reject_capture_receipt_fixture()'
    );
  }
  assert.equal((await finish(rollbackToken, blockedBatch.payload)).status, 'admitted');
  results.push({
    case: 'journal capacity refusal and receipt insertion failure never advance cursor; queue and receipt commit atomically on retry',
    passed: true,
  });

  await clear();
  await capture.admitObservationCapture(original);
  await c.query(
    `INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms,available_at)
    SELECT encode(sha256(convert_to('capacity:'||g,'UTF8')),'hex'),$1,$2::bigint+g,$3,clock_timestamp()+interval '1 day'
      FROM generate_series(1,255) g`,
    [actor, original.fromMs, original.throughMs]
  );
  const saturatedToken = randomUUID();
  await claim(saturatedToken);
  assert.equal((await finish(saturatedToken, null, 'source_budget_exceeded')).status, 'refined');
  assert.equal((await capture.processObservationCapture()).status, 'continued');
  assert.equal((await capture.processObservationCapture()).status, 'captured');
  assert.equal(
    Number((await c.query('SELECT count(*) n FROM horse_observation_capture_work')).rows[0].n),
    256
  );
  assert.equal(
    (await query('SELECT fn_horse_learning_work_health() value')).capture.unfinished,
    255
  );
  results.push({
    case: 'a saturated 256-request queue refines and completes in its same slot without capacity bypass',
    passed: true,
  });

  await clear();
  await capture.admitObservationCapture(original);
  await c.query(
    `UPDATE horse_observation_capture_work SET segments=2048,cursor_ms=from_ms+1,slice_through_ms=through_ms,state='queued',lease_until=NULL WHERE request_key=$1`,
    [key]
  );
  assert.equal((await claim(randomUUID())).reason, 'segment_budget_exceeded');
  assert.equal((await claim(randomUUID())).status, 'idle');
  results.push({
    case: '2048 accepted-slice ceiling retains an explicit gap before any more source I/O',
    passed: true,
  });

  await clear();
  const at = Number(
    (await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint n')).rows[0].n
  );
  const aged = {
    actorId: actor,
    fromMs: at - 86400000 - 60000,
    throughMs: at - 86400000 + 3600000,
  };
  const agedKey = keyOf(aged),
    savedCursor = aged.fromMs + 120000;
  // Controlled persisted-state fixture: the accepted prefix ages out while its
  // still-unread tail remains within the source retention window.
  await c.query(
    `INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms,cursor_ms,slice_through_ms,segments)
    VALUES($1,$2,$3,$4,$5,$4,1)`,
    [agedKey, actor, aged.fromMs, aged.throughMs, savedCursor]
  );
  const agedClaim = await claim(randomUUID());
  assert.equal(agedClaim.status, 'claimed');
  assert.equal(agedClaim.sliceFromMs, savedCursor);
  await c.query(
    "UPDATE horse_observation_capture_work SET cursor_ms=from_ms,state='queued',lease_until=NULL WHERE request_key=$1",
    [agedKey]
  );
  assert.equal((await claim(randomUUID())).reason, 'source_expired');
  assert.equal(
    (
      await c.query('SELECT segments FROM horse_observation_capture_work WHERE request_key=$1', [
        agedKey,
      ])
    ).rows[0].segments,
    1
  );
  results.push({
    case: 'remaining cursor determines source expiry; an aged accepted prefix does not incorrectly expire a readable tail',
    passed: true,
  });

  await clear();
  // Real accepted source rows exercise the actual SQL 513th-hand refusal. The
  // existing three controller hands retain their observations; added empty
  // physical history fixtures contribute no fabricated action evidence.
  const added = [];
  for (let i = 1; i <= 513; i++) {
    const id = '99999999-9999-4999-8999-' + String(i).padStart(12, '0');
    added.push(id);
    const at = original.fromMs + Math.floor((i * (original.throughMs - original.fromMs)) / 514);
    await c.query(
      "INSERT INTO hand_history(id,created_at,players,actions) VALUES($1,to_timestamp($2::double precision/1000),$3::jsonb,'[]'::jsonb)",
      [id, at, JSON.stringify([{ userId: actor }])]
    );
  }
  await c.query(
    "INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,repeat('a',64) FROM hand_history WHERE id=ANY($1::uuid[])",
    [added]
  );
  try {
    assert.equal((await readSource(original)).reason, 'hand_budget_exceeded');
    await capture.admitObservationCapture(original);
    const statuses = [];
    for (let i = 0; i < 64; i++) {
      const result = await capture.processObservationCapture();
      statuses.push(result.status);
      assert.ok(
        ['refined', 'continued', 'captured'].includes(result.status),
        JSON.stringify(result)
      );
      if (result.status === 'captured') break;
    }
    assert.equal(statuses.at(-1), 'captured');
    assert.ok(statuses.includes('refined'));
    const spans = (
      await c.query(
        'SELECT from_ms,through_ms,acknowledgment FROM horse_observation_capture_receipts WHERE request_key=$1 ORDER BY from_ms',
        [key]
      )
    ).rows;
    let cursor = original.fromMs,
      observations = 0;
    for (const span of spans) {
      assert.equal(Number(span.from_ms), cursor);
      cursor = Number(span.through_ms);
      observations += span.acknowledgment.observations;
    }
    assert.equal(cursor, original.throughMs);
    assert.equal(observations, source.observations.length);
    assert.equal((await state()).segments, spans.length);
    results.push({
      case: 'actual 513th-hand source budget recovers exact contiguous original window using compiled adapter and preserves controller observations',
      statuses,
      slices: spans.length,
      observations,
      passed: true,
    });

    await clear();
    await c.query(
      'UPDATE hand_history SET created_at=to_timestamp($1::double precision/1000) WHERE id=ANY($2::uuid[])',
      [original.throughMs, added]
    );
    await capture.admitObservationCapture(original);
    const states = [];
    for (let i = 0; i < 80; i++) {
      const result = await capture.processObservationCapture();
      states.push(result.status);
      assert.ok(['refined', 'continued', 'gap'].includes(result.status), JSON.stringify(result));
      if (result.status === 'gap') break;
    }
    assert.equal(states.at(-1), 'gap');
    const dense = await state();
    assert.equal(dense.reason, 'source_budget_exceeded');
    assert.equal(Number(dense.slice_through_ms) - Number(dense.cursor_ms), 1);
    assert.ok(dense.segments > 0);
    assert.equal((await claim(randomUUID())).status, 'idle');
    const kept = Number(
      (
        await c.query(
          'SELECT count(*) n FROM horse_observation_capture_receipts WHERE request_key=$1',
          [key]
        )
      ).rows[0].n
    );
    assert.equal(kept, dense.segments);
    results.push({
      case: 'indivisible one-millisecond source burst retains explicit gap and every prior accepted slice',
      slices: kept,
      cycles: states.length,
      passed: true,
    });
  } finally {
    await c.query('DELETE FROM hand_atomic_commits WHERE hand_id=ANY($1::uuid[])', [added]);
    await c.query('DELETE FROM hand_history WHERE id=ANY($1::uuid[])', [added]);
  }

  const retainedGapReceipts = Number(
    (
      await c.query(
        'SELECT count(*) n FROM horse_observation_capture_receipts WHERE request_key=$1',
        [key]
      )
    ).rows[0].n
  );
  await c.query(
    "UPDATE horse_observation_capture_work SET created_at=clock_timestamp()-interval '80 days' WHERE request_key=$1",
    [key]
  );
  const retiredKey = keyOf({ ...original, fromMs: original.fromMs + 2 });
  await c.query(
    `INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms,cursor_ms,slice_through_ms,segments,state,admitted_at)
    VALUES($1,$2,$3,$4,$4,$4,2048,'captured',clock_timestamp()-interval '35 days')`,
    [retiredKey, actor, original.fromMs + 2, original.throughMs]
  );
  await c.query(
    `INSERT INTO horse_observation_capture_receipts(request_key,lease_token,from_ms,through_ms,payload_digest,acknowledgment)
    SELECT $1,md5('retention:'||g)::uuid,$2::bigint+g*2,$2::bigint+g*2+1,repeat('a',64),'{}'::jsonb FROM generate_series(1,2048) g`,
    [retiredKey, original.fromMs + 2]
  );
  await c.query(
    `INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms,state,batch_key,batch_digest,observations,admitted_at)
    SELECT encode(sha256(convert_to('retired:'||g,'UTF8')),'hex'),$1,$2,$3,'admitted',repeat('a',64),repeat('b',64),0,clock_timestamp()-interval '33 days'
    FROM generate_series(1,101) g`,
    [actor, original.fromMs, original.throughMs]
  );
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    'SELECT 1 FROM horse_observation_capture_work WHERE request_key=$1 FOR UPDATE',
    [retiredKey]
  );
  let removedRequests = 0,
    removedSlices = 0;
  try {
    const pruned = await capture.pruneObservationCaptures();
    assert.equal(pruned.status, 'pruned');
    assert.equal(pruned.requests, 100);
    assert.equal(pruned.sliceReceipts, 0);
    removedRequests += pruned.requests;
  } finally {
    await otherConnection.query('ROLLBACK');
  }
  for (let i = 0; i < 4; i++) {
    const pruned = await capture.pruneObservationCaptures();
    assert.equal(pruned.status, 'pruned');
    assert.ok(pruned.requests <= 100);
    assert.ok(pruned.sliceReceipts <= 1000);
    removedRequests += pruned.requests;
    removedSlices += pruned.sliceReceipts;
  }
  assert.equal(removedRequests, 102);
  assert.equal(removedSlices, 2048);
  assert.equal((await state()).state, 'gap');
  assert.equal(
    Number(
      (
        await c.query(
          'SELECT count(*) n FROM horse_observation_capture_receipts WHERE request_key=$1',
          [key]
        )
      ).rows[0].n
    ),
    retainedGapReceipts
  );
  results.push({
    case: 'retention skips locked roots, prunes at most100 roots/1000 slice receipts per call and never deletes partial-gap evidence',
    removedRequests,
    removedSlices,
    retainedGapReceipts,
    passed: true,
  });

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const rights = (
      await c.query(
        "SELECT has_table_privilege($1,'horse_observation_capture_receipts','INSERT') ins,has_table_privilege($1,'horse_observation_capture_receipts','UPDATE') upd,has_table_privilege($1,'horse_observation_capture_receipts','DELETE') del,has_table_privilege($1,'horse_observation_capture_receipts','SELECT') sel",
        [role]
      )
    ).rows[0];
    assert.deepEqual(rights, { ins: false, upd: false, del: false, sel: false });
  }
  results.push({
    case: 'all app roles including service have no direct access to private immutable slice receipts',
    passed: true,
  });
  await clear();
  return results;
}
