import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(root + '/server/package.json'),
  { Client } = require('pg');
const pg = process.env.HORSE_PROOF_PG_BIN;
if (!pg || !process.argv[2])
  throw Error('Set HORSE_PROOF_PG_BIN to an existing PostgreSQL bin and pass a new output path');
const migration = 'supabase/migrations/20260912193321_horse_committed_observation_snapshot.sql';
const dir = mkdtempSync('/tmp/horse-snapshot-native-'),
  data = dir + '/data',
  socket = dir + '/socket';
mkdirSync(socket, { mode: 0o700 });
let running = false,
  c,
  writer,
  proof;
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n) => 'cccccccc-cccc-4ccc-8ccc-' + String(n).padStart(12, '0');
const hash = (s) => createHash('sha256').update(s).digest('hex'),
  oldNow = Date.now;
const results = [];
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
        " -p 55438 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",
      '-w',
      'start',
    ],
    { stdio: 'pipe' }
  );
  running = true;
  const options = {
    host: socket,
    port: 55438,
    user: 'postgres',
    database: 'postgres',
    statement_timeout: 5000,
  };
  c = new Client(options);
  writer = new Client(options);
  await c.connect();
  await writer.connect();
  await c.query(
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE hand_history(id uuid PRIMARY KEY,created_at timestamptz NOT NULL,players jsonb,actions jsonb,hole_cards jsonb); CREATE INDEX roster ON hand_history USING gin(players jsonb_path_ops); GRANT SELECT ON hand_history TO service_role;'
  );
  await c.query(readFileSync(root + '/' + migration, 'utf8'));
  const fn = 'public.fn_horse_committed_observation_snapshot($1::uuid,$2::bigint,$3::bigint)';
  const now = Number(
    (await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint n')).rows[0].n
  );
  const from = now - 3_600_000,
    through = now - 1000,
    created = through - 1000;
  const params = [actor, from, through];
  const get = async () => (await c.query('SELECT ' + fn + ' AS value', params)).rows[0].value;
  const insert = async (n, actions = [], user = actor, client = c) =>
    client.query(
      'INSERT INTO hand_history VALUES($1,to_timestamp($2::double precision/1000),$3::jsonb,$4::jsonb,$5::jsonb)',
      [
        id(n),
        created,
        JSON.stringify([{ userId: user }]),
        JSON.stringify(actions),
        JSON.stringify(['As', 'Ah']),
      ]
    );
  await c.query('SET ROLE service_role');
  assert.equal((await get()).handCount, 0);
  await c.query('RESET ROLE');
  for (const role of ['anon', 'authenticated']) {
    await c.query('SET ROLE ' + role);
    await assert.rejects(get(), (e) => e.code === '42501');
    await c.query('RESET ROLE');
  }
  results.push({ case: 'service-only privileges', passed: true });
  for (const bad of [
    [null, from, through],
    [actor, null, through],
    [actor, from, null],
    [actor, now - 86_400_001, through],
    [actor, from, now + 60_000],
    [actor, from, from],
    [actor, through - 21_600_001, through],
  ]) {
    const value = (await c.query('SELECT ' + fn + ' value', bad)).rows[0].value;
    assert.equal(value.reason, 'invalid_window');
  }
  results.push({ case: 'database null, future, stale and oversized-window refusal', cases: 7 });
  const meta = (
    await c.query(
      "SELECT provolatile,prosecdef FROM pg_proc WHERE oid='public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure"
    )
  ).rows[0];
  assert.equal(meta.provolatile, 's');
  assert.equal(meta.prosecdef, false);
  for (let n = 0; n < 512; n++)
    await insert(n, [{ action: 'bb', cards: ['As'], secret: 'private' }]);
  await insert(9999, [], other);
  const ties = await get();
  assert.equal(ties.status, 'snapshot');
  assert.equal(ties.handCount, 512);
  assert.deepEqual(
    ties.hands.map((h) => h.id),
    Array.from({ length: 512 }, (_, n) => id(n))
  );
  assert.ok(!JSON.stringify(ties).includes('private'));
  assert.ok(!JSON.stringify(ties).includes('As'));
  await insert(512);
  const overflow = await get();
  assert.equal(overflow.reason, 'hand_budget_exceeded');
  assert.deepEqual(overflow.hands, []);
  results.push({
    case: 'timestamp ties and canonical roster isolation',
    rows: 512,
    overflow: 513,
    privateTopLevelFieldsRemoved: true,
  });
  await c.query('TRUNCATE hand_history');
  await insert(1);
  await c.query(
    "UPDATE hand_history SET created_at=to_timestamp($1::double precision/1000)+interval '1 microsecond' WHERE id=$2",
    [from, id(1)]
  );
  const edge = await get();
  assert.equal(edge.handCount, 1);
  assert.equal(edge.hands[0].createdAt.slice(23, 26), '001');
  await c.query(
    'UPDATE hand_history SET created_at=to_timestamp($1::double precision/1000) WHERE id=$2',
    [from, id(1)]
  );
  assert.equal((await get()).handCount, 0);
  results.push({ case: 'one microsecond above the exclusive lower bound', passed: true });
  await c.query('TRUNCATE hand_history');
  await insert(1, [{ action: 'bb', oversized: 'x'.repeat(1_048_577) }]);
  assert.equal((await get()).reason, 'invalid_or_oversized_hand');
  await c.query('TRUNCATE hand_history');
  for (let n = 0; n < 9; n++) await insert(n, [{ action: 'bb', payload: 'x'.repeat(1_000_000) }]);
  const bytes = await get();
  assert.equal(bytes.reason, 'byte_budget_exceeded');
  assert.deepEqual(bytes.hands, []);
  await c.query('TRUNCATE hand_history');
  await insert(1, null);
  assert.equal((await get()).reason, 'invalid_or_oversized_hand');
  results.push({ case: 'row, whole-response and malformed payload budgets', passed: true });
  await c.query('TRUNCATE hand_history');
  for (let n = 0; n < 5; n++)
    await insert(
      n,
      Array.from({ length: 4000 }, () => ({}))
    );
  const sparse = await get();
  assert.equal(sparse.status, 'snapshot');
  assert.equal(sparse.actionCount, 20000);
  assert.ok(sparse.hands.every((h) => h.actions.every((a) => Object.keys(a).length === 0)));
  assert.ok(
    Buffer.byteLength(JSON.stringify(sparse.hands.map((h) => h.actions))) <= sparse.sourceBytes + 20
  );
  await insert(6, [{}]);
  const actionsOverflow = await get();
  assert.equal(actionsOverflow.reason, 'action_budget_exceeded');
  assert.deepEqual(actionsOverflow.hands, []);
  results.push({
    case: 'sparse JSON does not expand and total action work is bounded',
    accepted: 20000,
    rejected: 20001,
  });
  await c.query('TRUNCATE hand_history');
  await insert(1);
  await writer.query('BEGIN');
  await insert(2, [], actor, writer);
  const before = await get();
  assert.equal(before.handCount, 1);
  const pending = c.query(
    'WITH gate AS MATERIALIZED (SELECT pg_sleep(0.4),$1::uuid actor) SELECT public.fn_horse_committed_observation_snapshot(g.actor,$2::bigint,$3::bigint) value FROM gate g',
    params
  );
  let sawSleep = false;
  for (let n = 0; n < 100; n++) {
    const state = (
      await writer.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [c.processID])
    ).rows[0];
    if (state?.wait_event === 'PgSleep') {
      sawSleep = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(sawSleep, true);
  await writer.query('COMMIT');
  const during = (await pending).rows[0].value,
    after = await get();
  assert.equal(during.handCount, 1);
  assert.equal(after.handCount, 2);
  results.push({ case: 'late commit during stable statement', before: 1, during: 1, nextRead: 2 });
  await c.query('TRUNCATE hand_history');
  const { HandController } = await import(
    pathToFileURL(root + '/server/dist/engine/HandController.js')
  );
  const { captureHandSeatGenerations } = await import(
    pathToFileURL(root + '/server/dist/engine/handSeatGeneration.js')
  );
  const { bindHorseObservationIdentity } = await import(
    pathToFileURL(root + '/server/dist/engine/HorseObservationIdentity.js')
  );
  const { qualifyAdaptiveHand } = await import(
    pathToFileURL(root + '/server/dist/engine/HorseAdaptiveObservation.js')
  );
  Date.now = () => created - 500;
  const expected = [];
  for (let n = 10; n < 13; n++) {
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
      const p = state.players.find((p) => p.seat === state.currentPlayerSeat),
        rights = hc.getAuthoritativeActionState(p.user_id);
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
    await insert(n, actions);
    const actorKey = hash(JSON.stringify(['adaptive-actor-v1', actor]));
    expected.push(
      ...qualifyAdaptiveHand({ committedHandId: id(n), actions }, now).observations.filter(
        (o) => o.actorKey === actorKey
      )
    );
  }
  Date.now = oldNow;
  const runtimePath = 'server/dist/services/HorseCommittedObservationSnapshot.js';
  let module = readFileSync(root + '/' + runtimePath, 'utf8')
    .replace(
      /import \{ supabase \} from '\.\/supabase\.js';/,
      'const {supabase}=globalThis.horseSnapshotNative;'
    )
    .replace(/from '([^']+)'/g, (whole, path) =>
      path.startsWith('.')
        ? "from '" + new URL(path, pathToFileURL(root + '/' + runtimePath)).href + "'"
        : whole
    );
  globalThis.horseSnapshotNative = {
    supabase: {
      rpc(name, p) {
        assert.equal(name, 'fn_horse_committed_observation_snapshot');
        return {
          async abortSignal(signal) {
            assert.ok(signal instanceof AbortSignal);
            try {
              const result = await c.query('SELECT ' + fn + ' value', [
                p.p_actor,
                p.p_from_ms,
                p.p_through_ms,
              ]);
              return { data: result.rows[0].value, error: null };
            } catch (error) {
              return { data: null, error };
            }
          },
        };
      },
    },
  };
  const { readCommittedObservationSnapshot } = await import(
    'data:text/javascript;base64,' + Buffer.from(module).toString('base64')
  );
  const first = await readCommittedObservationSnapshot({
    actorId: actor,
    fromMs: from,
    throughMs: through,
  });
  const second = await readCommittedObservationSnapshot({
    actorId: actor,
    fromMs: from,
    throughMs: through,
  });
  assert.equal(first.status, 'snapshot');
  assert.equal(second.status, 'snapshot');
  assert.deepEqual(first.observations, expected);
  assert.deepEqual(first.observations, second.observations);
  assert.equal(first.source.sourceDigest, second.source.sourceDigest);
  assert.ok(!JSON.stringify(first).includes('private'));
  assert.ok(!JSON.stringify(first).includes(actor));
  results.push({
    case: 'actual controller to committed RPC to actual qualifier reader',
    completeHands: 3,
    qualified: expected.length,
    retryDigest: first.source.sourceDigest,
    privateValuesExcluded: true,
  });
  const bindings = [
    migration,
    'server/src/services/HorseCommittedObservationSnapshot.ts',
    runtimePath,
    'server/src/engine/HorseAdaptiveObservation.ts',
    'server/dist/engine/HorseAdaptiveObservation.js',
  ].map((path) => ({ path, sha256: hash(readFileSync(root + '/' + path)) }));
  proof = {
    at: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceBindings: bindings,
    postgres: execFileSync(pg + '/postgres', ['--version'], { encoding: 'utf8' }).trim(),
    results,
    limits: [
      'Isolated synthetic schema and native SQL transport, not a full application schema or PostgREST gateway.',
      'Complete only for retained committed roster rows in one snapshot; no observation-time watermark, model persistence or live consumer.',
    ],
    cleanup: { stopped: false, removed: false },
  };
} finally {
  Date.now = oldNow;
  delete globalThis.horseSnapshotNative;
  if (writer) await writer.end();
  if (c) await c.end();
  if (running) {
    execFileSync(pg + '/pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    if (proof) proof.cleanup.stopped = true;
  }
  rmSync(dir, { recursive: true, force: true });
  if (proof) proof.cleanup.removed = true;
}
writeFileSync(process.argv[2], JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ results, cleanup: proof.cleanup }));
// Imported controller dependencies own recurring engine timers. The isolated
// proof has closed both clients and removed its cluster before exiting.
process.exit(0);
