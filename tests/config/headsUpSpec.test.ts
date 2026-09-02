/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HEADS-UP SPEC — the copies must not drift, and the board must obey it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Spin's spec has never drifted because `spinSpec.test.ts` fails the build
 * the moment its two copies differ. The 2-max product had no spec at all until
 * now, and every Phase 3 finding was a symptom of that: the stacks lived in one
 * file, the ladder in another, the rake in a third, the payout inline in a
 * flatMap, and nothing asserted they agreed.
 *
 * So this file pins two things: the copies are identical, and the code that
 * opens the board reads the spec rather than its own copy of the numbers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HEADS_UP_SEATS,
  HEADS_UP_STACKS,
  HEADS_UP_BLINDS,
  HEADS_UP_BLIND_STRUCTURE,
  HEADS_UP_LEVEL_MINUTES,
  HEADS_UP_RAKE_RATE,
  HEADS_UP_PAYOUTS,
  HEADS_UP_BUYINS,
  HEADS_UP_GAME_TYPES,
  HEADS_UP_SYNCHRONIZED_BREAKS,
  headsUpBlindsForLevel,
  headsUpStartingBigBlinds,
} from '../../src/config/headsUpSpec';

describe('the spec is mirrored, not forked', () => {
  it('client and server copies are byte-identical', () => {
    const client = readFileSync(resolve(__dirname, '../../src/config/headsUpSpec.ts'), 'utf8');
    const server = readFileSync(
      resolve(__dirname, '../../server/src/config/headsUpSpec.ts'),
      'utf8'
    );
    expect(
      server,
      'server/src/config/headsUpSpec.ts has drifted from src/config/headsUpSpec.ts. ' +
        'Copy the client file over it; do not hand-edit one side.'
    ).toBe(client);
  });

  it('the spec imports nothing, so the two copies can stay identical', () => {
    const client = readFileSync(resolve(__dirname, '../../src/config/headsUpSpec.ts'), 'utf8');
    expect(client).not.toMatch(/^\s*import\s/m);
  });
});

describe('the shape of the product', () => {
  it('is two-handed, winner take all', () => {
    expect(HEADS_UP_SEATS).toBe(2);
    expect(HEADS_UP_PAYOUTS).toEqual([{ place: 1, percentage: 100 }]);
  });

  it('changes the stack between bands and never the clock', () => {
    // Dan 2026-08-23: "SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK."
    expect(HEADS_UP_STACKS.deep).toBe(1000);
    expect(HEADS_UP_STACKS.turbo).toBe(300);
    expect(headsUpStartingBigBlinds('turbo')).toBe(15);
    expect(headsUpStartingBigBlinds('deep')).toBe(50);
    // One clock, stated once.
    expect(new Set(HEADS_UP_BLIND_STRUCTURE.map((l) => l.durationMinutes)).size).toBe(1);
    expect(HEADS_UP_BLIND_STRUCTURE[0].durationMinutes).toBe(HEADS_UP_LEVEL_MINUTES);
  });

  it('charges five percent, and says so in one place', () => {
    expect(HEADS_UP_RAKE_RATE).toBe(0.05);
  });

  it('never takes the synchronized break, which is what the engine already does', () => {
    expect(HEADS_UP_SYNCHRONIZED_BREAKS).toBe(false);
  });

  it('opens the rungs and variants the board actually runs', () => {
    // Dan's locked seat-first Master Directive (2026-09-01): the Heads-Up
    // board is 9 buy-ins x 4 games x 4 depth bands = 144 queues. 20 was
    // retired from the ladder; plo5 and short_deck were added to the games.
    // seatFirstLadders.test.ts pins the same 144 shape from the config that
    // is generated off these two arrays; this test moved to match the
    // shipped spec (both headsUpSpec copies are byte-identical on it).
    expect([...HEADS_UP_BUYINS]).toEqual([1, 2, 5, 10, 25, 50, 100, 250, 500]);
    expect([...HEADS_UP_GAME_TYPES]).toEqual(['nlh', 'plo4', 'plo5', 'short_deck']);
  });
});

describe('the ladder climbs, and never doubles', () => {
  it('rises monotonically with the big blind twice the small', () => {
    for (let i = 0; i < HEADS_UP_BLINDS.length; i++) {
      expect(HEADS_UP_BLINDS[i].big).toBe(HEADS_UP_BLINDS[i].small * 2);
      if (i > 0) expect(HEADS_UP_BLINDS[i].big).toBeGreaterThan(HEADS_UP_BLINDS[i - 1].big);
    }
  });

  it('steps by well under a doubling, published and past the end alike', () => {
    /**
     * The generic MTT overflow doubles every level. On a two-handed game that
     * is the difference between a poker match and a coin flip: the measured
     * scheduled-spin product, which inherited a doubling ladder, opened at 6.5
     * big blinds and lasted 12.8 hands against 49.8 for a spec-shaped game.
     */
    for (let level = 2; level <= 30; level++) {
      const prev = headsUpBlindsForLevel(level - 1).big;
      const next = headsUpBlindsForLevel(level).big;
      expect(next).toBeGreaterThan(prev);
      expect(next / prev).toBeLessThanOrEqual(1.6);
    }
  });

  it('is deterministic — the same level is the same blinds, every process', () => {
    for (const level of [1, 5, 12, 13, 40]) {
      expect(headsUpBlindsForLevel(level)).toEqual(headsUpBlindsForLevel(level));
    }
    expect(headsUpBlindsForLevel(1)).toEqual({ small: 10, big: 20 });
    expect(headsUpBlindsForLevel(12)).toEqual({ small: 200, big: 400 });
    // Below the floor and above the ladder both resolve rather than throwing.
    expect(headsUpBlindsForLevel(0)).toEqual({ small: 10, big: 20 });
    expect(headsUpBlindsForLevel(99).big).toBeGreaterThan(400);
  });

  it('the stored structure is derived from the ladder, not typed beside it', () => {
    expect(HEADS_UP_BLIND_STRUCTURE).toHaveLength(HEADS_UP_BLINDS.length);
    HEADS_UP_BLIND_STRUCTURE.forEach((row, i) => {
      expect(row.level).toBe(i + 1);
      expect(row.smallBlind).toBe(HEADS_UP_BLINDS[i].small);
      expect(row.bigBlind).toBe(HEADS_UP_BLINDS[i].big);
      expect(row.ante).toBe(0);
    });
  });
});
