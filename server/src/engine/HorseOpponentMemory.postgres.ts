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
} from './HorseOpponentExploit.js';
import { MEMORY_VARIANTS, validOpponentProfile } from './HorseOpponentMemory.js';
import { HorseMind } from './HorseMind.js';
import publicActions from './fixtures/opponent-memory-public-actions.json';

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
  const path = join(process.cwd(), '../supabase/migrations');
  const migration = readdirSync(path).find((f) =>
    f.endsWith('_durable_variant_scoped_horse_opponent_memory.sql')
  );
  if (!migration) throw new Error('durable opponent migration missing');
  await client.query(readFileSync(join(path, migration), 'utf8'));
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
