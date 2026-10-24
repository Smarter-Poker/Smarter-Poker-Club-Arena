/**
 * LAW: A SEAT THE CONVERSION MADE IS NOT A NEWCOMER, AND A NEWCOMER IS THE NEXT
 * BIG BLIND (2026-10-24, migration 20261024213844).
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST." 20261024195059 holds
 * a newcomer - a pool slot that has never been the big blind - who is not one
 * of the pass's big blinds. Pool slots belong to a Cluster epoch, so right
 * after a game converts to Lightning every slot is new, and:
 *
 *   - players who were already seated at the tables were held as if they had
 *     just bought in, so the first minutes of a converted game dealt
 *     five-handed hands after the three-second wait, or nothing;
 *   - a player who really did just buy in was behind every one of those
 *     never-the-big-blind conversion seats in the blind order (the debt-age
 *     tie-break favours the older slot), and was held pass after pass.
 *
 * The rule now, in fn_lightning_blind_order, fn_lightning_match_plan and
 * fn_lightning_matcher_snapshot, and in the TypeScript port
 * (LightningMatcherModel):
 *
 *   - a CONVERSION SEAT (cash session opened before the epoch began; pool
 *     session and slot entered with the conversion) is not a newcomer, so it
 *     is never held;
 *   - a NEWCOMER leads the blind order after an unresolved obligation, so a
 *     held newcomer is the very next big blind;
 *   - in a settled pool the blind order is exactly the old one;
 *   - the snapshot's `newcomer` flag can only exempt: the port still requires
 *     `lastBbAtMs === null`.
 *
 * Horses are players (CLAUDE.md 10.5): nothing here reads a horse marker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareBlindOrder,
  isLightningNewcomer,
  lightningMatcherModel,
  lightningMatcherParams,
  type LightningMatchPlan,
  type LightningPoolPlayer,
} from './LightningMatcherModel.js';
import { runLightningMatcherSim, seededRandom } from './LightningMatcherSim.js';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(
  join(
    ROOT,
    'supabase',
    'migrations',
    '20261024213844_lightning_conversion_seats_are_not_newcomers_and_a_newcomer_.sql'
  ),
  'utf8'
);
const MODEL = readFileSync(join(__dirname, 'LightningMatcherModel.ts'), 'utf8');
const EXPR = SQL.slice(SQL.indexOf('$expr$') + 6, SQL.lastIndexOf('$expr$'));

const NOW = 1_000_000;

type Kind = 'regular' | 'conversion' | 'newcomer';
/** A legal, long-idle pool player of one kind. */
function player(id: string, kind: Kind, extra: Partial<LightningPoolPlayer> = {}) {
  return {
    playerId: id,
    legal: true,
    reasonCode: null,
    idleSinceMs: 0,
    enteredAtMs: kind === 'newcomer' ? 500 : 0,
    joinedAtMs: kind === 'newcomer' ? 500 : 0,
    // A newcomer's slot opened after the conversion's, so the old debt-age
    // tie-break put every conversion seat ahead of it.
    slotOpenedAtMs: kind === 'newcomer' ? 500 : 0,
    lastBbAtMs: kind === 'regular' ? 100 : null,
    bbUnresolved: false,
    debtSinceMs: kind === 'newcomer' ? 500 : 0,
    handsSinceBb: kind === 'regular' ? 3 : null,
    newcomer: kind === 'newcomer',
    positions: { btn: 0, co: 0, hj: 0, utg: 0 },
    ...extra,
  } satisfies LightningPoolPlayer;
}
const many = (n: number, kind: Kind, prefix: string) =>
  Array.from({ length: n }, (_, i) => player(`${prefix}${String(i).padStart(2, '0')}`, kind));

const VERSIONS = ['m1', 'm1-port', 'm2'];
function plan(players: LightningPoolPlayer[], version = 'm1'): LightningMatchPlan {
  return lightningMatcherModel(version)!.plan(
    { nowMs: NOW, players, recentHands: [] },
    lightningMatcherParams({})
  );
}
const seated = (p: LightningMatchPlan) => new Set(p.groups.flatMap((g) => g.players));
const offTheBigBlind = (p: LightningMatchPlan, pool: LightningPoolPlayer[]) => {
  const nc = new Set(pool.filter(isLightningNewcomer).map((x) => x.playerId));
  return p.groups.flatMap((g) => g.players.slice(1)).filter((id) => nc.has(id));
};

/** The blind order before 20261024213844, for the settled-pool comparison. */
function previousBlindOrder(a: LightningPoolPlayer, b: LightningPoolPlayer): number {
  if (a.bbUnresolved !== b.bbUnresolved) return a.bbUnresolved ? -1 : 1;
  if (a.lastBbAtMs !== b.lastBbAtMs) {
    if (a.lastBbAtMs === null) return -1;
    if (b.lastBbAtMs === null) return 1;
    return a.lastBbAtMs - b.lastBbAtMs;
  }
  if (a.debtSinceMs !== b.debtSinceMs) return a.debtSinceMs - b.debtSinceMs;
  const sa = a.slotOpenedAtMs ?? a.enteredAtMs;
  const sb = b.slotOpenedAtMs ?? b.enteredAtMs;
  if (sa !== sb) return sa - sb;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

describe('a seat the conversion made is not a newcomer', () => {
  it.each(VERSIONS)('deals conversion seats at once instead of holding them (%s)', (v) => {
    // Four regulars and three conversion seats, all never-the-big-blind-yet:
    // a full six now. Holding the conversion seats (the 20261024195059 key
    // alone) left five, which waits for the sixth, and kept two of them out.
    const pool = [...many(4, 'regular', 'r'), ...many(3, 'conversion', 'c')];
    const p = plan(pool, v);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].players).toHaveLength(6);
    expect(offTheBigBlind(p, pool)).toEqual([]);
  });

  it.each(VERSIONS)(
    'a player who bought in after the conversion is the big blind of the very next hand (%s)',
    (v) => {
      // Twenty conversion seats that have not been the big blind yet, one real
      // newcomer whose slot is younger than all of them.
      const pool = [...many(20, 'conversion', 'c'), player('n00', 'newcomer')];
      const p = plan(pool, v);
      expect(p.groups.length).toBeGreaterThan(0);
      expect(p.groups[0].bb).toBe('n00');
      expect(offTheBigBlind(p, pool)).toEqual([]);
    }
  );

  it.each(VERSIONS)(
    'with five or more conversion seats and regulars, no newcomer is dealt off the big blind (%s)',
    (v) => {
      // (Fewer than five others is the 20261024195059 exception: a hold that
      // would leave the pass no hand is not taken.)
      const rand = seededRandom(20261024213844 % 2 ** 31);
      for (let trial = 0; trial < 400; trial++) {
        const conv = Math.floor(rand() * 20);
        const pool = [
          ...many(Math.floor(rand() * 6), 'newcomer', 'n'),
          ...many(conv, 'conversion', 'c'),
          ...many(Math.max(0, 5 - conv) + Math.floor(rand() * 20), 'regular', 'r'),
        ].map((x) => ({
          ...x,
          idleSinceMs: Math.floor(rand() * 10_000) - 20_000,
          lastBbAtMs: x.lastBbAtMs === null ? null : Math.floor(rand() * 10_000),
          bbUnresolved: x.lastBbAtMs !== null && rand() < 0.1,
        }));
        const p = plan(pool, v);
        expect(offTheBigBlind(p, pool), `trial ${trial}`).toEqual([]);
        for (const g of p.groups) expect([5, 6]).toContain(g.players.length);
        expect(seated(p).size).toBe(p.groups.reduce((s, g) => s + g.players.length, 0));
        // Conversion seats and regulars together make a hand whenever five can sit.
        if (pool.filter((x) => !isLightningNewcomer(x)).length >= 6)
          expect(p.groups.length, `trial ${trial}`).toBeGreaterThan(0);
      }
    }
  );

  it('the blind order: an unresolved obligation, then a newcomer, then the old keys', () => {
    const debtor = { ...player('d00', 'regular'), bbUnresolved: true };
    const nc = player('n00', 'newcomer');
    const conv = player('c00', 'conversion');
    const reg = player('r00', 'regular');
    expect([reg, conv, nc, debtor].sort(compareBlindOrder).map((p) => p.playerId)).toEqual([
      'd00',
      'n00',
      'c00',
      'r00',
    ]);
  });

  it('in a settled pool the blind order is exactly the previous one', () => {
    const rand = seededRandom(7);
    for (let trial = 0; trial < 200; trial++) {
      // No conversion seats: newcomer === never the big blind, as before.
      const pool = Array.from({ length: 30 }, (_, i) => {
        const fresh = rand() < 0.2;
        return player(`p${String(i).padStart(2, '0')}`, fresh ? 'newcomer' : 'regular', {
          lastBbAtMs: fresh ? null : Math.floor(rand() * 50),
          debtSinceMs: Math.floor(rand() * 5),
          slotOpenedAtMs: Math.floor(rand() * 5),
          bbUnresolved: !fresh && rand() < 0.1,
        });
      });
      expect([...pool].sort(compareBlindOrder)).toEqual([...pool].sort(previousBlindOrder));
    }
  });

  it('the stored flag can only exempt; it never makes a newcomer of a slot that has been the big blind', () => {
    expect(isLightningNewcomer(player('x', 'conversion'))).toBe(false);
    expect(isLightningNewcomer(player('x', 'newcomer'))).toBe(true);
    expect(isLightningNewcomer({ ...player('x', 'regular'), newcomer: true })).toBe(false);
  });

  it('the simulator: after a conversion, waits are no longer than holding every seat', () => {
    const opts = {
      players: 24,
      hands: 40,
      version: 'm1',
      instanceMin: 5,
      instanceTarget: 6,
      instanceMax: 6,
      foldRate: 0.6,
      passIntervalMs: 250,
      arrivalsPerMin: 1,
    };
    let held = 0;
    let exempt = 0;
    for (let seed = 1; seed <= 10; seed++) {
      held += runLightningMatcherSim({ ...opts, seed, conversionSeating: false }).wait_ms.p95!;
      exempt += runLightningMatcherSim({ ...opts, seed, conversionSeating: true }).wait_ms.p95!;
    }
    expect(exempt).toBeLessThan(held);
  });
});

describe('the live SQL says the same thing (migration 20261024213844)', () => {
  it('replaces three live definitions only from their qualified sources, in one short transaction', () => {
    for (const sig of [
      'public.fn_lightning_blind_order(uuid,integer,uuid[])',
      'public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)',
      'public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)',
    ])
      expect(SQL).toMatch(new RegExp(`\\('${sig.replace(/[()[\]]/g, '\\$&')}', '[0-9a-f]{32}'\\)`));
    expect(SQL).toMatch(/^-- @live-proof: .*LIGHTNING_CONVERSION_SEAT/m);
    expect(SQL).toContain("SET LOCAL lock_timeout = '1s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '8s';");
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).not.toMatch(/CREATE\s+(TABLE|INDEX|TYPE|VIEW|TRIGGER|SEQUENCE)/i);
  });

  it('one conversion-seat expression, written once and given to all three readers', () => {
    expect(EXPR).toContain('sl.last_bb_at IS NULL AND NOT coalesce(');
    expect(EXPR).toContain('LIGHTNING_CONVERSION_SEAT');
    expect(EXPR).toContain('cs_cps.opened_at < cs_ep.started_at');
    expect(EXPR).toContain("cs_ps.entered_at < cs_ep.started_at + interval '5 seconds'");
    expect(EXPR).toContain("sl.opened_at < cs_ep.started_at + interval '5 seconds'");
    expect(EXPR).toContain('cs_ep.cluster_id = sl.cluster_id AND cs_ep.epoch = sl.cluster_epoch');
    expect(SQL.split('v_newcomer').length - 1).toBe(4); // declared once, used three times
    // The blind order puts it after the unresolved obligation and before last_bb_at.
    const order = SQL.indexOf("' || v_newcomer || E' DESC,\\n'");
    expect(order).toBeGreaterThan(SQL.lastIndexOf('bb_owed, 0) > 0) DESC,', order));
    expect(SQL.indexOf('sl.last_bb_at ASC NULLS FIRST,', order)).toBeGreaterThan(order);
    expect(SQL).toContain("' || v_newcomer || E' AS newcomer,\\n'");
    expect(SQL).toContain("'''newcomer'',' || v_newcomer || ','");
  });

  it('the TypeScript port reads the same key and ranks it the same way', () => {
    expect(MODEL).toContain('p.lastBbAtMs === null && p.newcomer');
    expect(MODEL).toMatch(
      /if \(a\.bbUnresolved !== b\.bbUnresolved\) return a\.bbUnresolved \? -1 : 1;\s*const na = isLightningNewcomer\(a\);\s*const nb = isLightningNewcomer\(b\);\s*if \(na !== nb\) return na \? -1 : 1;/
    );
  });

  it('never reads a horse marker (CLAUDE.md 10.5)', () => {
    expect(SQL).not.toMatch(/is_horse|horse_id/);
    expect(MODEL).not.toMatch(/is_horse|horse_id|isHorse/);
  });
});
