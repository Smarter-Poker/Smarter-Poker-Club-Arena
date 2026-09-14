import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

export async function exerciseSourceWitnesses({
  root,
  c,
  otherConnection,
  actor,
  source,
  readSource,
  journal,
  capture,
  witness,
  loseReply,
}) {
  const results = [];
  const request = {
    actorId: actor,
    fromMs: source.source.fromMs + 333,
    throughMs: source.source.throughMs,
  };
  const clear = () =>
    c.query(
      'TRUNCATE horse_observation_capture_receipts,horse_observation_capture_work,horse_adaptive_journal_work'
    );
  const sql = async (q, p = []) => (await c.query(q, p)).rows[0]?.value;
  let key;
  const admit = async () => {
    key = (await capture.admitObservationCapture(request)).requestKey;
    assert.ok(key);
  };
  const claim = (token) => sql('SELECT fn_claim_horse_observation_capture($1) value', [token]);
  const finish = (token, payload, w, reason = null) =>
    sql('SELECT fn_finish_horse_observation_capture_witness($1,$2,$3,$4,$5) value', [
      key,
      token,
      payload,
      reason,
      w,
    ]);
  const receipt = async (token) =>
    (
      await c.query(
        'SELECT * FROM horse_observation_capture_receipts WHERE request_key=$1 AND lease_token=$2',
        [key, token]
      )
    ).rows[0];
  const prepare = async (q) => {
    const s = await readSource({
      actorId: actor,
      fromMs: q.sliceFromMs,
      throughMs: q.sliceThroughMs,
    });
    assert.equal(s.status, 'snapshot');
    const b = journal.prepareAdaptiveJournalBatch(s),
      w = witness.prepareObservationSourceWitness(s);
    assert.equal(b.status, 'prepared');
    assert.ok(w);
    return { b, w, s };
  };
  await clear();
  await admit();
  const legacyToken = randomUUID(),
    legacyClaim = await claim(legacyToken);
  const legacy = await prepare(legacyClaim);
  assert.equal(
    (
      await sql('SELECT fn_finish_horse_observation_capture($1,$2,$3,NULL) value', [
        key,
        legacyToken,
        legacy.b.payload,
      ])
    ).status,
    'admitted'
  );
  await c.query(
    readFileSync(
      root + '/supabase/migrations/20260914041305_preserve_horse_capture_source_witnesses.sql',
      'utf8'
    )
  );
  assert.equal((await receipt(legacyToken)).source_witness, null);
  await assert.rejects(
    finish(legacyToken, legacy.b.payload, legacy.w.payload),
    /HORSE_SOURCE_WITNESS_UNAVAILABLE/
  );
  assert.equal((await receipt(legacyToken)).source_witness, null);
  assert.equal(
    (
      await sql('SELECT fn_finish_horse_observation_capture($1,$2,$3,NULL) value', [
        key,
        legacyToken,
        legacy.b.payload,
      ])
    ).status,
    'admitted'
  );
  // Reconstruct the older pre-slice admitted shape: it has no per-token slice
  // row at all. Neither historical representation can acquire a new witness.
  await c.query('DELETE FROM horse_observation_capture_receipts WHERE request_key=$1', [key]);
  await c.query(
    'UPDATE horse_observation_capture_work SET segments=0,captured_observations=0,cursor_ms=NULL,slice_through_ms=NULL WHERE request_key=$1',
    [key]
  );
  await assert.rejects(
    finish(legacyToken, legacy.b.payload, legacy.w.payload),
    /HORSE_SOURCE_WITNESS_UNAVAILABLE/
  );
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_receipts')).rows[0].n,
    '0'
  );
  results.push({
    case: 'legacy accepted acquisition remains replayable but cannot receive a retrospective source witness',
    passed: true,
  });

  await clear();
  await admit();
  const firstToken = randomUUID(),
    first = await claim(firstToken);
  assert.equal(first.sourceWitnessVersion, 1);
  const prepared = await prepare(first);
  for (const change of [
    (w) => {
      w[1] = 'e'.repeat(64);
    },
    (w) => {
      w[2]++;
    },
    (w) => {
      w[3]--;
    },
    (w) => {
      w[4] = w[3] - 1;
    },
    (w) => {
      w[5] = 'bad';
    },
    (w) => {
      w[6] = 513;
    },
    (w) => {
      w[7] = 8388609;
    },
    (w) => {
      w[8] = 'e'.repeat(64);
    },
    (w) => {
      w.push('extra');
    },
    (w) => {
      w[6] = null;
    },
    (w) => {
      w[4] = Date.now() + 60000;
    },
  ]) {
    const w = JSON.parse(prepared.w.payload);
    change(w);
    await assert.rejects(
      finish(firstToken, prepared.b.payload, JSON.stringify(w)),
      /HORSE_SOURCE_WITNESS/
    );
  }
  await assert.rejects(
    finish(firstToken, prepared.b.payload, ' '.repeat(8193)),
    /HORSE_SOURCE_WITNESS_INVALID/
  );
  await assert.rejects(
    finish(firstToken, null, prepared.w.payload),
    /HORSE_SOURCE_WITNESS_WITHOUT_BATCH/
  );
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_receipts')).rows[0].n,
    '0'
  );
  assert.equal((await finish(firstToken, null, null, 'source_budget_exceeded')).status, 'refined');
  results.push({
    case: 'malformed, mismatched and oversized source witnesses refuse without changing cursor or recording evidence; refinement needs no witness',
    cases: 13,
    passed: true,
  });

  loseReply();
  assert.equal((await capture.processObservationCapture()).status, 'unknown');
  const firstReceipt = (
    await c.query('SELECT * FROM horse_observation_capture_receipts WHERE request_key=$1', [key])
  ).rows[0];
  const firstPayload = (
    await c.query('SELECT payload FROM horse_adaptive_journal_work WHERE batch_key=$1', [
      firstReceipt.acknowledgment.batchKey,
    ])
  ).rows[0].payload;
  assert.equal(
    firstReceipt.source_witness_digest,
    createHash('sha256').update(firstReceipt.source_witness).digest('hex')
  );
  const secondToken = randomUUID(),
    second = await claim(secondToken);
  assert.deepEqual(
    await finish(firstReceipt.lease_token, firstPayload, firstReceipt.source_witness),
    firstReceipt.acknowledgment
  );
  const changed = JSON.parse(firstReceipt.source_witness);
  changed[7]++;
  await assert.rejects(
    finish(firstReceipt.lease_token, firstPayload, JSON.stringify(changed)),
    /HORSE_SOURCE_WITNESS_CONFLICT/
  );
  assert.equal(
    (
      await c.query('SELECT lease_token FROM horse_observation_capture_work WHERE request_key=$1', [
        key,
      ])
    ).rows[0].lease_token,
    secondToken
  );
  const remaining = await prepare(second),
    completed = await finish(secondToken, remaining.b.payload, remaining.w.payload);
  assert.equal(completed.status, 'captured');
  assert.equal(completed.sourceWitnessDigest, remaining.w.digest);
  assert.equal(completed.capturedObservations, 12);
  results.push({
    case: 'compiled adapter preserves the source read through lost finish reply and newer lease; altered witness refuses; all12 observations survive',
    passed: true,
  });

  await clear();
  await admit();
  const rollbackToken = randomUUID(),
    rollbackClaim = await claim(rollbackToken),
    rollback = await prepare(rollbackClaim);
  await otherConnection.query('BEGIN');
  try {
    await otherConnection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('horse-adaptive-work-capacity-v1',0))"
    );
    assert.equal(
      (await finish(rollbackToken, rollback.b.payload, rollback.w.payload)).status,
      'deferred'
    );
    assert.equal(
      (await c.query('SELECT count(*) n FROM horse_observation_capture_receipts')).rows[0].n,
      '0'
    );
  } finally {
    await otherConnection.query('ROLLBACK');
  }
  await c.query(
    "UPDATE horse_observation_capture_work SET available_at=clock_timestamp()-interval '1 second' WHERE request_key=$1",
    [key]
  );
  const atomicToken = randomUUID();
  await claim(atomicToken);
  await c.query(
    "CREATE FUNCTION reject_source_witness_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'witness fixture refusal'; END$$; CREATE TRIGGER reject_source_witness_fixture BEFORE UPDATE ON horse_observation_capture_receipts FOR EACH ROW EXECUTE FUNCTION reject_source_witness_fixture()"
  );
  try {
    await assert.rejects(
      finish(atomicToken, rollback.b.payload, rollback.w.payload),
      /witness fixture refusal/
    );
    assert.equal(
      (await c.query('SELECT count(*) n FROM horse_adaptive_journal_work')).rows[0].n,
      '0'
    );
    assert.equal(
      (await c.query('SELECT count(*) n FROM horse_observation_capture_receipts')).rows[0].n,
      '0'
    );
    const r = (
      await c.query(
        'SELECT state,segments,cursor_ms FROM horse_observation_capture_work WHERE request_key=$1',
        [key]
      )
    ).rows[0];
    assert.equal(r.state, 'leased');
    assert.equal(r.segments, 0);
    assert.equal(Number(r.cursor_ms), request.fromMs);
  } finally {
    await c.query(
      'DROP TRIGGER reject_source_witness_fixture ON horse_observation_capture_receipts; DROP FUNCTION reject_source_witness_fixture()'
    );
  }
  assert.equal(
    (await finish(atomicToken, rollback.b.payload, rollback.w.payload)).status,
    'admitted'
  );
  results.push({
    case: 'capacity refusal writes no witness; witness-write failure rolls back journal admission and cursor; exact retry commits together',
    passed: true,
  });
  for (const role of ['anon', 'authenticated']) {
    await c.query('SET ROLE ' + role);
    try {
      await assert.rejects(finish(null, null, null), /permission denied/);
    } finally {
      await c.query('RESET ROLE');
    }
  }
  await c.query(
    "UPDATE horse_observation_capture_work SET admitted_at=clock_timestamp()-interval '33 days' WHERE request_key=$1",
    [key]
  );
  assert.deepEqual(await capture.pruneObservationCaptures(), {
    status: 'pruned',
    requests: 1,
    sliceReceipts: 1,
  });
  assert.equal(
    (await c.query('SELECT count(*) n FROM horse_observation_capture_receipts')).rows[0].n,
    '0'
  );
  results.push({
    case: 'new witnessed finish is service-only and existing bounded retention removes the witness with its terminal receipt',
    passed: true,
  });
  await clear();
  return results;
}
