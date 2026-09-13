import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const { Client } = createRequire(root + '/server/package.json')('pg');
const pg = process.env.HORSE_PROOF_PG_BIN,
  output = process.argv[2];
if (!pg || !output) throw Error('Existing HORSE_PROOF_PG_BIN and new output path required');
const dir = mkdtempSync('/tmp/horse-journal-native-'),
  data = dir + '/data',
  socket = dir + '/socket';
mkdirSync(socket, { mode: 0o700 });
let running = false,
  c,
  otherConnection,
  proof;
const results = [],
  oldNow = Date.now;
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n) => 'cccccccc-cccc-4ccc-8ccc-' + String(n).padStart(12, '0');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const runtime = async (name) => import(pathToFileURL(root + '/server/dist/' + name + '.js'));
try {
  execFileSync(
    pg + '/initdb',
    ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'],
    { stdio: 'pipe' }
  );
  execFileSync(
    pg + '/pg_ctl',
    [
      '-D',
      data,
      '-l',
      dir + '/postgres.log',
      '-o',
      '-k ' +
        socket +
        " -p 55439 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
      '-w',
      'start',
    ],
    { stdio: 'pipe' }
  );
  running = true;
  const options = {
    host: socket,
    port: 55439,
    user: 'postgres',
    database: 'postgres',
    statement_timeout: 5000,
  };
  c = new Client(options);
  otherConnection = new Client(options);
  await c.connect();
  await otherConnection.connect();
  await c.query(
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE hand_history(id uuid PRIMARY KEY,created_at timestamptz NOT NULL,players jsonb,actions jsonb); CREATE INDEX roster ON hand_history USING gin(players jsonb_path_ops); GRANT SELECT ON hand_history TO service_role;'
  );
  for (const migration of [
    '20260912193321_horse_committed_observation_snapshot.sql',
    '20260913170729_horse_adaptive_observation_journal.sql',
    '20260913175935_recoverable_horse_adaptive_journal_batches.sql',
  ])
    await c.query(readFileSync(root + '/supabase/migrations/' + migration, 'utf8'));
  const now = Number(
    (await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint n')).rows[0].n
  );
  const from = now - 3_600_000,
    through = now - 1000;
  const { HandController } = await runtime('engine/HandController');
  const { captureHandSeatGenerations } = await runtime('engine/handSeatGeneration');
  const { bindHorseObservationIdentity } = await runtime('engine/HorseObservationIdentity');
  Date.now = () => now - 2000;
  for (let n = 1; n <= 3; n++) {
    const tableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      actions = [];
    const seats = [actor, other].map((user_id, i) => ({
      seat: i + 1,
      user_id,
      username: 'private',
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    }));
    const generations = captureHandSeatGenerations(
      [actor, other].map((user_id) => ({
        user_id,
        seat_id: user_id,
        seat_joined_at: new Date(from).toISOString(),
      }))
    );
    const hc = new HandController(
      {
        tableId,
        handNumber: n,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      },
      seats,
      1
    );
    let complete = false;
    hc.onEvent((e) => {
      if (e.type === 'HAND_COMPLETE') complete = true;
      if (e.type === 'FORCED_BETS_POSTED')
        for (const p of e.postings)
          actions.push({
            userId: p.userId,
            action: p.kind,
            stage: 'preflop',
            timestamp: Date.now(),
          });
      if (e.type === 'PLAYER_ACTION' && e.record) {
        const a = { ...e.record, publicNode: e.publicNode, origin: e.origin };
        actions.push({
          ...a,
          observationIdentity: bindHorseObservationIdentity(a, actions.length, {
            handId: id(n),
            tableId,
            seatGenerations: generations,
          }),
        });
      }
    });
    hc.start();
    for (let step = 0; step < 50 && !complete; step++) {
      const state = hc.getState();
      if (['showdown', 'complete'].includes(state.stage)) break;
      const p = state.players.find((p) => p.seat === state.currentPlayerSeat);
      const rights = hc.getAuthoritativeActionState(p.user_id);
      assert.equal(
        hc.performAction(
          p.seat,
          rights.legalActions.includes('check') ? 'check' : 'call',
          undefined,
          'player'
        ),
        true
      );
    }
    assert.equal(complete, true);
    await c.query(
      'INSERT INTO hand_history VALUES($1,to_timestamp($2::double precision/1000),$3::jsonb,$4::jsonb)',
      [
        id(n),
        now - 1500,
        JSON.stringify([{ userId: actor }, { userId: other }]),
        JSON.stringify(actions),
      ]
    );
  }
  Date.now = oldNow;
  const calls = [];
  let loseReply = false;
  globalThis.horseJournalNative = {
    supabase: {
      rpc(name, p) {
        calls.push(name);
        return {
          async abortSignal(signal) {
            assert.ok(signal instanceof AbortSignal);
            try {
              let query, params;
              if (name === 'fn_horse_committed_observation_snapshot') {
                query = 'SELECT public.fn_horse_committed_observation_snapshot($1,$2,$3) value';
                params = [p.p_actor, p.p_from_ms, p.p_through_ms];
              } else if (name === 'fn_append_horse_adaptive_observations') {
                query = 'SELECT public.fn_append_horse_adaptive_observations($1) value';
                params = [p.p_batch];
              } else if (name === 'fn_horse_adaptive_journal_batch') {
                query = 'SELECT public.fn_horse_adaptive_journal_batch($1) value';
                params = [p.p_batch_key];
              } else if (name === 'fn_horse_adaptive_journal_snapshot') {
                query = 'SELECT public.fn_horse_adaptive_journal_snapshot($1,$2,$3,$4,$5,$6) value';
                params = [
                  p.p_actor_key,
                  p.p_scope_key,
                  p.p_partition,
                  p.p_cohort,
                  p.p_from_ms,
                  p.p_to_ms,
                ];
              } else throw Error('Unexpected RPC');
              const result = await c.query(query, params);
              if (loseReply && name === 'fn_append_horse_adaptive_observations') {
                loseReply = false;
                throw Error('simulated lost committed reply');
              }
              return { data: result.rows[0].value, error: null };
            } catch (error) {
              return { data: null, error };
            }
          },
        };
      },
    },
  };
  const bridge = async (relative) => {
    const path = root + '/server/dist/services/' + relative + '.js';
    const module = readFileSync(path, 'utf8')
      .replace(
        /import \{ supabase \} from '\.\/supabase\.js';/,
        'const {supabase}=globalThis.horseJournalNative;'
      )
      .replace(/from '([^']+)'/g, (whole, path) =>
        path.startsWith('.')
          ? "from '" +
            new URL(path, pathToFileURL(root + '/server/dist/services/' + relative + '.js')).href +
            "'"
          : whole
      );
    return import('data:text/javascript;base64,' + Buffer.from(module).toString('base64'));
  };
  const { readCommittedObservationSnapshot: readSource } = await bridge(
    'HorseCommittedObservationSnapshot'
  );
  const {
    prepareAdaptiveJournalBatch: prepare,
    persistAdaptiveJournalSnapshot: persist,
    readAdaptiveJournalSnapshot: read,
    readAdaptiveJournalBatch: recover,
    persistPreparedAdaptiveJournalBatch: retry,
  } = await bridge('HorseAdaptiveObservationJournal');
  await c.query('SET ROLE service_role');
  const source = await readSource({ actorId: actor, fromMs: from, throughMs: through });
  assert.equal(source.status, 'snapshot');
  assert.equal(source.observations.length, 12);
  const batch = prepare(source);
  assert.equal(batch.status, 'prepared');
  const first = await persist(source);
  assert.equal(first.status, 'recorded');
  assert.deepEqual(await persist(source), first);
  assert.deepEqual(await recover(batch.batchKey), batch);
  assert.deepEqual(await retry(await recover(batch.batchKey)), first);
  await c.query('RESET ROLE');
  const count = async () =>
    Number((await c.query('SELECT count(*) n FROM horse_adaptive_observation_journal')).rows[0].n);
  assert.equal(await count(), 12);
  results.push({
    case: 'actual completed controller through committed reader, qualifier and durable journal',
    hands: 3,
    observations: 12,
    replayIdentical: true,
  });
  const o = source.observations[0];
  const request = {
    actorKey: o.actorKey,
    scopeKey: o.scopeKey,
    partition: o.partition,
    cohort: 'human',
    fromMs: from,
    toMs: through,
  };
  const expected = source.observations.filter(
    (q) => q.scopeKey === o.scopeKey && q.partition === o.partition
  );
  await c.query('SET ROLE service_role');
  const population = await read(request);
  assert.equal(population.status, 'snapshot');
  assert.deepEqual(population.observations, expected);
  assert.equal(population.complete, undefined);
  assert.equal((await read({ ...request, actorKey: '0'.repeat(64) })).observations.length, 0);
  assert.equal(
    (await read({ ...request, partition: o.partition === 'training' ? 'holdout' : 'training' }))
      .observations.length,
    0
  );
  assert.equal((await read({ ...request, cohort: 'horse_policy' })).observations.length, 0);
  assert.equal((await read({ ...request, scopeKey: '0'.repeat(64) })).observations.length, 0);
  await c.query('RESET ROLE');
  results.push({
    case: 'actor, node, holdout and policy isolation',
    observations: expected.length,
    completeModelWindowNotInvented: true,
  });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query('SET ROLE ' + role);
    for (const table of [
      'horse_adaptive_observation_journal',
      'horse_adaptive_observation_batches',
    ])
      for (const sql of [
        'SELECT * FROM ' + table,
        'DELETE FROM ' + table,
        'UPDATE ' + table + ' SET actor_key=actor_key',
      ])
        await assert.rejects(c.query(sql), (e) => e.code === '42501');
    if (role !== 'service_role')
      await assert.rejects(
        c.query('SELECT fn_append_horse_adaptive_observations($1)', [batch.payload]),
        (e) => e.code === '42501'
      );
    if (role !== 'service_role')
      await assert.rejects(
        c.query('SELECT fn_horse_adaptive_journal_batch($1)', [batch.batchKey]),
        (e) => e.code === '42501'
      );
    await c.query('RESET ROLE');
  }
  results.push({
    case: 'service-only function entry and no direct journal reads or rewrites',
    passed: true,
  });
  const fresh = {
    ...source,
    source: { ...source.source, sourceDigest: hash('new lost-reply batch') },
  };
  await c.query('SET ROLE service_role');
  loseReply = true;
  assert.equal((await persist(fresh)).status, 'unknown');
  assert.equal((await persist(fresh)).status, 'recorded');
  await c.query('RESET ROLE');
  assert.equal(await count(), 12);
  results.push({ case: 'committed lost reply replays without duplicate facts', passed: true });
  const changed = {
    ...source,
    observations: [{ ...o, action: o.action === 'call' ? 'raise' : 'call' }],
  };
  assert.equal((await persist(changed)).status, 'rejected');
  const added = {
    ...o,
    handId: '00000000-0000-4000-8000-000000000001',
    observationId: '00000000-0000-4000-8000-000000000001:0',
  };
  const conflict = {
    ...changed,
    source: { ...source.source, sourceDigest: hash('overlap conflict') },
    observations: [added, ...changed.observations],
  };
  assert.equal((await persist(conflict)).status, 'rejected');
  assert.equal(await count(), 12);
  results.push({
    case: 'same-batch and cross-batch conflicts roll back earlier insertions',
    passed: true,
  });
  const concurrent = {
    ...source,
    source: { ...source.source, sourceDigest: hash('concurrent exact') },
    observations: [added],
  };
  const cb = prepare(concurrent);
  assert.equal(cb.status, 'prepared');
  await c.query('BEGIN');
  const held = (
    await c.query('SELECT fn_append_horse_adaptive_observations($1) value', [cb.payload])
  ).rows[0].value;
  assert.equal(
    (await otherConnection.query('SELECT fn_horse_adaptive_journal_batch($1) value', [cb.batchKey]))
      .rows[0].value.reason,
    'batch_not_found'
  );
  let done = false;
  const competing = otherConnection
    .query('SELECT fn_append_horse_adaptive_observations($1) value', [cb.payload])
    .then((r) => {
      done = true;
      return r;
    });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(done, false);
  await c.query('COMMIT');
  assert.deepEqual((await competing).rows[0].value, held);
  assert.equal(await count(), 13);
  results.push({
    case: 'concurrent identical ingestion serializes to the same receipt',
    passed: true,
  });
  const reconnectEvidence = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {createRequire} from 'node:module';const {Client}=createRequire(${JSON.stringify(root + '/server/package.json')})('pg');const c=new Client(${JSON.stringify(options)});await c.connect();const r=await c.query('SELECT count(*)::integer n FROM horse_adaptive_observation_journal');console.log(JSON.stringify(r.rows[0]));await c.end();`,
      ],
      { encoding: 'utf8' }
    )
  );
  assert.equal(reconnectEvidence.n, 13);
  results.push({ case: 'fresh Node process sees all immutable identities', observations: 13 });
  // The next process receives only a durable batch key. Even the synthetic
  // source history has gone; re-querying it cannot reproduce the submitted batch.
  await c.query('DELETE FROM hand_history WHERE id=ANY($1::uuid[])', [[id(1), id(2), id(3)]]);
  const recoveredAfterRestart = JSON.parse(
    execFileSync(
      process.execPath,
      [
        root + '/scripts/ci/probes/horse-adaptive-batch-restart-child.mjs',
        JSON.stringify({ root, options, batchKey: batch.batchKey }),
      ],
      { encoding: 'utf8' }
    )
  );
  assert.equal(recoveredAfterRestart.batchDigest, batch.batchDigest);
  assert.equal(recoveredAfterRestart.observations, 12);
  assert.equal(recoveredAfterRestart.status, 'recorded');
  assert.deepEqual(recoveredAfterRestart.calls, [
    'fn_horse_adaptive_journal_batch',
    'fn_append_horse_adaptive_observations',
  ]);
  assert.equal(await count(), 13);
  results.push({
    case: 'new process recovers exact public batch after source history is removed and replays it',
    sourceHistoryRows: 0,
    originalBatchObservations: 12,
    totalUniqueObservations: 13,
  });
  assert.equal((await recover('0'.repeat(64))).reason, 'batch_not_found');
  await c.query(
    'UPDATE horse_adaptive_observation_batches SET canonical_payload=NULL WHERE batch_key=$1',
    [cb.batchKey]
  );
  assert.equal((await recover(cb.batchKey)).reason, 'legacy_batch_payload_unavailable');
  assert.equal((await retry(cb)).status, 'recorded');
  assert.equal((await recover(cb.batchKey)).reason, 'legacy_batch_payload_unavailable');
  await c.query(
    'UPDATE horse_adaptive_observation_batches SET canonical_payload=$2 WHERE batch_key=$1',
    [cb.batchKey, '{}']
  );
  assert.equal((await recover(cb.batchKey)).reason, 'invalid_receipt');
  await c.query(
    'UPDATE horse_adaptive_observation_batches SET canonical_payload=$2 WHERE batch_key=$1',
    [cb.batchKey, cb.payload]
  );
  results.push({
    case: 'missing and legacy payloads stay unavailable; substituted stored bytes are refused',
    passed: true,
  });
  const append = async (payload) =>
    (await c.query('SELECT fn_append_horse_adaptive_observations($1) value', [payload])).rows[0]
      .value;
  for (const value of [null, 'null', '{}', '[]', JSON.stringify([...JSON.parse(batch.payload), 0])])
    await assert.rejects(append(value));
  const invalidBatches = [];
  for (const [index, value] of [
    [0, 2],
    [1, 'bad'],
    [2, 'bad'],
    [3, null],
    [4, 0],
    [5, 'bad'],
    [6, [['private cards', 1]]],
    [7, Array(20001).fill('[]')],
  ]) {
    const b = JSON.parse(batch.payload);
    b[index] = value;
    invalidBatches.push(JSON.stringify(b));
  }
  for (const value of invalidBatches) await assert.rejects(append(value));
  assert.equal(await count(), 13);
  results.push({
    case: 'native malformed, null, source identity and input count refusal',
    cases: 5 + invalidBatches.length,
  });
  const invalidObservationFields = [
    [0, 2],
    [1, null],
    [1, o.handId + ':4096'],
    [2, actor],
    [3, '0'.repeat(64)],
    [4, 'bad'],
    [5, null],
    [5, now + 60000],
    [5, now - 2592000001],
    [6, 'other'],
    [7, 'bad'],
    [8, '{}'],
    [8, '[]'],
    [9, 'private_action'],
    [10, null],
    [11, 'timeout'],
  ];
  for (const [index, value] of invalidObservationFields) {
    const b = JSON.parse(batch.payload),
      row = JSON.parse(b[7][0]);
    row[index] = value;
    b[7] = [JSON.stringify(row)];
    b[5] = hash('invalid-field-' + index + '-' + JSON.stringify(value));
    b[1] = hash(['adaptive-journal-v1', b[2], b[5], b[3], b[4]].join('|'));
    await assert.rejects(append(JSON.stringify(b)));
  }
  assert.equal(await count(), 13);
  results.push({
    case: 'native observation identity, actor, scope, time, action and origin refusal',
    cases: invalidObservationFields.length,
  });
  // The concurrent-ingestion case above added one more observation at this
  // exact time and scope; the boundary must retain that committed fact too.
  assert.equal(
    (await read({ ...request, fromMs: now - 2000, toMs: now - 1999 })).observations.length,
    expected.length + 1
  );
  assert.equal((await read({ ...request, toMs: now - 2000 })).observations.length, 0);
  assert.equal((await read({ ...request, fromMs: now - 1999 })).observations.length, 0);
  results.push({
    case: 'journal interval includes lower and excludes upper observation time',
    passed: true,
  });
  // A second transaction commits while the outer STABLE statement is waiting.
  // Its snapshot cannot gain the newly committed journal identity mid-read.
  const late = { ...o, handId: id(999), observationId: id(999) + ':0' };
  const lateBatch = prepare({
    ...source,
    source: { ...source.source, sourceDigest: hash('late commit') },
    observations: [late],
  });
  const rawRead = 'SELECT fn_horse_adaptive_journal_snapshot($1,$2,$3,$4,$5,$6) value';
  const params = [o.actorKey, o.scopeKey, o.partition, 'human', from, through];
  const before = (await c.query(rawRead, params)).rows[0].value.observations;
  await otherConnection.query('BEGIN');
  await otherConnection.query('SELECT fn_append_horse_adaptive_observations($1)', [
    lateBatch.payload,
  ]);
  const during = c.query(rawRead + ' FROM (SELECT pg_sleep(0.08)) wait_for_commit', params);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await otherConnection.query('COMMIT');
  assert.equal((await during).rows[0].value.observations, before);
  assert.equal((await c.query(rawRead, params)).rows[0].value.observations, before + 1);
  results.push({
    case: 'concurrent commit does not change an in-flight stable journal snapshot',
    before,
    during: before,
    after: before + 1,
  });
  // Synthetic owner inserts isolate database response ceilings; malformed
  // placeholder payloads never reach the application reader as evidence.
  await c.query('TRUNCATE horse_adaptive_observation_journal,horse_adaptive_observation_batches');
  await c.query(
    `INSERT INTO horse_adaptive_observation_journal
    (observation_id,hand_id,actor_key,session_key,observed_at_ms,partition,scope_key,origin,payload)
    SELECT 'budget-'||n,$1,$2,$3,$4,$5,$6,'player','[]' FROM generate_series(1,20001) n`,
    [o.handId, o.actorKey, o.sessionKey, o.observedAtMs, o.partition, o.scopeKey]
  );
  const overflow = (await c.query(rawRead, params)).rows[0].value;
  assert.equal(overflow.reason, 'observation_budget_exceeded');
  assert.deepEqual(overflow.rows, []);
  await c.query('TRUNCATE horse_adaptive_observation_journal');
  await c.query(
    `INSERT INTO horse_adaptive_observation_journal
    (observation_id,hand_id,actor_key,session_key,observed_at_ms,partition,scope_key,origin,payload)
    SELECT 'bytes-'||n,$1,$2,$3,$4,$5,$6,'player',repeat('x',16384) FROM generate_series(1,1025) n`,
    [o.handId, o.actorKey, o.sessionKey, o.observedAtMs, o.partition, o.scopeKey]
  );
  const oversized = (await c.query(rawRead, params)).rows[0].value;
  assert.equal(oversized.reason, 'byte_budget_exceeded');
  assert.deepEqual(oversized.rows, []);
  results.push({ case: 'native complete refusal at 20001 rows and over 16 MiB', passed: true });
  await c.query('TRUNCATE horse_adaptive_observation_journal,horse_adaptive_observation_batches');
  const bulk = {
    ...source,
    source: { ...source.source, sourceDigest: hash('bounded synthetic bulk') },
    observations: Array.from({ length: 2000 }, (_, ordinal) => ({
      ...o,
      handId: id(3000),
      observationId: id(3000) + ':' + ordinal,
    })),
  };
  const bulkPrepared = prepare(bulk);
  assert.equal(bulkPrepared.status, 'prepared');
  const start = performance.now();
  await c.query('SET ROLE service_role');
  assert.equal((await persist(bulk)).status, 'recorded');
  const writeMs = performance.now() - start;
  const readStart = performance.now();
  const bulkRead = await read(request);
  assert.equal(bulkRead.status, 'snapshot');
  assert.equal(bulkRead.observations.length, 2000);
  const readMs = performance.now() - readStart;
  const recoveryStart = performance.now();
  const recoveredBulk = await recover(bulkPrepared.batchKey);
  assert.deepEqual(recoveredBulk, bulkPrepared);
  const recoveryMs = performance.now() - recoveryStart;
  await c.query('RESET ROLE');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const rights = (
      await c.query(
        `SELECT
      has_table_privilege($1,'horse_adaptive_observation_journal','INSERT') AS insert_journal,
      has_table_privilege($1,'horse_adaptive_observation_batches','INSERT') AS insert_batch,
      has_function_privilege($1,'fn_horse_adaptive_journal_snapshot(text,text,text,text,bigint,bigint)','EXECUTE') AS read_rpc`,
        [role]
      )
    ).rows[0];
    assert.equal(rights.insert_journal, false);
    assert.equal(rights.insert_batch, false);
    assert.equal(rights.read_rpc, role === 'service_role');
  }
  results.push({
    case: 'bounded synthetic batch through actual writer and reader',
    observations: 2000,
    bytes: Buffer.byteLength(bulkPrepared.payload),
    writeMs,
    readMs,
    recoveryMs,
    limitation: 'One isolated sample; not a production latency certification.',
  });
  proof = { results, sourceCalls: calls, productionPostgrestVerified: false };
} finally {
  Date.now = oldNow;
  await Promise.allSettled([c?.end(), otherConnection?.end()]);
  if (running) {
    execFileSync(pg + '/pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    running = false;
  }
  rmSync(dir, { recursive: true, force: true });
  if (proof) {
    proof.cleanup = { stopped: !running, removed: true };
    writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(proof));
  }
}
// Imported controller dependencies own recurring timers. All fixture clients,
// the PostgreSQL process and its private data directory have been closed above.
process.exit(0);
