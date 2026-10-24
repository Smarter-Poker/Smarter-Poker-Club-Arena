import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const uid = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const directory = mkdtempSync(join(tmpdir(), 'horse-opponent-memory-'));
let client: Client;
let port: number;
let started = false;
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
    }))
  );
  await client.query(
    `insert into hand_history
    select ('a0000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    now()-n*interval '1 minute','plo5',null,$1,$2 from generate_series(1,1024)n`,
    [JSON.stringify(capacityIds.map((userId) => ({ userId }))), JSON.stringify(capacityActions)]
  );
  const path = join(process.cwd(), '../supabase/migrations');
  const migration = readdirSync(path).find((f) =>
    f.endsWith('_durable_variant_scoped_horse_opponent_memory.sql')
  );
  if (!migration) throw new Error('durable opponent migration missing');
  await client.query(readFileSync(join(path, migration), 'utf8'));
  const admission = readdirSync(path).find((f) =>
    f.endsWith('_horse_opponent_cold_reads_admit_one_initializer.sql')
  );
  if (!admission) throw new Error('opponent memory admission migration missing');
  await client.query(readFileSync(join(path, admission), 'utf8'));
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

  it('recovers a full ten-player legacy horizon inside the decision read budget', async () => {
    const ids = Array.from(
      { length: 10 },
      (_, n) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    );
    await client.query("set statement_timeout='1500ms'");
    try {
      const started = performance.now();
      const rows = (
        await client.query(
          "select * from fn_horse_exploit_profiles_read($1,'plo5','cash','full')",
          [ids]
        )
      ).rows;
      console.info(
        'OPPONENT_MEMORY_COLD_READ',
        JSON.stringify({
          players: rows.length,
          horizon: 1024,
          elapsedMs: performance.now() - started,
        })
      );
      expect(rows).toHaveLength(10);
      expect(rows.every((p) => p.initialized && p.legacy_hands === 1024)).toBe(true);
    } finally {
      await client.query('reset statement_timeout');
    }
  });

  it('actor-targeted legacy parsing matches every public-action actor', async () => {
    const actions: unknown[] = [
      ...publicActions.hands.map((h) => h.actions),
      [
        null,
        3,
        'malformed',
        { userId: uid, action: 'check', stage: 'flop' },
        { userId: other, action: 'raise', stage: 'turn', isFullRaise: true },
      ],
    ];
    const result = await client.query(
      `with hands as (select x from jsonb_array_elements($1) x),
      counted as (select x,fn_horse_exploit_increments(x) counts from hands)
      select bool_and(fn_horse_exploit_increments(x,k) = jsonb_build_object(k,counts->k)) matched
      from counted cross join lateral jsonb_object_keys(counts) k`,
      [JSON.stringify(actions)]
    );
    expect(result.rows[0].matched).toBe(true);
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

  it('refuses a concurrent cold scan immediately while warm reads and accepted hands continue', async () => {
    const a = new Client({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: process.env.USER ?? 'postgres',
    });
    await a.connect();
    try {
      await profile();
      await a.query('begin');
      await a.query(
        "select pg_advisory_xact_lock(hashtextextended('horse-opponent-legacy-initializer',0))"
      );
      await client.query("set statement_timeout='500ms'");
      try {
        const peers = Array.from(
          { length: 8 },
          () =>
            new Client({
              host: '127.0.0.1',
              port,
              database: 'postgres',
              user: process.env.USER ?? 'postgres',
            })
        );
        let results: PromiseSettledResult<unknown>[];
        try {
          await Promise.all(peers.map((peer) => peer.connect()));
          await Promise.all(peers.map((peer) => peer.query("set statement_timeout='500ms'")));
          results = await Promise.allSettled(
            peers.map((peer) =>
              peer.query(
                "select * from fn_horse_exploit_profiles_read($1,'nlh','tournament','hu')",
                [[other]]
              )
            )
          );
        } finally {
          await Promise.all(peers.map((peer) => peer.end()));
        }
        expect(results.every((r) => r.status === 'rejected' && r.reason.code === '55P03')).toBe(
          true
        );
        expect((await profile()).initialized).toBe(true);
        await insert(hand('c0000000-0000-4000-8000-000000000001'));
      } finally {
        await client.query('reset statement_timeout');
      }
      await a.query('rollback');
      const restored = await client.query(
        "select * from fn_horse_exploit_profiles_read($1,'nlh','tournament','hu')",
        [[other]]
      );
      expect(restored.rows[0].initialized).toBe(true);
      expect(restored.rows[0].legacy_hands).toBe(0);
    } finally {
      await a.end();
    }
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
