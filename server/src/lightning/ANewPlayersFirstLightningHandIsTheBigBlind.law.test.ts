/**
 * LAW: A NEW PLAYER'S FIRST LIGHTNING HAND IS THE BIG BLIND (Dan, 2026-10-24).
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST."
 *
 * Read from production before the fix: of 359 new pool slots in three hours,
 * 337 were the big blind in their first hand, 18 the small blind and 4 held no
 * blind. The first-entry rule was off by default ('any_seat'), "newcomer" meant
 * "no blind-ledger row in the Cluster, ever", and even when on the rule held a
 * newcomer only while it cost the pass no hand. Every exception was a pass
 * where two or more never-dealt players were formed together.
 *
 * The rule now, in the live SQL plan (fn_lightning_match_plan, migration
 * 20261024195059) and its TypeScript port (LightningMatcherModel), line for
 * line:
 *
 *   - a NEWCOMER is a pool slot that has never been the big blind
 *     (lightning_pool_slot.last_bb_at IS NULL / `lastBbAtMs === null`);
 *   - a newcomer who is not one of the pass's big blinds is HELD, even when
 *     that costs the pass a hand, and the big blinds are taken again after
 *     every hold until nothing changes (a newcomer pushed out of the big-blind
 *     set by the shrink is held too);
 *   - the ONE exception: a hold that would leave the pass no hand at all is
 *     not taken, so a pool of only newcomers still deals;
 *   - the rule is not a tunable: the config reports big_blind whatever a
 *     ruleset says, and lists anything else under `invalid`.
 *
 * Horses are players (CLAUDE.md 10.5): nothing here reads a horse marker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIGHTNING_MATCHER_PARAM_DEFAULTS,
  isLightningNewcomer,
  lightningMatcherModel,
  lightningMatcherParams,
  type LightningMatchPlan,
  type LightningPoolPlayer,
} from './LightningMatcherModel.js';
import { seededRandom } from './LightningMatcherSim.js';

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATION = join(
  ROOT,
  'supabase',
  'migrations',
  '20261024195059_lightning_new_players_are_always_the_big_blind_first.sql'
);
const SQL = readFileSync(MIGRATION, 'utf8');
const MODEL = readFileSync(join(__dirname, 'LightningMatcherModel.ts'), 'utf8');
const PLAN_BLOCK = SQL.slice(SQL.indexOf('$plan$'), SQL.lastIndexOf('$plan$'));
const CFG_BLOCK = SQL.slice(SQL.indexOf('$cfg$'), SQL.lastIndexOf('$cfg$'));

const NOW = 1_000_000;

/** A legal, long-idle pool player; `bbAt` null = never the big blind (a newcomer). */
function player(id: string, bbAt: number | null, extra: Partial<LightningPoolPlayer> = {}) {
  return {
    playerId: id,
    legal: true,
    reasonCode: null,
    idleSinceMs: 0,
    enteredAtMs: 0,
    joinedAtMs: 0,
    slotOpenedAtMs: 0,
    lastBbAtMs: bbAt,
    bbUnresolved: false,
    debtSinceMs: 0,
    handsSinceBb: bbAt === null ? null : 3,
    newcomer: bbAt === null,
    positions: { btn: 0, co: 0, hj: 0, utg: 0 },
    ...extra,
  } satisfies LightningPoolPlayer;
}
const newcomers = (n: number, prefix = 'n') =>
  Array.from({ length: n }, (_, i) => player(`${prefix}${String(i).padStart(2, '0')}`, null));
const regulars = (n: number, prefix = 'r') =>
  Array.from({ length: n }, (_, i) => player(`${prefix}${String(i).padStart(2, '0')}`, 100 + i));

const VERSIONS = ['m1', 'm1-port', 'm2'];
function plan(players: LightningPoolPlayer[], version = 'm1'): LightningMatchPlan {
  return lightningMatcherModel(version)!.plan(
    { nowMs: NOW, players, recentHands: [] },
    lightningMatcherParams({})
  );
}
const seated = (p: LightningMatchPlan) => new Set(p.groups.flatMap((g) => g.players));
/** Newcomers dealt into a seat other than the big blind. */
const newcomersOffTheBigBlind = (p: LightningMatchPlan, pool: LightningPoolPlayer[]) => {
  const nc = new Set(pool.filter((x) => x.lastBbAtMs === null).map((x) => x.playerId));
  return p.groups.flatMap((g) => g.players.slice(1)).filter((id) => nc.has(id));
};

describe("a new player's first Lightning hand is the big blind", () => {
  it.each(VERSIONS)(
    'holds the second of two newcomers rather than deal them a small blind (%s)',
    (v) => {
      const pool = [...newcomers(2), ...regulars(4)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      expect(p.groups[0].bb).toBe('n00');
      expect(p.groups[0].players).toHaveLength(5);
      expect(seated(p).has('n01')).toBe(false);
      expect(newcomersOffTheBigBlind(p, pool)).toEqual([]);
    }
  );

  it.each(VERSIONS)(
    'holds a newcomer even when it costs the pass a hand, and re-takes the big blinds after each hold (%s)',
    (v) => {
      // Twelve legal, four newcomers: two hands, whose big blinds are n00 and
      // n01. Holding n02 and n03 leaves ten, one hand, so n01 is pushed out of
      // the big-blind set and is held too. The old rule (hold only while it
      // costs no hand) dealt two of these newcomers outside the big blind.
      const pool = [...newcomers(4), ...regulars(8)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      expect(p.groups[0].bb).toBe('n00');
      for (const id of ['n01', 'n02', 'n03']) expect(seated(p).has(id)).toBe(false);
      expect(newcomersOffTheBigBlind(p, pool)).toEqual([]);
    }
  );

  it.each(VERSIONS)('never deadlocks a pool of only newcomers: the pass still deals (%s)', (v) => {
    for (const n of [5, 6, 7, 11, 12, 24]) {
      const p = plan(newcomers(n), v);
      expect(p.groups.length, `${n} newcomers`).toBeGreaterThan(0);
    }
  });

  it.each(VERSIONS)(
    'with five or more players who have been the big blind, no newcomer is ever dealt off the big blind (%s)',
    (v) => {
      const rand = seededRandom(20261024);
      for (let trial = 0; trial < 400; trial++) {
        const pool = [
          ...newcomers(Math.floor(rand() * 14)),
          ...regulars(5 + Math.floor(rand() * 30)),
        ].map((x) => ({
          ...x,
          idleSinceMs: Math.floor(rand() * 10_000),
          slotOpenedAtMs: Math.floor(rand() * 10_000),
          debtSinceMs: Math.floor(rand() * 10_000),
          bbUnresolved: x.lastBbAtMs !== null && rand() < 0.1,
        }));
        const p = plan(pool, v);
        expect(newcomersOffTheBigBlind(p, pool), `trial ${trial}`).toEqual([]);
        // Every hand still has five or six players and nobody is seated twice.
        for (const g of p.groups) expect([5, 6]).toContain(g.players.length);
        expect(seated(p).size).toBe(p.groups.reduce((s, g) => s + g.players.length, 0));
        // A pass with enough players who have been the big blind deals.
        expect(p.groups.length).toBeGreaterThan(0);
      }
    }
  );

  it('reads the slot that has never been the big blind; the stored flag can only exempt a conversion seat', () => {
    // 20261024213844: the database's `newcomer` is false for a seat the
    // epoch's conversion made (n01). It can never make a newcomer of a slot
    // that has been the big blind (r00 carries a stray true and is not one).
    const pool = [
      player('n00', null),
      player('n01', null, { newcomer: false }),
      ...regulars(4).map((r, i) => (i === 0 ? { ...r, newcomer: true } : r)),
    ];
    const p = plan(pool);
    expect(p.groups[0].bb).toBe('n00');
    expect(seated(p).has('n01')).toBe(true);
    expect(seated(p).has('r00')).toBe(true);
    expect(isLightningNewcomer(player('x', null, { newcomer: false }))).toBe(false);
    expect(isLightningNewcomer(player('x', null, { newcomer: true }))).toBe(true);
    expect(isLightningNewcomer(player('x', 5, { newcomer: true }))).toBe(false);
  });

  it('a player with an unresolved big blind still outranks a newcomer, who waits for the next pass', () => {
    const pool = [...newcomers(1), { ...player('d00', 50), bbUnresolved: true }, ...regulars(4)];
    const p = plan(pool);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].bb).toBe('d00');
    expect(seated(p).has('n00')).toBe(false);
  });

  it('is always on: the live config can only say big_blind', () => {
    expect(LIGHTNING_MATCHER_PARAM_DEFAULTS.firstEntryRule).toBe('big_blind');
    for (const row of [{}, { first_entry_rule: 'any_seat' }, { first_entry_rule: 7 }, null])
      expect(lightningMatcherParams(row).firstEntryRule).toBe('big_blind');
  });
});

describe('the live SQL plan says the same thing (migration 20261024195059)', () => {
  it('replaces the three live definitions only from their qualified sources, in one short transaction', () => {
    for (const sig of [
      'public.fn_lightning_config(uuid)',
      'public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)',
      'public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)',
    ])
      expect(SQL).toMatch(new RegExp(`\\('${sig.replace(/[()[\]]/g, '\\$&')}', '[0-9a-f]{32}'\\)`));
    expect(SQL).toMatch(/^-- @live-proof: .*NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST/m);
    expect(SQL).toContain("SET LOCAL lock_timeout = '1s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '8s';");
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).not.toMatch(/CREATE\s+(TABLE|INDEX|TYPE|VIEW|TRIGGER|SEQUENCE)/i);
  });

  it('a newcomer is a slot that has never been the big blind, in the plan and the snapshot', () => {
    expect(SQL).toContain("'           (bo.last_bb_at IS NULL) AS newcomer,'");
    expect(SQL).toContain("'''newcomer'',sl.last_bb_at IS NULL,'");
    expect(MODEL).toContain('p.lastBbAtMs === null');
  });

  it('holds newcomers until the big blinds settle, even at the cost of a hand, unless no hand is left', () => {
    expect(PLAN_BLOCK).toContain('LOOP');
    expect(PLAN_BLOCK).toContain('EXIT WHEN v_g = 0;');
    expect(PLAN_BLOCK).toContain('EXIT WHEN cardinality(v_next) = cardinality(v_seatable);');
    expect(PLAN_BLOCK).toContain('EXIT WHEN v_g2 = 0;');
    expect(PLAN_BLOCK).toContain('v_g := v_g2;');
    // The old "only while it costs no hand" condition and the switch are gone.
    expect(PLAN_BLOCK).not.toContain('IF v_g2 = v_g THEN');
    expect(PLAN_BLOCK).not.toContain("v_rule = 'big_blind'");
    expect(SQL).toContain("position('IF v_g2 = v_g THEN' IN n) > 0");
    // The TypeScript port runs the same loop.
    expect(MODEL).toMatch(
      /if \(g === 0\) break;[\s\S]*if \(next\.length === seatable\.length\) break;[\s\S]*if \(g2 === 0\) break;[\s\S]*g = g2;/
    );
    expect(MODEL).not.toMatch(/=== g\) \{\s*seatable = next;/);
  });

  it('the config reports big_blind always and lists any other value as invalid', () => {
    expect(CFG_BLOCK).toContain("v_rule := 'big_blind';");
    expect(CFG_BLOCK).toContain("'first_entry_is_always_big_blind'");
    expect(CFG_BLOCK).not.toContain("v_rule := 'any_seat'");
  });

  it('never reads a horse marker (CLAUDE.md 10.5)', () => {
    for (const src of [SQL, PLAN_BLOCK, CFG_BLOCK]) expect(src).not.toMatch(/is_horse|horse_id/);
    expect(MODEL).not.toMatch(/is_horse|horse_id|isHorse/);
  });
});
