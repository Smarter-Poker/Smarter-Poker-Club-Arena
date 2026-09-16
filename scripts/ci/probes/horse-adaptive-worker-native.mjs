import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

/** Real compiled worker and real Supabase HTTP client against a private local
 * PostgreSQL fixture. No worker module or production transport is patched. */
export async function exerciseIsolatedWorker({ root, Client, options, c, work, snapshot }) {
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
      } else if (name === 'fn_prune_horse_adaptive_journal') {
        sql = 'SELECT fn_prune_horse_adaptive_journal() value';
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
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw Error('native worker deadline: ' + JSON.stringify(owner.status()));
      await wait(20);
    }
  };
  let tickCount = 0;
  const timer = setInterval(() => tickCount++, 10);
  try {
    await c.query('TRUNCATE horse_adaptive_journal_work');
    const queued = await work.enqueueAdaptiveJournalWork(snapshot);
    assert.equal(queued.status, 'durable');
    owner.start();
    await until(
      () => owner.status().completed === 1 && owner.status().queueHealth.status === 'snapshot'
    );
    const first = owner.status();
    assert.equal(first.queueHealth.unfinished, 0);
    assert.equal(first.phase, 'ready');
    assert.ok(tickCount > 0);
    assert.deepEqual(calls.slice(0, 5), [
      'fn_claim_horse_adaptive_batch',
      'fn_append_horse_adaptive_observations',
      'fn_finish_horse_adaptive_batch',
      'fn_prune_horse_adaptive_journal',
      'fn_horse_adaptive_journal_work_health',
    ]);
    assert.equal(
      (
        await c.query('SELECT state FROM horse_adaptive_journal_work WHERE batch_key=$1', [
          queued.batchKey,
        ])
      ).rows[0].state,
      'completed'
    );
    // Kill the actual isolated runtime, then let the bounded owner recover it.
    await children[0].terminate();
    await until(() => children.length === 2 && owner.status().phase === 'ready');
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
