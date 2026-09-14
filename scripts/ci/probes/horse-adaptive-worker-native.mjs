import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

/** Real compiled worker and real Supabase HTTP client against a private local
 * PostgreSQL fixture. No worker module or production transport is patched. */
export async function exerciseIsolatedWorker({
  root,
  Client,
  options,
  c,
  work,
  snapshot,
  capture,
  actor,
  sliced = false,
  witnessed = false,
  backlog = 0,
  discoveryMode = false,
}) {
  const connection = new Client(options);
  await connection.connect();
  await connection.query('SET ROLE service_role');
  const calls = [];
  let rejectClaims = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.headers.apikey !== 'isolated-fixture-key')
        throw Error('bad request');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16780000) throw Error('budget');
      }
      const args = JSON.parse(body || '{}');
      const name = req.url.split('/').at(-1);
      let sql, params;
      if (name === 'fn_claim_horse_adaptive_batch') {
        if (rejectClaims) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'fixture_unavailable', message: 'fixture unavailable' }));
          return;
        }
        sql = 'SELECT fn_claim_horse_adaptive_batch($1) value';
        params = [args.p_lease_token];
      } else if (name === 'fn_append_horse_adaptive_observations') {
        sql = 'SELECT fn_append_horse_adaptive_observations($1) value';
        params = [args.p_batch];
      } else if (name === 'fn_finish_horse_adaptive_batch') {
        sql = 'SELECT fn_finish_horse_adaptive_batch($1,$2,$3) value';
        params = [args.p_batch_key, args.p_lease_token, args.p_outcome];
      } else if (name === 'fn_horse_adaptive_journal_work_health') {
        sql = 'SELECT fn_horse_adaptive_journal_work_health() value';
        params = [];
      } else if (name === 'fn_horse_learning_work_health') {
        sql = 'SELECT fn_horse_learning_work_health() value';
        params = [];
      } else if (name === 'fn_prune_horse_adaptive_journal') {
        sql = 'SELECT fn_prune_horse_adaptive_journal() value';
        params = [];
      } else if (name === 'fn_claim_horse_observation_capture') {
        sql = 'SELECT fn_claim_horse_observation_capture($1) value';
        params = [args.p_lease_token];
      } else if (name === 'fn_horse_committed_observation_snapshot') {
        sql = 'SELECT fn_horse_committed_observation_snapshot($1,$2,$3) value';
        params = [args.p_actor, args.p_from_ms, args.p_through_ms];
      } else if (name === 'fn_finish_horse_observation_capture') {
        sql = 'SELECT fn_finish_horse_observation_capture($1,$2,$3,$4) value';
        params = [args.p_request_key, args.p_lease_token, args.p_payload, args.p_reason];
      } else if (name === 'fn_finish_horse_observation_capture_witness') {
        sql = 'SELECT fn_finish_horse_observation_capture_witness($1,$2,$3,$4,$5) value';
        params = [
          args.p_request_key,
          args.p_lease_token,
          args.p_payload,
          args.p_reason,
          args.p_source_witness,
        ];
      } else if (name === 'fn_prune_horse_observation_captures') {
        sql = 'SELECT fn_prune_horse_observation_captures() value';
        params = [];
      } else if (
        name === 'fn_discover_horse_observation_requests' ||
        name === 'fn_prune_horse_observation_discovery'
      ) {
        sql = 'SELECT ' + name + '() value';
        params = [];
      } else throw Error('unexpected RPC');
      calls.push(name);
      const result = (await connection.query(sql, params)).rows[0].value;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'fixture_failed', message: 'fixture failed' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const { HorseAdaptiveJournalWorker } = await import(
    pathToFileURL(root + '/server/dist/services/HorseAdaptiveJournalWorker.js')
  );
  const children = [];
  const owner = new HorseAdaptiveJournalWorker(() => {
    const child = new Worker(
      pathToFileURL(root + '/server/dist/services/horseAdaptiveJournal/worker.js'),
      {
        env: {
          SUPABASE_URL: 'http://127.0.0.1:' + address.port,
          SUPABASE_SERVICE_ROLE_KEY: 'isolated-fixture-key',
          NODE_ENV: 'test',
        },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        execArgv: [],
      }
    );
    children.push(child);
    return child;
  });
  const until = async (predicate) => {
    const deadline = Date.now() + (discoveryMode ? 45000 : sliced || backlog ? 30000 : 15000);
    while (!predicate()) {
      if (Date.now() > deadline)
        throw Error('native worker deadline: ' + JSON.stringify(owner.status()));
      await wait(20);
    }
  };
  let tickCount = 0;
  let pendingAtFirstCapture = null;
  const timer = setInterval(() => tickCount++, 10);
  try {
    await c.query('TRUNCATE horse_adaptive_journal_work');
    const hasSlices = (
      await c.query("SELECT to_regclass('public.horse_observation_capture_receipts') present")
    ).rows[0].present;
    await c.query(
      hasSlices
        ? 'TRUNCATE horse_observation_capture_receipts,horse_observation_capture_work'
        : 'TRUNCATE horse_observation_capture_work'
    );
    if (discoveryMode) {
      await c.query(
        'TRUNCATE horse_observation_discovery_members,horse_observation_discovery_segments,horse_observation_discovery_epochs'
      );
      const from = snapshot.source.fromMs + 101,
        through = snapshot.source.throughMs;
      const key = createHash('sha256')
        .update(['horse-discovery-v1', from, through].join('|'))
        .digest('hex');
      await c.query(
        'INSERT INTO horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms) VALUES($1,$2,$3,$2,$3)',
        [key, from, through]
      );
      owner.start();
      await until(() => owner.status().lastDiscovery.status === 'source_recorded');
      const before = (
        await c.query('SELECT * FROM horse_observation_discovery_segments WHERE epoch_key=$1', [
          key,
        ])
      ).rows[0];
      assert.equal(before.source_actors, 2);
      assert.equal(before.admitted_actors, 0);
      await children[0].terminate();
      await until(() => children.length === 2 && owner.status().phase === 'ready');
      await until(
        () =>
          owner.status().lastDiscovery.status === 'discovered' &&
          owner.status().capturesAdmitted === 2 &&
          owner.status().completed === 2
      );
      const after = (
        await c.query('SELECT * FROM horse_observation_discovery_segments WHERE epoch_key=$1', [
          key,
        ])
      ).rows[0];
      for (const field of [
        'source_digest',
        'snapshot_id',
        'read_at_ms',
        'novel_actors',
        'actor_digest',
      ])
        assert.deepEqual(after[field], before[field]);
      assert.equal(after.admitted_actors, 2);
      const requests = (
        await c.query('SELECT from_ms,through_ms,observations FROM horse_observation_capture_work')
      ).rows;
      assert.equal(requests.length, 2);
      for (const r of requests) {
        assert.equal(Number(r.from_ms), from);
        assert.equal(Number(r.through_ms), through);
        assert.equal(r.observations, 12);
      }
      assert.ok(calls.includes('fn_discover_horse_observation_requests'));
      assert.ok(calls.includes('fn_finish_horse_observation_capture_witness'));
      assert.equal(owner.status().lastDiscovery.sourceCoverage, 'not_established');
      await owner.stop();
      const stoppedCalls = calls.length;
      await wait(50);
      assert.equal(calls.length, stoppedCalls);
      assert.ok(children.every((x) => x.threadId === -1));
      return {
        case: 'actual isolated worker discovers two actors from completed controller hands, restarts after freezing the roster, captures24 public observations and finishes both journal batches',
        passed: true,
        actors: 2,
        observations: 24,
        completed: 2,
        restarts: owner.status().restarts,
        sourceCoverage: 'not_established',
        parentTimerTicks: tickCount,
        childCount: children.length,
        childrenStopped: true,
        productionPostgrestVerified: false,
      };
    }
    const acquisition = await capture.admitObservationCapture({
      actorId: actor,
      fromMs: snapshot.source.fromMs + 99,
      throughMs: snapshot.source.throughMs,
    });
    assert.equal(acquisition.status, 'durable');
    const lostToken = randomUUID();
    await c.query('SELECT fn_claim_horse_observation_capture($1)', [lostToken]);
    if (sliced) {
      const refined = (
        await c.query(
          "SELECT fn_finish_horse_observation_capture($1,$2,NULL,'source_budget_exceeded') value",
          [acquisition.requestKey, lostToken]
        )
      ).rows[0].value;
      assert.equal(refined.status, 'refined');
    }
    await c.query(
      "UPDATE horse_observation_capture_work SET lease_until=clock_timestamp()-interval '1 second'"
    );
    const queued = await work.enqueueAdaptiveJournalWork(snapshot);
    assert.equal(queued.status, 'durable');
    // Distinct batch identities deliberately replay the same immutable public
    // facts. This tests queue pressure, not extra hands or learning samples.
    for (let i = 0; i < backlog; i++) {
      const extra = await work.enqueueAdaptiveJournalWork({
        ...snapshot,
        source: {
          ...snapshot.source,
          sourceDigest: createHash('sha256')
            .update(snapshot.source.sourceDigest + ':backlog:' + i)
            .digest('hex'),
        },
      });
      assert.equal(extra.status, 'durable');
    }
    owner.start();
    await until(
      () => owner.status().completed === 1 && owner.status().queueHealth.status === 'snapshot'
    );
    const first = owner.status();
    assert.equal(first.queueHealth.unfinished, backlog);
    assert.equal(first.phase, 'ready');
    assert.equal(first.captureQueueHealth.status, 'snapshot');
    assert.ok(tickCount > 0);
    assert.deepEqual(calls.slice(0, 5), [
      'fn_claim_horse_adaptive_batch',
      'fn_append_horse_adaptive_observations',
      'fn_finish_horse_adaptive_batch',
      'fn_prune_horse_adaptive_journal',
      'fn_horse_learning_work_health',
    ]);
    assert.equal(
      (
        await c.query('SELECT state FROM horse_adaptive_journal_work WHERE batch_key=$1', [
          queued.batchKey,
        ])
      ).rows[0].state,
      'completed'
    );
    if (sliced) {
      await until(() => owner.status().captureSlicesContinued === 1);
      const partial = (
        await c.query(
          'SELECT state,segments FROM horse_observation_capture_work WHERE request_key=$1',
          [acquisition.requestKey]
        )
      ).rows[0];
      assert.equal(partial.state, 'queued');
      assert.equal(partial.segments, 1);
      if (backlog) {
        pendingAtFirstCapture = Number(
          (
            await c.query(
              "SELECT count(*) n FROM horse_adaptive_journal_work WHERE state<>'completed'"
            )
          ).rows[0].n
        );
        assert.ok(pendingAtFirstCapture > 0, 'acquisition starved until the journal drained');
        assert.ok(owner.status().completed <= 8, 'acquisition exceeded its journal-turn budget');
      }
      await children[0].terminate();
      await until(() => children.length === 2 && owner.status().phase === 'ready');
    }
    await until(() =>
      sliced
        ? owner.status().capturesRecovered === 1 && owner.status().completed === 3 + backlog
        : owner.status().capturesAdmitted === 1 && owner.status().completed === 2 + backlog
    );
    const acquired = (
      await c.query('SELECT * FROM horse_observation_capture_work WHERE request_key=$1', [
        acquisition.requestKey,
      ])
    ).rows[0];
    assert.equal(acquired.state, sliced ? 'captured' : 'admitted');
    assert.notEqual(acquired.lease_token, lostToken);
    assert.equal(Number(sliced ? acquired.captured_observations : acquired.observations), 12);
    if (sliced) assert.equal(owner.status().captureSlicesContinued, 1);
    if (witnessed) {
      const receipts = (
        await c.query(
          'SELECT source_witness,source_witness_digest,acknowledgment FROM horse_observation_capture_receipts WHERE request_key=$1',
          [acquisition.requestKey]
        )
      ).rows;
      assert.equal(receipts.length, 2);
      for (const r of receipts) {
        assert.ok(r.source_witness && r.source_witness_digest);
        assert.equal(r.acknowledgment.sourceWitnessDigest, r.source_witness_digest);
        const w = JSON.parse(r.source_witness);
        assert.equal(w.length, 11);
        assert.equal(w[0], 1);
        assert.equal(w[9], 'retained_committed_roster_rows');
      }
      assert.equal(
        calls.filter((n) => n === 'fn_finish_horse_observation_capture_witness').length,
        2
      );
    }
    assert.ok(calls.includes('fn_horse_committed_observation_snapshot'));
    // Kill the actual isolated runtime, then let the bounded owner recover it.
    if (!sliced) {
      await children[0].terminate();
      await until(() => children.length === 2 && owner.status().phase === 'ready');
    }
    assert.equal(owner.status().restarts, 1);
    await owner.stop();
    assert.equal(owner.status().phase, 'stopped');
    const stoppedCalls = calls.length;
    await wait(50);
    assert.equal(calls.length, stoppedCalls);
    assert.ok(children.every((x) => x.threadId === -1));
    return {
      case: 'real isolated worker via unchanged Supabase HTTP client processes durable work and retention, survives actual thread termination, and stops with no later RPC',
      passed: true,
      completed: owner.status().completed,
      capturesAdmitted: owner.status().capturesAdmitted,
      capturesRecovered: owner.status().capturesRecovered,
      captureSlicesContinued: owner.status().captureSlicesContinued,
      sliced,
      initialBacklog: backlog,
      pendingAtFirstCapture,
      sourceWitnessesRecorded: witnessed,
      restartedBetweenSlices: sliced,
      durableRequestResumedWithoutSourcePayload: true,
      restarts: owner.status().restarts,
      parentTimerTicks: tickCount,
      productionPostgrestVerified: false,
      childCount: children.length,
      childrenStopped: true,
    };
  } finally {
    clearInterval(timer);
    await owner.stop();
    await Promise.all(children.map((x) => x.terminate()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await connection.end();
  }
}
