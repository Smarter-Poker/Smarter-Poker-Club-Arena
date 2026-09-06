/**
 * A BAND WITH NO GAME GETS NO HORSES (2026-09-06).
 *
 * Dan, verbatim: "THATS FINE, WE DON'T NEED ANY GAME OVER 2/5 RIGHT NOW."
 *
 * Measured on production the same day: 100 horses held the band 'high' and
 * there was not one enabled cash game with bb > 6 anywhere on the platform.
 * `stakeBandAllows` is a hard gate, so a tenth of the fleet could sit NOWHERE.
 *
 * There are two halves to the answer and they have to say the same thing:
 *
 *   SQL     `fn_assign_horse_stake_bands` projects the merit ladder onto the
 *           bands that have an enabled game, so the assignment never mints a
 *           horse into an empty band. Migration 20260906093032.
 *   ENGINE  `projectStakeBandOnto` seats a horse one band down when its band
 *           has no game this cycle. PR #3224. It covers the window between an
 *           operator closing a game and the next assignment run.
 *
 * Every case below pins one of them, or pins that they agree.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STAKE_BAND_LADDER,
  projectStakeBandOnto,
  effectiveStakeBandFor,
  applyStakeBandSupply,
  setHorseStakeBands,
  clearHorseStakeBands,
  clearStakeBandSupply,
  stakeBandAllows,
  stakeBandForBigBlind,
  type HorseStakeBand,
} from './HorseBehavior.js';

const ord = (b: HorseStakeBand) => STAKE_BAND_LADDER.indexOf(b);

/** All 16 shapes the floor can take, including the empty one. */
function allFloors(): Array<Set<HorseStakeBand>> {
  const out: Array<Set<HorseStakeBand>> = [];
  for (let mask = 0; mask < 1 << STAKE_BAND_LADDER.length; mask++) {
    const s = new Set<HorseStakeBand>();
    STAKE_BAND_LADDER.forEach((b, i) => {
      if (mask & (1 << i)) s.add(b);
    });
    out.push(s);
  }
  return out;
}

const MIGRATION = readFileSync(
  new URL(
    '../../../supabase/migrations/20260906093032_a_band_with_no_game_gets_no_horses.sql',
    import.meta.url
  ).pathname,
  'utf8'
);

describe('the projection: merit decides the order, the floor decides which rungs exist', () => {
  it('a band with a game keeps its horses', () => {
    for (const floor of allFloors()) {
      for (const band of STAKE_BAND_LADDER) {
        if (floor.has(band)) expect(projectStakeBandOnto(band, floor)).toBe(band);
      }
    }
  });

  it('DOWNWARD ONLY: no horse is ever projected into a bigger game than it earned', () => {
    for (const floor of allFloors()) {
      for (const band of STAKE_BAND_LADDER) {
        expect(ord(projectStakeBandOnto(band, floor))).toBeLessThanOrEqual(ord(band));
      }
    }
  });

  it('the result is a band that has a game, unless nothing at or below it does', () => {
    for (const floor of allFloors()) {
      if (floor.size === 0) continue;
      for (const band of STAKE_BAND_LADDER) {
        const got = projectStakeBandOnto(band, floor);
        if (floor.has(got)) continue;
        // The only sanctioned exception: every open game is ABOVE this horse,
        // so it stays where it is rather than being promoted into one.
        expect(got).toBe(band);
        for (const b of floor) expect(ord(b)).toBeGreaterThan(ord(band));
      }
    }
  });

  it('MERIT ORDER IS PRESERVED: two horses never swap places, a rung is folded into the one below', () => {
    for (const floor of allFloors()) {
      // A fleet ranked worst to best, one horse per rung, in merit order.
      const projected = STAKE_BAND_LADDER.map((b) => ord(projectStakeBandOnto(b, floor)));
      for (let i = 1; i < projected.length; i++) {
        expect(projected[i]).toBeGreaterThanOrEqual(projected[i - 1]);
      }
    }
  });

  it('IDEMPOTENT: projecting an already projected band changes nothing', () => {
    for (const floor of allFloors()) {
      for (const band of STAKE_BAND_LADDER) {
        const once = projectStakeBandOnto(band, floor);
        expect(projectStakeBandOnto(once, floor)).toBe(once);
      }
    }
  });

  it('FAILS OPEN: an unread floor is not an empty one', () => {
    for (const band of STAKE_BAND_LADDER) {
      expect(projectStakeBandOnto(band, null)).toBe(band);
      expect(projectStakeBandOnto(band, undefined)).toBe(band);
      expect(projectStakeBandOnto(band, new Set())).toBe(band);
    }
  });

  it("TODAY'S FLOOR: with no game over 2/5, mid is the top band and high receives nobody", () => {
    // bb 5 is 2/5, the largest enabled game on 2026-09-06.
    const floor = new Set<HorseStakeBand>(
      [0.1, 0.5, 1, 2, 5].map((bb) => stakeBandForBigBlind(bb))
    );
    expect([...floor].sort()).toEqual(['low', 'micro', 'mid']);
    const landed = new Set(STAKE_BAND_LADDER.map((b) => projectStakeBandOnto(b, floor)));
    expect(landed.has('high')).toBe(false);
    expect(projectStakeBandOnto('high', floor)).toBe('mid');
    expect(projectStakeBandOnto('micro', floor)).toBe('micro');
  });
});

describe('the two halves agree: what the SQL will not mint, the engine will not seat', () => {
  beforeEach(() => {
    clearStakeBandSupply();
    clearHorseStakeBands();
  });

  it('the engine seating gate is the projection, applied to the assigned band', () => {
    setHorseStakeBands([
      { id: 'nosebleed', stakeBand: 'high' },
      { id: 'midstakes', stakeBand: 'mid' },
      { id: 'regular', stakeBand: 'low' },
      { id: 'grinder', stakeBand: 'micro' },
    ]);
    for (const floor of allFloors()) {
      applyStakeBandSupply(floor);
      for (const [id, band] of [
        ['nosebleed', 'high'],
        ['midstakes', 'mid'],
        ['regular', 'low'],
        ['grinder', 'micro'],
      ] as Array<[string, HorseStakeBand]>) {
        expect(effectiveStakeBandFor(id)).toBe(projectStakeBandOnto(band, floor));
      }
    }
  });

  it('a band with no game receives no horses from the SQL AND is skipped by the engine', () => {
    // The SQL half: the assignment projects, so nothing lands in 'high'.
    const floor = new Set<HorseStakeBand>(['micro', 'low', 'mid']);
    for (const band of STAKE_BAND_LADDER) {
      expect(projectStakeBandOnto(band, floor)).not.toBe('high');
    }
    // The engine half: a horse still holding the closed band seats one down,
    // and is refused every game in the band that has no table.
    setHorseStakeBands([{ id: 'stranded', stakeBand: 'high' }]);
    const report = applyStakeBandSupply(floor);
    expect(report.missing).toEqual(['high']);
    expect(report.fallbacks).toBe(1);
    expect(effectiveStakeBandFor('stranded')).toBe('mid');
    expect(stakeBandAllows('stranded', 5)).toBe(true); // 2/5, the top open game
    expect(stakeBandAllows('stranded', 10)).toBe(false); // 5/10, closed
    expect(stakeBandAllows('stranded', 1)).toBe(false); // still not a 0.50/1 name
  });
});

describe('the SQL half is actually written that way', () => {
  it('availability is READ from cash_games, never a constant', () => {
    expect(MIGRATION).toContain('CREATE OR REPLACE FUNCTION public.fn_available_stake_bands()');
    expect(MIGRATION).toContain('FROM public.cash_games cg');
    expect(MIGRATION).toContain('WHERE cg.enabled IS TRUE');
    expect(MIGRATION).toContain('public.fn_cash_stake_band(cg.bb)');
  });

  it('the assignment projects the merit band, and clamps again after hysteresis', () => {
    expect(MIGRATION).toContain('public.fn_project_stake_band(merit_band, v_available) as want');
    // Hysteresis holds a horse in the band it already has, and that band may be
    // one the operator has since closed. The clamp is what stops it surviving.
    expect(MIGRATION).toContain(
      'public.fn_project_stake_band(settled_band, v_available) as final_band'
    );
  });

  it('the SQL projection walks DOWN the ladder only', () => {
    expect(MIGRATION).toContain('WHERE a.ord <= w.ord');
    expect(MIGRATION).toContain('ORDER BY a.ord DESC');
    // An upward search would read a.ord >= or a.ord > w.ord. There must not be
    // one: promoting a micro grinder into a big game is the direction a
    // watching player notices.
    expect(MIGRATION).not.toMatch(/a\.ord\s*>=?\s*w\.ord/);
  });

  it('an empty floor changes nothing rather than emptying the fleet', () => {
    expect(MIGRATION).toContain('if coalesce(array_length(v_available, 1), 0) = 0 then');
    expect(MIGRATION).toContain('return;');
  });

  it('the merit ranking itself is untouched: same metric, same floor, same cut points', () => {
    expect(MIGRATION).toContain('when merit_pct <  22 then');
    expect(MIGRATION).toContain('when merit_pct <  74 then');
    expect(MIGRATION).toContain('when merit_pct <  89 then');
    expect(MIGRATION).toContain('sum(ps.sum_big_blind)');
    expect(MIGRATION).toContain('p_min_hands integer DEFAULT 1000');
  });

  it('it is one transaction, per the production DDL policy', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)?.length).toBe(1);
  });

  it('the ladder in SQL is the ladder in TypeScript, in the same order', () => {
    expect(MIGRATION).toContain("VALUES ('micro', 1), ('low', 2), ('mid', 3), ('high', 4)");
    expect([...STAKE_BAND_LADDER]).toEqual(['micro', 'low', 'mid', 'high']);
  });
});
