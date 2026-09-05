/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BANKROLL CHOOSES THE STAKE (Dan, 2026-09-05, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "horses aren't supposed to have 'preferred game types' they
 * are supposed to play off of there 'bankroll management laws' and rules first
 * and foremost. THATS THE STARTING POINT."
 *
 * WHAT WAS ACTUALLY RUNNING. This repo has a complete bankroll management law
 * in HorseBankroll.ts - sit, move up, move down, top up, buy-in sizing, stop
 * win, stop loss, three temperaments. On the morning of 2026-09-05 a grep for
 * callers outside that file and its own unit test returned:
 *
 *     canSit             3
 *     canMoveUp          0
 *     shouldMoveDown     0
 *     bestAffordableGame 0
 *     topUpDecision      0
 *
 * Four of the seven rules had never run in production. The one that did ran as
 * a VETO, and it ran AFTER the stake had already been chosen - by
 * `assignPreferredStakes`, which is `shHash(horseId, 'stake-band', seed) % 100`.
 * Money could object to a hash's choice. It could not make one.
 *
 * The cost, read from the live database that morning:
 *
 *     venom          4,759,025 chips   playing 0.25/0.50    95,180 buy-ins deep
 *     foldto3b f3b   3,843,526 chips   playing 0.10/0.25   153,741 buy-ins deep
 *     falcon           755,647 chips   playing 0.05/0.10    75,565 buy-ins deep
 *
 * and across the 116 seated horses holding more than 20,980 chips, the mean
 * big blind played was 0.535.
 *
 * THE LAW.
 *   1. The stake window is derived from the ROLL, by the ladder, with the
 *      move-up cushion when the step is upward.
 *   2. It is still TWO RUNGS, because Dan's 2026-08-29 ruling that a horse
 *      plays one stake level is untouched - what changed is that the rungs
 *      follow money that moves rather than a hash that cannot.
 *   3. Broke returns an EMPTY window. It must never fall through to "anything".
 *   4. A tagged preference may never leave a seat empty: the seeding pass runs
 *      strict first and relaxes the tagged variant and rung only when the
 *      strict pool cannot fill the seats. Every hard gate survives both passes.
 *   5. An unreadable roll fails OPEN, the same contract as every other gate in
 *      the seeding loop - reading an unknown roll as zero emptied the cash
 *      floor for forty minutes on 2026-08-31.
 *
 * Registry: docs/laws.d/the-bankroll-chooses-the-stake.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  affordableStakeWindow,
  bankrollAllowsStake,
  bankrollPolicyFor,
  canMoveUp,
  canSit,
  referenceBuyIn,
} from '../server/src/services/HorseBankroll.js';
import { PHASE_MAX_BB, STAKE_LADDER } from '../server/src/services/StableHand.js';

const ROOT = join(__dirname, '..');
const LADDER = STAKE_LADDER.map((s) => s.bb);
const std = bankrollPolicyFor('a-standard-temperament-horse');

describe('the bankroll chooses the stake', () => {
  it('a bigger roll reaches a higher rung, monotonically', () => {
    const top = (roll: number) => {
      const w = affordableStakeWindow(roll, LADDER, std);
      return w.length ? w[w.length - 1] : 0;
    };
    let last = 0;
    for (const roll of [0, 50, 500, 5_000, 50_000, 500_000, 5_000_000]) {
      const t = top(roll);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
    // The whole point: a millionaire does not sit at the bottom rung.
    expect(top(4_759_025)).toBe(Math.max(...LADDER));
    expect(top(4_759_025)).toBeGreaterThan(top(500));
  });

  it('is a TWO-rung window, so a horse still plays one stake level', () => {
    for (const roll of [5_000, 50_000, 4_759_025]) {
      const w = affordableStakeWindow(roll, LADDER, std);
      expect(w.length).toBeLessThanOrEqual(2);
      if (w.length === 2) {
        const i = LADDER.indexOf(w[0]);
        const j = LADDER.indexOf(w[1]);
        expect(j - i).toBe(1); // adjacent rungs, never a scatter
      }
    }
  });

  it('broke returns an empty window and never falls through to anything', () => {
    expect(affordableStakeWindow(0, LADDER, std)).toEqual([]);
    expect(affordableStakeWindow(-5, LADDER, std)).toEqual([]);
    expect(bankrollAllowsStake(0, LADDER[0], LADDER, std)).toBe(false);
  });

  it('honours the move-up cushion when the step is upward', () => {
    // A roll that can SIT at a rung but not MOVE UP into it is held below.
    const rung = LADDER[LADDER.length - 1];
    const ref = referenceBuyIn(rung);
    const roll = ref * ((std.buyInsToSit + std.buyInsToMoveUp) / 2);
    expect(canSit(roll, ref, std)).toBe(true);
    expect(canMoveUp(roll, ref, std)).toBe(false);
    const below = LADDER[LADDER.length - 2];
    expect(bankrollAllowsStake(roll, rung, LADDER, std, below)).toBe(false);
    // Already there: it stays, because staying is canSit and not canMoveUp.
    expect(bankrollAllowsStake(roll, rung, LADDER, std, rung)).toBe(true);
  });

  it('never licenses a rung above the phase clamp', () => {
    /* The ladder stops at PHASE_MAX_BB by construction, so an unlimited roll
       cannot climb past it however rich it is. That ceiling moved from 2 to
       Dan's 25/50 on 2026-09-05 (see
       the-floor-offers-what-it-lets-you-play.law.test.ts) - this assertion is
       about the RELATIONSHIP, which is why it did not need to change with it,
       and it is deliberately written against the constant rather than a
       literal so the next move cannot slip past it either. */
    const w = affordableStakeWindow(Number.MAX_SAFE_INTEGER, LADDER, std);
    expect(Math.max(...w)).toBe(Math.max(...LADDER));
    expect(Math.max(...LADDER)).toBe(PHASE_MAX_BB);
    expect(LADDER.some((bb) => bb > PHASE_MAX_BB)).toBe(false);
  });

  it('the seeding loop asks the ROLL for the stake, not the tag', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    expect(src).toContain('bankrollAllowsStake(');
    expect(src).toContain('STAKE_LADDER_BBS');
    // and it counts a bankroll refusal apart from a tag refusal
    expect(src).toContain('stakeOutOfRollDropped');
  });

  it('an unreadable roll still fails open to the old rule', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    const gate = src.slice(src.indexOf('THE STAKE COMES FROM THE BANKROLL'));
    expect(gate).toContain('if (stakeRoll !== undefined)');
    expect(gate).toContain('tagAllowsStake(tag, tableBb)');
  });

  it('a preference never leaves a seat empty', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    // strict pass first, relaxed only when the strict pool is short
    expect(src).toContain('const passFilter = (relaxPreferences: boolean) =>');
    expect(src).toMatch(/let candidateHorses = passFilter\(false\);/);
    expect(src).toMatch(/if \(candidateHorses\.length < emptySeats\.length\) \{/);
    expect(src).toContain('passFilter(true)');
    // the relaxable gates are the TEXTURE ones, and only those
    expect(src).toMatch(/variantOk === false && !humanNeedsRescue && !relaxPreferences/);
  });

  it('relaxing the texture does not relax a hard gate', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/HorseFleetManager.ts'), 'utf8');
    const pass = src.slice(
      src.indexOf('const passFilter = (relaxPreferences: boolean) =>'),
      src.indexOf('let candidateHorses = passFilter(false);')
    );
    // Every one of these must refuse regardless of the relax flag.
    for (const hard of [
      'clubDropped++',
      'barredDropped++',
      'stakeOutOfRollDropped++',
      'restDayDropped++',
      'dailyCapDropped++',
      'hostCapRefused++',
      'seat_refused_underrolled',
    ]) {
      expect(pass).toContain(hard);
    }
    // ...and none of them may be guarded by relaxPreferences.
    for (const line of pass.split('\n')) {
      if (line.includes('relaxPreferences')) {
        expect(line).toMatch(/variantOk === false|stakeOk === false|relaxPreferences: boolean/);
      }
    }
  });
});
