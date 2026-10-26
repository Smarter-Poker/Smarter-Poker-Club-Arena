import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({
  query: null as null | ((args: any) => Promise<any>),
  calls: 0,
}));
vi.mock('../src/services/supabase.js', () => ({
  supabase: {
    rpc: (_name: string, args: any) => ({
      abortSignal: async () => {
        bridge.calls++;
        return bridge.query!(args);
      },
    }),
  },
}));
vi.mock('../src/services/errorReporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/errorReporter.js')>()),
  reportError: () => {},
}));
import {
  createDecisionOpponentProfileReader,
  readHorseOpponentProfiles,
} from '../src/services/HorseOpponentMemory.js';
import {
  exploitHandIncrements,
  freshExploitCounters,
  decayAndAdd,
} from '../src/engine/HorseOpponentExploit.js';
import { MEMORY_VARIANTS, validOpponentProfile } from '../src/engine/HorseOpponentMemory.js';
import { HorseMind } from '../src/engine/HorseMind.js';
import publicActions from '../src/engine/fixtures/opponent-memory-public-actions.json';

const PG =
  process.env.PG_BIN ??
  (process.platform === 'darwin'
    ? '/opt/homebrew/opt/postgresql@17/bin'
    : '/usr/lib/postgresql/17/bin');
// Retained public metadata shape from hand45902146; no holdings or identities.
const retainedPublicNode = {
  pot: 5,
  ante: 2,
  mode: 'cash',
  asset: 'chips',
  seats: [
    [1, 293.2, 0, 0, 0, 0, 0],
    [2, 199, 0, 0, 0, 0, 0],
    [3, 406.5, 1, 1, 0, 0, 0],
    [4, 550.5, 2, 4, 2, 0, 0],
    [5, 418.02, 0, 0, 0, 0, 0],
    [6, 310.4, 0, 0, 0, 0, 0],
  ],
  boards: [''],
  status: 'captured',
  street: 'preflop',
  toCall: 2,
  bombPot: false,
  variant: 'plo5',
  version: 1,
  anteType: 'big_blind',
  bigBlind: 2,
  chipUnit: 0.01,
  actorSeat: 5,
  structure: 'pot_limit',
  boardCount: 1,
  currentBet: 2,
  dealerSeat: 2,
  deductions: {
    bbj: { feeBB: 0.25, enabled: true, minPotBB: 10, minPlayersDealt: 3 },
    rake: {
      cap: 5,
      percent: 10,
      noFlopNoDrop: true,
      playerCountCaps: [
        [2, 2.5],
        [3, 5],
        [4, 5],
      ],
    },
    rules: 'controller-rake-bbj-v1',
    status: 'captured',
    version: 1,
  },
  maxRaiseTo: 9,
  minRaiseTo: 4,
  smallBlind: 1,
  allInOrFold: false,
  fixedBetSize: null,
  legalActions: ['fold', 'call', 'raise', 'all_in'],
  wagersCapped: false,
  tournamentStage: { status: 'not_applicable', version: 1 },
};
const uid = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const directory = mkdtempSync(join(tmpdir(), 'horse-opponent-memory-'));
let client: Client;
let port: number;
let started = false;
let repairTransaction: string;
let boundedTransaction: string;
let contextTransaction: string;
const addedVariants = ['flh', 'flo8', 'short_deck'] as const;
const contextActor = 'c1000000-0000-4000-8000-000000000001';
const contextBefore = new Map<string, string>();
let compatibilityProof: Record<string, unknown>;
const hand = (
  id: string,
  action = 'raise',
  variant = 'plo5',
  tournament: string | null = null
) => ({
  id,
  game_variant: variant,
  tournament_id: tournament,
  players: [{ userId: uid }, { userId: other }, { userId: '10000000-0000-4000-8000-000000000003' }],
  actions: [{ userId: uid, action, stage: 'preflop' }],
});
async function insert(row: ReturnType<typeof hand>) {
  await client.query(
    'insert into hand_history(id,game_variant,tournament_id,players,actions) values($1,$2,$3,$4,$5) on conflict(id) do nothing',
    [
      row.id,
      row.game_variant,
      row.tournament_id,
      JSON.stringify(row.players),
      JSON.stringify(row.actions),
    ]
  );
}
async function profile(variant = 'plo5', mode = 'cash') {
  return (
    await client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
      [uid],
      variant,
      mode,
      'short',
    ])
  ).rows[0];
}

beforeAll(async () => {
  execFileSync(
    join(PG, 'initdb'),
    ['-D', join(directory, 'data'), '-A', 'trust', '--locale=C', '--encoding=UTF8'],
    { stdio: 'pipe' }
  );
  // Let the OS choose an unused port, then start the isolated cluster there.
  const { createServer } = await import('node:net');
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  execFileSync(
    join(PG, 'pg_ctl'),
    [
      '-D',
      join(directory, 'data'),
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1`,
      'start',
    ],
    { stdio: 'ignore' }
  );
  started = true;
  client = new Client({
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: process.env.USER ?? 'postgres',
  });
  await client.connect();
  await client.query(`create role anon; create role authenticated; create role service_role;
    create table hand_history(id uuid primary key,created_at timestamptz not null default clock_timestamp(),
      game_variant text, tournament_id uuid,players jsonb,actions jsonb);
    create index on hand_history using gin(players jsonb_path_ops);`);
  // These supported card families were excluded by the old durable allowlist.
  // Seed legacy observations before installing any accepted-hand trigger.
  for (const [index, variant] of addedVariants.entries())
    await client.query(
      'insert into hand_history(id,game_variant,players,actions) values($1,$2,$3,$4)',
      [
        `c2000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        variant,
        JSON.stringify([{ userId: contextActor }, { userId: other }, { userId: uid }]),
        JSON.stringify([{ userId: contextActor, action: 'raise', stage: 'preflop' }]),
      ]
    );
  // Historical hands predate the persistence migration and remain read-only.
  for (let n = 0; n < 40; n++)
    await insert(hand(`20000000-0000-4000-8000-${String(n).padStart(12, '0')}`));
  for (const [index, h] of publicActions.hands.entries()) {
    const players = Array.from({ length: h.dealt }, (_, n) => ({
      userId:
        n === 0 ? publicActions.actor : `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));
    await client.query(
      'insert into hand_history(id,game_variant,players,actions) values($1,$2,$3,$4)',
      [
        `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        h.variant,
        JSON.stringify(players),
        JSON.stringify(h.actions),
      ]
    );
  }
  // Access-only/forced-post roster entries are not observations and must not
  // crowd the 40 actual legacy observations out of the 1024-hand tail.
  await client.query(
    `insert into hand_history
    select ('b0000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    now(),'plo5',null,$1,$2 from generate_series(1,1024)n`,
    [
      JSON.stringify(hand(uid).players),
      JSON.stringify([{ userId: uid, action: 'bb', stage: 'preflop' }]),
    ]
  );
  const capacityIds = Array.from(
    { length: 10 },
    (_, n) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  );
  const capacityActions = capacityIds.flatMap((userId) =>
    ['preflop', 'flop', 'turn', 'river'].map((stage) => ({
      userId,
      stage,
      action: stage === 'preflop' ? 'raise' : 'bet',
      publicNode: {
        ...retainedPublicNode,
        actorSeat: capacityIds.indexOf(userId) + 1,
        street: stage,
      },
    }))
  );
  await client.query(
    `insert into hand_history
    select ('a0000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    now()-n*interval '1 minute','plo5',null,$1,$2 from generate_series(1,1024)n`,
    [JSON.stringify(capacityIds.map((userId) => ({ userId }))), JSON.stringify(capacityActions)]
  );
  // The capacity actors also have a newer context-miss run, followed by a
  // much older eligible tail. Page boundaries cannot discard its earlier
  // 1024 actual PLO observations or needlessly parse the older tail.
  await client.query(
    `insert into hand_history
    select md5('context-noise-'||n)::uuid,now()-n*interval '1 millisecond','nlh',null::uuid,$1::jsonb,$2::jsonb
      from generate_series(1,2048)n
    union all select md5('old-tail-'||n)::uuid,now()-(30000+n)*interval '1 minute','plo5',null::uuid,$1::jsonb,$2::jsonb
      from generate_series(1,4096)n;`,
    [JSON.stringify(capacityIds.map((userId) => ({ userId }))), JSON.stringify(capacityActions)]
  );
  // Production has millions of unrelated hands; the old tiny fixture hid
  // the global JSON roster scan. Preserve the actual accepted-player indexes.
  await client.query(`insert into hand_history
    select md5('unrelated-'||n)::uuid,now()-n*interval '1 second','nlh',null,
      '[{"userId":"60000000-0000-4000-8000-000000000001"}]'::jsonb,
      '[{"userId":"60000000-0000-4000-8000-000000000001","action":"fold","stage":"preflop"}]'::jsonb
    from generate_series(1,50000)n;
    create table ca_hand_player_idx(user_id uuid not null,created_at timestamptz not null,
      hand_id uuid not null,primary key(user_id,hand_id));
    create index idx_ca_hand_player_idx_user_time on ca_hand_player_idx(user_id,created_at desc);
    create index idx_ca_hand_player_idx_hand_id on ca_hand_player_idx(hand_id);
    insert into ca_hand_player_idx select distinct (p->>'userId')::uuid,h.created_at,h.id
      from hand_history h cross join lateral jsonb_array_elements(h.players)p;
    create table hand_projection_outbox(hand_id uuid primary key);
    create table ca_hand_fact_revisions(user_id uuid,hand_id uuid,kind text);
    create index ca_hand_fact_revisions_user on ca_hand_fact_revisions(user_id);
    insert into hand_projection_outbox values
      ('20000000-0000-4000-8000-000000000000'),
      ('20000000-0000-4000-8000-000000000002'),
      (md5('unrelated-1')::uuid);
    insert into ca_hand_fact_revisions values
      ('${uid}','20000000-0000-4000-8000-000000000001','void');
    delete from ca_hand_player_idx where user_id='${uid}' and hand_id in
      ('20000000-0000-4000-8000-000000000000','20000000-0000-4000-8000-000000000001');
    analyze hand_history; analyze ca_hand_player_idx;`);
  const path = join(process.cwd(), '../supabase/migrations');
  const migration = readdirSync(path).find((f) =>
    f.endsWith('_durable_variant_scoped_horse_opponent_memory.sql')
  );
  if (!migration) throw new Error('durable opponent migration missing');
  await client.query(readFileSync(join(path, migration), 'utf8'));
  const repair = readdirSync(path).find((f) =>
    f.endsWith('_horse_opponent_legacy_context_index.sql')
  );
  if (!repair) throw new Error('indexed opponent migration missing');
  const [indexPreamble, replacement] = readFileSync(join(path, repair), 'utf8').split('\nBEGIN;\n');
  if (!indexPreamble || !replacement) throw new Error('concurrent repair migration shape missing');
  // Real CONCURRENTLY execution, outside the replacement transaction, matching
  // the existing production applier rather than stripping its safety property.
  await client.query(indexPreamble);
  repairTransaction = 'BEGIN;\n' + replacement;
  await client.query(repairTransaction);
  const admission = readdirSync(path).find((f) =>
    f.endsWith('_horse_memory_bounded_cold_read_admission.sql')
  );
  if (!admission) throw new Error('peer bounded cold-read predecessor missing');
  await client.query(readFileSync(join(path, admission), 'utf8'));
  const bounded = readdirSync(path).find((f) =>
    f.endsWith('_horse_opponent_bounded_original_request_reads.sql')
  );
  if (!bounded) throw new Error('bounded original-request opponent migration missing');
  boundedTransaction = readFileSync(join(path, bounded), 'utf8');
  await client.query(boundedTransaction);
  for (const variant of addedVariants)
    await expect(
      client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
        [contextActor],
        variant,
        'cash',
        'short',
      ])
    ).rejects.toMatchObject({ code: '22023' });
  for (const name of [
    'fn_horse_exploit_accept_hand()',
    'fn_horse_exploit_mark_hand()',
    'fn_horse_exploit_profiles_read(text[],text,text,text)',
  ])
    contextBefore.set(
      name,
      (await client.query('select pg_get_functiondef($1::regprocedure) body', [name])).rows[0].body
    );
  const contexts = readdirSync(path).find((f) =>
    f.endsWith('_horse_opponent_memory_remaining_variants.sql')
  );
  if (!contexts) throw new Error('remaining opponent contexts migration missing');
  contextTransaction = readFileSync(join(path, contexts), 'utf8');
  // Exercise the actual installed five-variant reader through the service,
  // then the exact new migration, without any production connection or probe.
  bridge.query = async (args) => {
    try {
      const result = await client.query(
        'select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)',
        [args.p_user_ids, args.p_variant, args.p_mode, args.p_size]
      );
      return {
        data: result.rows.map((row) => ({ ...row, observed_hands: Number(row.observed_hands) })),
        error: null,
      };
    } catch (error) {
      return { data: null, error };
    }
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now());
  try {
    const read = createDecisionOpponentProfileReader(async () => 'installed');
    const requests = addedVariants.map(
      (variant) =>
        ({
          fence: `compat:${variant}:1:lease:turn`,
          gameState: {
            gameVariant: variant,
            players: [{ user_id: contextActor }],
            dealtSeatIds: [1, 2, 3],
          },
        }) as any
    );
    await client.query('set role service_role');
    const absent = [];
    for (const request of requests) absent.push(await read(request));
    const oldFailureCalls = bridge.calls;
    for (const variant of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'])
      await readHorseOpponentProfiles(
        ['c9000000-0000-4000-8000-000000000001'],
        variant,
        'cash',
        'hu'
      );
    const stableCalls = bridge.calls;
    vi.advanceTimersByTime(59_999);
    for (const request of requests) await read({ ...request, fence: `${request.fence}:other` });
    const cachedCalls = bridge.calls;
    await client.query('reset role');
    await client.query(contextTransaction);
    vi.advanceTimersByTime(1);
    await client.query('set role service_role');
    const restored = [];
    for (const request of requests) restored.push(await read(request));
    const recoveredCalls = bridge.calls;
    for (const request of requests) await read(request);
    compatibilityProof = {
      absent,
      oldFailureCalls,
      stableCalls,
      cachedCalls,
      recoveredCalls,
      sameHandCalls: bridge.calls,
      restoredVariants: restored.map((rows) => rows?.[0]?.variant),
    };
  } finally {
    await client.query('reset role');
    vi.useRealTimers();
  }
}, 30000);

afterAll(async () => {
  await client?.end();
  try {
    if (started)
      execFileSync(join(PG, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', 'stop'], {
        stdio: 'ignore',
      });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable opponent memory with real PostgreSQL', () => {
  it('does not validate the new nullable domain against historical rows but enforces new writes', async () => {
    const constraint = (
      await client.query(
        "select convalidated from pg_constraint where conname='horse_exploit_dealt_count_range' and conrelid='public.hand_history'::regclass"
      )
    ).rows;
    expect(constraint).toEqual([{ convalidated: false }]);
    await expect(
      client.query(
        "update hand_history set horse_exploit_dealt_count=1 where id='20000000-0000-4000-8000-000000000000'"
      )
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await client.query(
          "select horse_exploit_dealt_count from hand_history where id='20000000-0000-4000-8000-000000000000'"
        )
      ).rows
    ).toEqual([{ horse_exploit_dealt_count: null }]);
  });

  it('SQL action counting matches the live parser, including calls and short all-ins', async () => {
    const actions = [
      { userId: uid, action: 'bb', stage: 'preflop' },
      { userId: other, action: 'call', stage: 'preflop' },
      { userId: uid, action: 'raise', stage: 'preflop' },
      { userId: other, action: 'all_in', isFullRaise: true, stage: 'preflop' },
      { userId: uid, action: 'all_in', isFullRaise: false, stage: 'preflop' },
      { userId: uid, action: 'check', stage: 'flop' },
      { userId: other, action: 'bet', stage: 'flop' },
      { userId: uid, action: 'call', stage: 'flop' },
      { userId: uid, action: 'bet', stage: 'turn' },
      { userId: other, action: 'fold', stage: 'turn' },
      { userId: uid, action: 'bet', stage: 'river' },
      { userId: other, action: 'call', stage: 'river' },
    ];
    const sql = (
      await client.query('select fn_horse_exploit_increments($1) value', [JSON.stringify(actions)])
    ).rows[0].value;
    expect(sql).toEqual(Object.fromEntries(exploitHandIncrements(actions)));
  });

  it('matches every recorded public-action hand and reconstructs each game context', async () => {
    const sql = (
      await client.query(
        'select fn_horse_exploit_increments(x) value from jsonb_array_elements($1) x',
        [JSON.stringify(publicActions.hands.map((h) => h.actions))]
      )
    ).rows;
    const expected = new Map<string, ReturnType<typeof freshExploitCounters>>();
    for (const [index, h] of publicActions.hands.entries()) {
      const increments = exploitHandIncrements(h.actions);
      expect(sql[index].value).toEqual(Object.fromEntries(increments));
      const size = h.dealt <= 2 ? 'hu' : h.dealt <= 5 ? 'short' : 'full';
      const key = `${h.variant}:${size}`;
      const row = expected.get(key) ?? freshExploitCounters();
      const inc = increments.get(publicActions.actor);
      if (inc) decayAndAdd(row, inc);
      expected.set(key, row);
    }
    for (const [key, counters] of expected) {
      const [variant, size] = key.split(':');
      const row = (
        await client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
          [publicActions.actor],
          variant,
          'cash',
          size,
        ])
      ).rows[0];
      for (const f of Object.keys(counters) as (keyof typeof counters)[])
        expect(row.counters[f], `${key}/${f}`).toBeCloseTo(counters[f], 9);
    }
  });

  it('advances exactly one rich-publicNode full legacy actor per bounded original request', async () => {
    const ids = Array.from(
      { length: 10 },
      (_, n) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    );
    const repairSql = readFileSync(
      join(
        process.cwd(),
        '../supabase/migrations/20261024023547_horse_opponent_bounded_original_request_reads.sql'
      ),
      'utf8'
    );
    const selection = repairSql
      .slice(
        repairSql.indexOf('     SELECT id,created_at,actions FROM public.hand_history'),
        repairSql.indexOf('\n    ), observations AS MATERIALIZED')
      )
      .replace(/\buid\b/g, `'${ids[0]}'`)
      .replace(/\bp_variant\b/g, "'plo5'")
      .replace(/\bp_mode\b/g, "'cash'")
      .replace(/\bp_size\b/g, "'full'");
    const plan = JSON.stringify((await client.query('explain(format json) ' + selection)).rows);
    expect(plan).toContain('idx_hand_history_horse_legacy_context');
    expect(
      JSON.stringify(
        (await client.query('explain(format json) ' + selection.replaceAll("'plo5'", "'plo4'")))
          .rows
      )
    ).toContain('idx_hand_history_horse_legacy_context');
    const index = (
      await client.query(`select indisvalid,indisready,pg_get_indexdef(indexrelid) AS definition
      from pg_index where indexrelid='idx_hand_history_horse_legacy_context'::regclass`)
    ).rows[0];
    process.stdout.write('OPPONENT_MEMORY_LEGACY_INDEX ' + index.definition + '\n');
    expect(index.indisvalid && index.indisready).toBe(true);
    expect(index.definition).toContain('WHERE (NOT horse_exploit_recorded)');
    const payload = (
      await client.query(
        `select jsonb_array_length(actions) AS actions,octet_length(actions::text) AS decoded_bytes,pg_column_size(actions) AS stored_bytes from hand_history where id='a0000000-0000-4000-8000-000000000001'`
      )
    ).rows[0];
    process.stdout.write('OPPONENT_MEMORY_RICH_PAYLOAD ' + JSON.stringify(payload) + '\n');
    await client.query("set statement_timeout='1500ms'");
    try {
      const elapsedMs: number[] = [];
      let rows: any[] = [];
      for (let request = 1; request <= 10; request++) {
        const started = performance.now();
        rows = (
          await client.query(
            "select * from fn_horse_exploit_profiles_read($1,'plo5','cash','full')",
            [ids]
          )
        ).rows;
        elapsedMs.push(performance.now() - started);
        expect(rows.filter((p) => p.initialized)).toHaveLength(request);
        expect(rows.every((p) => p.initialized && p.legacy_hands === 1024)).toBe(true);
      }
      const expected = freshExploitCounters();
      const increment = exploitHandIncrements(
        ids.flatMap((userId) =>
          ['preflop', 'flop', 'turn', 'river'].map((stage) => ({
            userId,
            stage,
            action: stage === 'preflop' ? 'raise' : 'bet',
          }))
        )
      ).get(ids[0])!;
      for (let n = 0; n < 1024; n++) decayAndAdd(expected, increment);
      for (const field of Object.keys(expected) as (keyof typeof expected)[])
        expect(rows[0].counters[field]).toBeCloseTo(expected[field], 8);
      process.stdout.write(
        'OPPONENT_MEMORY_BOUNDED_COLD_READ ' +
          JSON.stringify({ players: rows.length, horizon: 1024, requests: 10, elapsedMs }) +
          '\n'
      );
    } finally {
      await client.query('reset statement_timeout');
    }
  });

  it('keeps forced generic legacy plans on only the compact actor/context index', async () => {
    const selection = boundedTransaction
      .slice(
        boundedTransaction.indexOf('     SELECT id,created_at,actions FROM public.hand_history'),
        boundedTransaction.indexOf('\n    ), observations AS MATERIALIZED')
      )
      .replace(/\bp_variant\b/g, '$1')
      .replace(/\bp_mode\b/g, '$2')
      .replace(/\bp_size\b/g, '$3')
      .replace(/\buid\b/g, '$4');
    await client.query('set plan_cache_mode=force_generic_plan');
    try {
      await client.query('prepare bounded_opponent_legacy(text,text,text,text) as ' + selection);
      for (const variant of ['plo5', 'plo4']) {
        const plan = JSON.stringify(
          (
            await client.query(
              `explain(format json) execute bounded_opponent_legacy('${variant}','cash','full','90000000-0000-4000-8000-000000000000')`
            )
          ).rows
        );
        expect(plan).toContain('idx_hand_history_horse_legacy_context');
        expect(plan).not.toContain('BitmapAnd');
        expect(plan).not.toContain('hand_history_players_idx');
        process.stdout.write(
          'OPPONENT_MEMORY_GENERIC_PLAN ' +
            JSON.stringify({ variant, plan: JSON.parse(plan) }) +
            '\n'
        );
      }
    } finally {
      await client.query('deallocate bounded_opponent_legacy');
      await client.query('reset plan_cache_mode');
    }
  });

  it('never queues cold work behind another process and preserves partial accepted learning', async () => {
    const holder = new Client({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: process.env.USER ?? 'postgres',
    });
    await holder.connect();
    const cold = '93000000-0000-4000-8000-000000000001';
    const known = '90000000-0000-4000-8000-000000000000';
    await client.query(
      `insert into hand_history(id,game_variant,players,actions,horse_exploit_dealt_count)
      values($1,'plo5',$2,$3,6)`,
      [
        cold,
        JSON.stringify([{ userId: cold }]),
        JSON.stringify([
          { userId: cold, stage: 'preflop', action: 'raise', publicNode: retainedPublicNode },
        ]),
      ]
    );
    try {
      await holder.query('begin');
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended('horse-opponent-legacy-initialization:v1',0))"
      );
      await client.query("set statement_timeout='100ms'");
      const heldStarted = performance.now();
      const rows = (
        await client.query(
          "select * from fn_horse_exploit_profiles_read($1,'plo5','cash','full')",
          [[cold, known]]
        )
      ).rows;
      process.stdout.write(
        'OPPONENT_MEMORY_LOCK_BUSY ' +
          JSON.stringify({ elapsedMs: performance.now() - heldStarted }) +
          '\n'
      );
      expect(rows).toHaveLength(2);
      expect(
        (
          await client.query(
            "select * from fn_horse_exploit_profiles_read($1,'plo4','cash','full')",
            [[cold]]
          )
        ).rows
      ).toEqual([]);
      expect(rows.find((p) => p.user_id === known).initialized).toBe(true);
      expect(rows.find((p) => p.user_id === cold)).toMatchObject({
        initialized: false,
        legacy_hands: 0,
        observed_hands: '1',
      });
      await client.query('reset statement_timeout');
      await holder.query('commit');
      const rowsAfter = (
        await client.query(
          "select * from fn_horse_exploit_profiles_read($1,'plo5','cash','full')",
          [[cold, known]]
        )
      ).rows;
      expect(rowsAfter.find((p) => p.user_id === cold)).toMatchObject({
        initialized: true,
        legacy_hands: 0,
        observed_hands: '1',
      });
      expect(rowsAfter.find((p) => p.user_id === cold).counters.hands).toBe(1);
    } finally {
      await client.query('reset statement_timeout');
      await holder.query('rollback');
      await holder.end();
    }
  });

  it('actor-targeted legacy parsing matches every public-action actor', async () => {
    const actions: unknown[] = [
      ...publicActions.hands.map((h) => h.actions),
      [{ userId: uid, action: 'check', stage: 'flop', publicNode: retainedPublicNode }],
      [],
      [[]],
      [[{ userId: uid, action: 'check', stage: 'flop' }]],
      [null],
      [3],
      ['malformed'],
      [
        null,
        [],
        true,
        3,
        'malformed',
        { userId: uid, action: 'check', stage: 'flop' },
        { userId: other, action: 'raise', stage: 'turn', isFullRaise: true },
      ],
    ];
    const original = readdirSync(join(process.cwd(), '../supabase/migrations')).find((f) =>
      f.endsWith('_durable_variant_scoped_horse_opponent_memory.sql')
    )!;
    const source = readFileSync(join(process.cwd(), '../supabase/migrations', original), 'utf8');
    const actor = source
      .slice(
        source.indexOf('CREATE FUNCTION public.fn_horse_exploit_actor_increments'),
        source.indexOf('CREATE FUNCTION public.fn_horse_exploit_increments')
      )
      .replace('public.fn_horse_exploit_actor_increments', 'pg_temp.original_actor_increments');
    await client.query(actor);
    expect(
      (
        await client.query(
          `select bool_and(fn_horse_exploit_actor_increments(x,$2)=pg_temp.original_actor_increments(x,$2)) matched from jsonb_array_elements($1)x`,
          [JSON.stringify(actions), uid]
        )
      ).rows[0].matched
    ).toBe(true);
    const result = await client.query(
      `with hands as (select x from jsonb_array_elements($1) x),
      counted as (select x,fn_horse_exploit_increments(x) counts from hands)
      select bool_and(fn_horse_exploit_increments(x,k) = jsonb_build_object(k,counts->k)) matched
      from counted cross join lateral jsonb_object_keys(counts) k`,
      [JSON.stringify(actions)]
    );
    expect(result.rows[0].matched).toBe(true);
  });

  it('reads canonical history when player index projection is pending or a fact was voided', async () => {
    const row = await profile();
    expect(row.legacy_hands).toBe(40);
    expect(row.initialized).toBe(true);
    expect(
      (
        await client.query(
          `select count(*)::int AS n from ca_hand_player_idx
      where user_id=$1 and hand_id in
      ('20000000-0000-4000-8000-000000000000','20000000-0000-4000-8000-000000000001')`,
          [uid]
        )
      ).rows[0].n
    ).toBe(0);
  });

  it('reconstructs old sessions and survives new connections without forgetting or double counting', async () => {
    const base = freshExploitCounters();
    const increment = exploitHandIncrements(hand(uid).actions).get(uid)!;
    for (let i = 0; i < 40; i++) decayAndAdd(base, increment);
    const first = await profile();
    expect(first.legacy_hands).toBe(40);
    for (const field of Object.keys(base) as (keyof typeof base)[])
      expect(first.counters[field]).toBeCloseTo(base[field], 10);
    expect(await profile()).toEqual(first);
    const row = hand('30000000-0000-4000-8000-000000000001');
    await insert(row);
    await insert(row);
    const next = await profile();
    expect(Number(next.observed_hands)).toBe(1);
    decayAndAdd(base, increment);
    for (const field of Object.keys(base) as (keyof typeof base)[])
      expect(next.counters[field]).toBeCloseTo(base[field], 10);
  });

  it('keeps every PLO variant and tournament history separate', async () => {
    for (const variant of MEMORY_VARIANTS) {
      const p = await profile(variant);
      expect(p.variant).toBe(variant);
      if (variant !== 'plo5') expect(p.counters.hands).toBe(0);
    }
    expect((await profile('plo5', 'tournament')).counters.hands).toBe(0);
  });

  it('uses the authoritative dealt count rather than the access-control roster size', async () => {
    const roster = Array.from({ length: 8 }, (_, n) => ({
      userId: n === 0 ? uid : `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));
    await client.query(
      'insert into hand_history(id,game_variant,players,actions,horse_exploit_dealt_count) values($1,$2,$3,$4,$5)',
      [
        '92000000-0000-4000-8000-000000000001',
        'plo8',
        JSON.stringify(roster),
        JSON.stringify(hand(uid).actions),
        3,
      ]
    );
    expect(Number((await profile('plo8')).observed_hands)).toBe(1);
    const full = (
      await client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
        [uid],
        'plo8',
        'cash',
        'full',
      ])
    ).rows[0];
    expect(Number(full.observed_hands)).toBe(0);
  });

  it('serializes simultaneous accepted hands and rolls learning back with a refused transaction', async () => {
    const before = await profile('plo6');
    const a = new Client({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: process.env.USER ?? 'postgres',
    });
    const b = new Client({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: process.env.USER ?? 'postgres',
    });
    await Promise.all([a.connect(), b.connect()]);
    try {
      const sql = 'insert into hand_history(id,game_variant,players,actions) values($1,$2,$3,$4)';
      const values = (id: string) => [
        id,
        'plo6',
        JSON.stringify(hand(id).players),
        JSON.stringify(hand(id).actions),
      ];
      await Promise.all([
        a.query(sql, values('50000000-0000-4000-8000-000000000001')),
        b.query(sql, values('50000000-0000-4000-8000-000000000002')),
      ]);
      const current = await profile('plo6');
      expect(Number(current.observed_hands) - Number(before.observed_hands)).toBe(2);
      const expected = freshExploitCounters();
      const increment = exploitHandIncrements(hand(uid).actions).get(uid)!;
      decayAndAdd(expected, increment);
      decayAndAdd(expected, increment);
      for (const field of Object.keys(expected) as (keyof typeof expected)[])
        expect(current.counters[field]).toBeCloseTo(expected[field], 10);
      await a.query('begin');
      await a.query(sql, values('50000000-0000-4000-8000-000000000003'));
      await a.query('rollback');
      expect(await profile('plo6')).toEqual(current);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('refuses a wrong predecessor index without changing the bounded reader or restoring revoked access', async () => {
    await client.query(
      'revoke execute on function fn_horse_exploit_profiles_read(text[],text,text,text) from service_role'
    );
    const before = (
      await client.query(`select pg_get_functiondef(
      'fn_horse_exploit_profiles_read(text[],text,text,text)'::regprocedure) AS body`)
    ).rows[0].body;
    await client.query(`alter index idx_hand_history_horse_legacy_context rename to horse_qualified_index;
      create index idx_hand_history_horse_legacy_context on hand_history(id)`);
    try {
      await expect(client.query(boundedTransaction)).rejects.toThrow(
        /index missing, invalid or definition differs/
      );
      await client.query('rollback');
      expect(
        (
          await client.query(
            "select has_function_privilege('service_role','fn_horse_exploit_profiles_read(text[],text,text,text)','EXECUTE') allowed"
          )
        ).rows[0].allowed
      ).toBe(false);
    } finally {
      await client.query('rollback');
      await client.query(`drop index idx_hand_history_horse_legacy_context;
        alter index horse_qualified_index rename to idx_hand_history_horse_legacy_context`);
      // Later tests must retain the bounded reader, never the installed old reader.
      await client.query(boundedTransaction);
      // The index guard test restores its own preceding reader, including the
      // additive variant allowlist, rather than reverting the later migration.
      await client.query(before);
    }
    expect(
      (
        await client.query(`select pg_get_functiondef(
      'fn_horse_exploit_profiles_read(text[],text,text,text)'::regprocedure) AS body`)
      ).rows[0].body
    ).toBe(before);
  });

  it('restricts durable reads to the engine service identity', async () => {
    await client.query('set role authenticated');
    try {
      await expect(
        client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
          [uid],
          'plo5',
          'cash',
          'short',
        ])
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('reset role');
    }
  });

  it('rejects malformed snapshots and ignores stale or duplicated worker delivery', async () => {
    const raw = await profile();
    const p = { ...raw, observed_hands: Number(raw.observed_hands) };
    expect(validOpponentProfile(p)).toBe(true);
    expect(validOpponentProfile({ ...p, counters: { ...p.counters, pfr: NaN } })).toBe(false);
    expect(HorseMind.importDurableOpponentProfiles([p])).toBe(1);
    expect(HorseMind.importDurableOpponentProfiles([p])).toBe(0);
    expect(HorseMind.importDurableOpponentProfiles([{ ...p, observed_hands: 0 }])).toBe(0);
    HorseMind.setDecisionScope('omaha:short', 'plo5');
    expect(HorseMind.opponentRead(uid)?.stats.pfr.engaged).toBe('high');
    HorseMind.setDecisionScope('omaha:short', 'plo4');
    expect(HorseMind.opponentRead(uid)).toBeNull();
    HorseMind.setDecisionScope(null);
  });
});

describe('remaining saved opponent contexts with real PostgreSQL', () => {
  it('contains the actual five-to-eight schema transition without a global cooldown or sticky failed hand', () => {
    expect(compatibilityProof).toEqual({
      absent: [[], [], []],
      oldFailureCalls: 3,
      stableCalls: 8,
      cachedCalls: 8,
      recoveredCalls: 11,
      sameHandCalls: 11,
      restoredVariants: [...addedVariants],
    });
  });
  it('changes only each exact allowlist and leaves the bounded reader contract intact', async () => {
    const oldList = "('nlh','plo4','plo5','plo6','plo8')";
    const nextList = "('nlh','plo4','plo5','plo6','plo8','flh','flo8','short_deck')";
    for (const [name, before] of contextBefore) {
      const after = (await client.query('select pg_get_functiondef($1::regprocedure) body', [name]))
        .rows[0].body;
      expect(after, name).toBe(before.replace(oldList, nextList));
    }
    const check = (
      await client.query(
        "select convalidated,pg_get_constraintdef(oid) body from pg_constraint where conrelid='horse_exploit_profiles'::regclass and conname='horse_exploit_profiles_variant_check'"
      )
    ).rows[0];
    expect(check.convalidated).toBe(true);
    for (const variant of addedVariants) expect(check.body).toContain(`'${variant}'::text`);
  });

  it('restores bounded legacy reads for each new variant and keeps betting, mode and size isolated', async () => {
    for (const variant of addedVariants) {
      const request = async (v = variant as string, mode = 'cash', size = 'short') =>
        (
          await client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
            [contextActor],
            v,
            mode,
            size,
          ])
        ).rows[0];
      const row = await request();
      expect(row).toMatchObject({
        variant,
        mode: 'cash',
        size: 'short',
        initialized: true,
        legacy_hands: 1,
      });
      expect(row.counters.hands).toBe(1);
      expect(row.counters.pfr).toBe(1);
      expect((await request(variant, 'tournament')).counters.hands).toBe(0);
      expect((await request(variant, 'cash', 'hu')).counters.hands).toBe(0);
      expect((await request(variant, 'cash', 'full')).counters.hands).toBe(0);
    }
    for (const variant of ['nlh', 'plo8']) {
      const row = (
        await client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
          [contextActor],
          variant,
          'cash',
          'short',
        ])
      ).rows[0];
      expect(row.counters.hands).toBe(0);
    }
  });

  it('learns accepted new-variant hands exactly once and rolls back refused transactions', async () => {
    for (const [index, variant] of addedVariants.entries()) {
      const read = async () =>
        (
          await client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
            [contextActor],
            variant,
            'cash',
            'short',
          ])
        ).rows[0];
      const before = await read();
      const id = `c3000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const row = {
        ...hand(id, 'call', variant),
        players: [{ userId: contextActor }, { userId: other }, { userId: uid }],
        actions: [{ userId: contextActor, action: 'call', stage: 'preflop' }],
      };
      await insert(row);
      await insert(row);
      const after = await read();
      expect(Number(after.observed_hands) - Number(before.observed_hands)).toBe(1);
      expect(
        (await client.query('select horse_exploit_recorded from hand_history where id=$1', [id]))
          .rows[0].horse_exploit_recorded
      ).toBe(true);
      await client.query('begin');
      try {
        await insert({ ...row, id: `c4000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
      } finally {
        await client.query('rollback');
      }
      expect(await read()).toEqual(after);
      const connection = new Client({
        host: '127.0.0.1',
        port,
        database: 'postgres',
        user: process.env.USER ?? 'postgres',
      });
      await connection.connect();
      try {
        expect(
          (
            await connection.query(
              'select counters,observed_hands from horse_exploit_profiles where user_id=$1 and variant=$2 and mode=$3 and size=$4',
              [contextActor, variant, 'cash', 'short']
            )
          ).rows[0]
        ).toEqual({ counters: after.counters, observed_hands: after.observed_hands });
      } finally {
        await connection.end();
      }
    }
  });

  it('retains private read permissions and refuses unsupported variants and replay', async () => {
    await expect(
      client.query('select * from fn_horse_exploit_profiles_read($1,$2,$3,$4)', [
        [contextActor],
        'other_variant',
        'cash',
        'short',
      ])
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      client.query(
        "insert into horse_exploit_profiles(user_id,variant,mode,size) values($1,'other_variant','cash','short')",
        [contextActor]
      )
    ).rejects.toMatchObject({ code: '23514' });
    const grants = (
      await client.query(
        "select has_function_privilege('service_role','fn_horse_exploit_profiles_read(text[],text,text,text)','execute') service,has_function_privilege('anon','fn_horse_exploit_profiles_read(text[],text,text,text)','execute') anon,has_function_privilege('authenticated','fn_horse_exploit_profiles_read(text[],text,text,text)','execute') browser"
      )
    ).rows[0];
    expect(grants).toEqual({ service: true, anon: false, browser: false });
    await expect(client.query(contextTransaction)).rejects.toThrow(
      /variant constraint preimage differs/
    );
    await client.query('rollback');
    const variants = (
      await client.query('select distinct variant from horse_exploit_profiles where user_id=$1', [
        contextActor,
      ])
    ).rows.map((r) => r.variant);
    expect(variants).toEqual(expect.arrayContaining([...addedVariants]));
  });
});
