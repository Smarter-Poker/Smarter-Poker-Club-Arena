/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SPEC NOTHING READS IS A DOCUMENT, NOT A GUARDRAIL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * headsUpSpec.ts only stops drift if the code that opens the boards reads it.
 * These pins are the difference between a source of truth and a fourth copy of
 * the numbers.
 *
 * They also pin the Phase 3 headline, which was NOT a heads-up bug at all:
 * `ScheduledTournamentService` could stamp `tournament_type = 'SPIN'` on a row
 * built from any named blind preset. One active schedule does exactly that
 * ("Spin Royale", every 30 minutes, `blindPreset: "HYPER_TURBO"`), and every
 * one of its 96 completed games over three days opened at big blind 100 with a
 * 300-chip stack -- 3.7 big blinds, 12.7 hands, against 19.3 and 49.8 for a
 * spec-shaped Spin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock, sliceStatement } from '../helpers/sourceWindow';
import { HEADS_UP_RAKE_RATE, HEADS_UP_SEATS, HEADS_UP_STACKS } from '../../src/config/headsUpSpec';
import { HEADS_UP_RAKE_RATE as BUYIN_HEADS_UP_RATE } from '../../src/utils/buyIn';

const RECURRING = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const SCHEDULED = readFileSync(
  resolve(__dirname, '../../server/src/services/ScheduledTournamentService.ts'),
  'utf8'
);

describe('the always-on duel board reads the spec', () => {
  it('takes both stacks, the seats, the rungs and the variants from it', () => {
    expect(RECURRING).toMatch(/from '\.\.\/config\/headsUpSpec\.js'/);
    expect(RECURRING).toMatch(/startingStack: HEADS_UP_STACKS\.deep/);
    expect(RECURRING).toMatch(/startingStack: HEADS_UP_STACKS\.turbo/);
    expect(RECURRING).toMatch(/seats: HEADS_UP_SEATS/);
    expect(RECURRING).toMatch(/const SNG_BOARD_BUYINS = \[\.\.\.HEADS_UP_BUYINS\]/);
    expect(RECURRING).toMatch(/HEADS_UP_GAME_TYPES\.map/);
  });

  it('no longer carries a second hand-typed copy of the ladder', () => {
    expect(RECURRING).toMatch(/HEADS_UP_3MIN: HEADS_UP_BLIND_STRUCTURE/);
    // The 12 rows must exist in exactly one place: the spec.
    expect(RECURRING).not.toMatch(/level: 11, smallBlind: 150, bigBlind: 300/);
  });

  it('the dead Spin ladder that contradicted spinSpec is gone', () => {
    // It said 25/50 at level 3 where the spec says 20/40, and claimed a
    // two-minute clock the spec sets at three.
    // Named only in the note that records its removal, never as an expression.
    const code = RECURRING.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/BLIND_STRUCTURES\.SPIN\b/);
    expect(code).not.toMatch(/level: 3, smallBlind: 25, bigBlind: 50/);
  });

  it('states the rake once — buyIn.ts and the spec cannot disagree', () => {
    expect(BUYIN_HEADS_UP_RATE).toBe(HEADS_UP_RAKE_RATE);
    expect(HEADS_UP_RAKE_RATE).toBe(0.05);
  });
});

describe('a scheduled row cannot invent a Spin', () => {
  it('forces the spec ladder and winner-take-all onto anything typed SPIN', () => {
    const block = sliceEnclosingBlock(SCHEDULED, 'const placeholderTier = SPIN_TIERS[0];');
    expect(block).toMatch(/spinBlindsForLevel\(i \+ 1\)/);
    expect(block).toMatch(/ante: 0/);
    expect(block).toMatch(/duration: placeholderTier\.levelMinutes \* 60/);
  });

  it('forces the heads-up ladder onto a two-seat scheduled SNG', () => {
    expect(SCHEDULED).toMatch(/blinds = HEADS_UP_BLIND_STRUCTURE/);
    expect(SCHEDULED).toMatch(/payouts = HEADS_UP_PAYOUTS/);
  });

  it('takes the seat count from the format, not from the schedule config', () => {
    const stmt = sliceStatement(SCHEDULED, 'const maxPlayers = isSpin');
    expect(stmt).toMatch(/SPIN_SEATS/);
    expect(stmt).toMatch(/HEADS_UP_SEATS/);
    // The old line let a config say a Spin was any size at all.
    expect(SCHEDULED).not.toMatch(/\|\| \(isSpin \? 3 : isSng \? 6 : 100\)/);
  });

  it('re-cuts a restarted clone at the format rate, not a flat ten percent', () => {
    const block = sliceEnclosingBlock(SCHEDULED, 'const cloneRate = rakeRateFor({');
    expect(block).toMatch(/total \* cloneRate/);
    expect(SCHEDULED).not.toMatch(/Math\.floor\(total \* 0\.1 \* 100/);
  });
});

describe('the row agrees with the engine about breaks', () => {
  it('a scheduled Spin or duel is written synchronized_breaks false', () => {
    // breakEligibility.ts refuses the :55 break on FORMAT for both, whatever
    // the column says. The column now says the same thing rather than the
    // opposite, so nobody reading the row reaches the wrong conclusion.
    const block = sliceEnclosingBlock(SCHEDULED, 'synchronized_breaks:');
    expect(block).toMatch(/isSpin \|\| isSng/);
  });
});

describe('the numbers the spec claims are the numbers the product runs', () => {
  it('two seats, 1000 deep and 300 turbo', () => {
    expect(HEADS_UP_SEATS).toBe(2);
    expect(HEADS_UP_STACKS).toEqual({ deep: 1000, turbo: 300 });
  });
});
