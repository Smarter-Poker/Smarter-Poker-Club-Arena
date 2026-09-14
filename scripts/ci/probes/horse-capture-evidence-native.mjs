import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export async function exerciseCaptureEvidence({
  root,
  c,
  otherConnection,
  actor,
  source,
  readSource,
  journal,
  capture,
  witness,
  evidence,
  calls,
}) {
  const results = [],
    read = evidence.readCaptureEvidencePage;
  const sql = async (query, params = []) => (await c.query(query, params)).rows[0]?.value;
  await c.query(
    readFileSync(
      root + '/supabase/migrations/20260914043633_read_bounded_horse_capture_evidence.sql',
      'utf8'
    )
  );
  const persisted = (
    await c.query(
      "SELECT * FROM horse_observation_capture_work WHERE state='captured' ORDER BY admitted_at DESC LIMIT 1"
    )
  ).rows[0];
  assert.ok(persisted);
  const request = {
    actorId: persisted.actor_id,
    fromMs: Number(persisted.from_ms),
    throughMs: Number(persisted.through_ms),
  };
  const before = await read(request);
  assert.equal(before.status, 'snapshot');
  assert.equal(before.rows.length, 2);
  for (const r of before.rows) {
    assert.ok(r.source);
    assert.equal(r.journalReceipt, 'matched');
    assert.equal(r.queueState, 'completed');
  }
  // These bytes were recorded by the actual worker across its earlier process
  // termination. Destroy the disposable source rows: recovery may read only
  // capture/journal metadata, and must not refresh the original witness.
  await c.query('TRUNCATE hand_history,hand_atomic_commits');
  const fingerprint = () =>
    sql(
      'SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(w) ORDER BY request_key) FROM horse_observation_capture_work w),(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_key,from_ms) FROM horse_observation_capture_receipts r),(SELECT jsonb_agg(to_jsonb(b) ORDER BY batch_key) FROM horse_adaptive_observation_batches b),(SELECT jsonb_agg(to_jsonb(q) ORDER BY batch_key) FROM horse_adaptive_journal_work q))::text) value'
    );
  const saved = await fingerprint(),
    callStart = calls.length;
  await c.query('BEGIN READ ONLY');
  const recovered = await read(request);
  await c.query('COMMIT');
  assert.equal(recovered.status, 'snapshot');
  assert.deepEqual(recovered.rows, before.rows);
  assert.equal(recovered.revision, before.revision);
  assert.equal(recovered.sourceCoverage, 'not_established');
  assert.deepEqual(calls.slice(callStart), ['fn_horse_observation_capture_evidence']);
  assert.equal(await fingerprint(), saved);
  results.push({
    case: 'actual restarted worker witnesses recover byte-for-byte after original source removal in a read-only transaction',
    slices: 2,
    originalSourceRows: 0,
    sourceReads: 0,
    unchangedState: true,
    passed: true,
  });

  const first = before.rows[0];
  await c.query('BEGIN');
  await c.query(
    'UPDATE horse_adaptive_observation_batches SET canonical_payload=NULL WHERE batch_key=$1',
    [first.batchKey]
  );
  const retired = await read(request);
  assert.equal(retired.status, 'snapshot');
  assert.equal(retired.rows[0].journalReceipt, 'payload_missing');
  assert.deepEqual(retired.rows[0].source, first.source);
  await c.query('DELETE FROM horse_adaptive_journal_work WHERE batch_key=$1', [first.batchKey]);
  await c.query('DELETE FROM horse_adaptive_observation_batches WHERE batch_key=$1', [
    first.batchKey,
  ]);
  const missing = await read(request);
  assert.equal(missing.status, 'snapshot');
  assert.equal(missing.rows[0].journalReceipt, 'missing');
  assert.equal(missing.rows[0].queueState, 'missing');
  assert.deepEqual(missing.rows[0].source, first.source);
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query(
    "UPDATE horse_adaptive_observation_batches SET batch_digest=repeat('e',64) WHERE batch_key=$1",
    [first.batchKey]
  );
  assert.equal((await read(request)).reason, 'journal_receipt_conflict');
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query(
    "UPDATE horse_adaptive_journal_work SET batch_digest=repeat('e',64) WHERE batch_key=$1",
    [first.batchKey]
  );
  assert.equal((await read(request)).reason, 'journal_receipt_conflict');
  await c.query('ROLLBACK');
  assert.equal(await fingerprint(), saved);
  results.push({
    case: 'retired payloads and missing journals preserve original witnesses; immutable receipt and queue conflicts refuse',
    passed: true,
  });

  // Exercise real admission/claim/source/finish for 65 small slices. Only the
  // fixture partition width is set directly, to avoid manufacturing overload.
  // All observed source snapshots below are genuinely empty after truncation.
  await c.query(
    'TRUNCATE horse_observation_capture_receipts,horse_observation_capture_work,horse_adaptive_journal_work'
  );
  const paged = {
    actorId: actor,
    fromMs: source.source.fromMs + 900,
    throughMs: source.source.fromMs + 965,
  };
  const admitted = await capture.admitObservationCapture(paged);
  assert.equal(admitted.status, 'durable');
  const key = admitted.requestKey;
  for (let i = 0; i < 65; i++) {
    await c.query(
      'UPDATE horse_observation_capture_work SET cursor_ms=$2,slice_through_ms=$3,available_at=clock_timestamp() WHERE request_key=$1',
      [key, paged.fromMs + i, paged.fromMs + i + 1]
    );
    const token = randomUUID(),
      claim = await sql('SELECT fn_claim_horse_observation_capture($1) value', [token]);
    assert.equal(claim.status, 'claimed');
    const snapshot = await readSource({
      actorId: actor,
      fromMs: claim.sliceFromMs,
      throughMs: claim.sliceThroughMs,
    });
    assert.equal(snapshot.status, 'snapshot');
    const batch = journal.prepareAdaptiveJournalBatch(snapshot),
      w = witness.prepareObservationSourceWitness(snapshot);
    assert.equal(batch.status, 'prepared');
    assert.ok(w);
    const finish = await sql(
      'SELECT fn_finish_horse_observation_capture_witness($1,$2,$3,NULL,$4) value',
      [key, token, batch.payload, w.payload]
    );
    assert.equal(finish.status, i === 64 ? 'captured' : 'continued');
  }
  const a = await read(paged);
  assert.equal(a.status, 'snapshot');
  assert.equal(a.rows.length, 64);
  assert.ok(a.nextCursor);
  const b = await read(paged, a.nextCursor);
  assert.equal(b.status, 'snapshot');
  assert.equal(b.rows.length, 1);
  assert.equal(b.nextCursor, null);
  assert.equal(b.rows[0].segment, 65);
  assert.equal(a.revision, b.revision);
  assert.equal(a.observations, 0);
  assert.equal(b.observations, 0);
  for (const r of [...a.rows, ...b.rows]) {
    assert.ok(r.source);
    assert.equal(r.journalReceipt, 'missing');
    assert.equal(r.queueState, 'queued');
  }
  const raw = await sql('SELECT fn_horse_observation_capture_evidence($1,$2,$3,NULL,NULL) value', [
    actor,
    paged.fromMs,
    paged.throughMs,
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 1048576);
  assert.equal(raw.rows.length, 64);
  assert.equal(raw.hasMore, true);
  results.push({
    case: '65 real accepted source snapshots traverse two revision-bound pages; one queue request and 65 admitted journal batches remain independent',
    pages: [64, 1],
    observations: 0,
    sourceCoverage: 'not_established',
    passed: true,
  });

  // Changes on another connection are visible on a later page and must force
  // a fresh traversal. Per-page statement snapshots do not freeze the world.
  await otherConnection.query('BEGIN');
  await otherConnection.query(
    "UPDATE horse_observation_capture_work SET admitted_at=admitted_at+interval '1 microsecond' WHERE request_key=$1",
    [key]
  );
  assert.equal((await read(paged, a.nextCursor)).status, 'snapshot');
  await otherConnection.query('COMMIT');
  assert.equal((await read(paged, a.nextCursor)).reason, 'request_changed');
  const anew = await read(paged);
  assert.equal(anew.status, 'snapshot');
  await c.query('BEGIN');
  await c.query(
    'DELETE FROM horse_observation_capture_receipts WHERE request_key=$1 AND from_ms=$2',
    [key, anew.nextCursor.afterFromMs]
  );
  assert.equal((await read(paged, anew.nextCursor)).reason, 'cursor_lost');
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query(
    'DELETE FROM horse_observation_capture_receipts WHERE request_key=$1 AND from_ms=$2',
    [key, paged.fromMs + 10]
  );
  assert.equal((await read(paged)).reason, 'evidence_gap');
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query(
    'DELETE FROM horse_observation_capture_receipts WHERE request_key=$1 AND from_ms=$2',
    [key, paged.throughMs - 1]
  );
  assert.equal((await read(paged, anew.nextCursor)).reason, 'evidence_gap');
  await c.query('ROLLBACK');
  results.push({
    case: 'later-page committed revision drift, retired cursor, interior gap and missing final slice all refuse without silent truncation',
    passed: true,
  });

  await c.query('BEGIN');
  await c.query(
    'UPDATE horse_observation_capture_receipts SET source_witness=NULL,source_witness_digest=NULL WHERE request_key=$1 AND from_ms=$2',
    [key, paged.fromMs]
  );
  const legacy = await read(paged);
  assert.equal(legacy.status, 'snapshot');
  assert.equal(legacy.rows[0].source, null);
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query(
    "UPDATE horse_observation_capture_work SET state='admitted',segments=0,captured_observations=0,cursor_ms=NULL,slice_through_ms=NULL,batch_key=$2,batch_digest=$3,observations=$4 WHERE request_key=$1",
    [key, b.rows[0].batchKey, b.rows[0].batchDigest, b.rows[0].observations]
  );
  assert.equal((await read(paged)).reason, 'legacy_request_without_slices');
  await c.query('ROLLBACK');
  const emptyRequest = { ...paged, fromMs: paged.fromMs - 2, throughMs: paged.fromMs - 1 };
  assert.equal((await read(emptyRequest)).reason, 'request_not_found');
  await capture.admitObservationCapture(emptyRequest);
  const empty = await read(emptyRequest);
  assert.equal(empty.status, 'snapshot');
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.sourceCoverage, 'not_established');
  assert.equal((await read({ ...paged, actorId: randomUUID() })).reason, 'request_not_found');
  results.push({
    case: 'legacy missing witnesses remain null, pre-slice receipts stay unsupported, unfinished empty requests and another actor remain isolated',
    passed: true,
  });

  const fn = 'fn_horse_observation_capture_evidence(uuid,bigint,bigint,bigint,text)';
  const metadata = (
    await c.query(
      'SELECT provolatile,prosecdef,proconfig,md5(prosrc) digest FROM pg_proc WHERE oid=$1::regprocedure',
      [fn]
    )
  ).rows[0];
  assert.equal(metadata.provolatile, 's');
  assert.equal(metadata.prosecdef, true);
  assert.ok(metadata.proconfig.includes('search_path=pg_catalog, public, pg_temp'));
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    for (const table of ['horse_observation_capture_work', 'horse_observation_capture_receipts'])
      await assert.rejects(c.query('SELECT * FROM ' + table + ' LIMIT 1'), /permission denied/);
    if (role === 'service_role') assert.equal((await read(paged)).status, 'snapshot');
    else
      await assert.rejects(
        c.query('SELECT fn_horse_observation_capture_evidence($1,$2,$3,NULL,NULL)', [
          actor,
          paged.fromMs,
          paged.throughMs,
        ]),
        /permission denied/
      );
    await c.query('RESET ROLE');
  }
  const invalids = [
    [null, paged.fromMs, paged.throughMs, null, null],
    [actor, -1, paged.throughMs, null, null],
    [actor, paged.fromMs, paged.fromMs, null, null],
    [actor, paged.fromMs, paged.throughMs, paged.fromMs, null],
    [actor, paged.fromMs, paged.throughMs, null, 'f'.repeat(64)],
    [actor, paged.fromMs, paged.throughMs, paged.fromMs, 'bad'],
  ];
  for (const p of invalids)
    assert.equal(
      (await sql('SELECT fn_horse_observation_capture_evidence($1,$2,$3,$4,$5) value', p)).reason,
      'invalid_request'
    );
  results.push({
    case: 'stable service-only reader, private tables, invalid cursor pairs and bounded input contract verified against PostgreSQL',
    invalidRequests: invalids.length,
    functionDigest: metadata.digest,
    passed: true,
  });
  return results;
}
