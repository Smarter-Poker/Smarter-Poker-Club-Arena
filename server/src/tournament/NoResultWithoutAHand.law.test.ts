/**
 * NO RESULT WITHOUT A HAND (2026-09-01, Phase 7 of the MTT payout audit).
 *
 * Every pin below is a tournament that actually shipped a fabricated podium.
 * Between 2026-08-15 and 2026-08-30 the stuck-COMPLETING rescue ranked seven
 * events end to end with `hand_history` empty and every survivor holding
 * exactly `starting_chips`, stamping one arbitrary row `winner` and the entire
 * rest of the field `eliminated` with a finishing place. 775.00 chips were
 * disbursed against those orders. Two of the seven had 313 and 326 entrants.
 *
 * If a change turns one of these red, it is re-shipping that. Fix the change;
 * never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  chipsCannotRank,
  noHandWasEverDealt,
  HAND_EVIDENCE_WINDOW_DAYS,
} from './recoveryRankEvidence.js';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

const DAY = 86_400_000;

describe('the chips sort must actually sort', () => {
  it('refuses a field where every survivor holds the identical stack', () => {
    // All-In or Fold Frenzy, 2026-08-23: 16 entrants, all on 3000, 15 of them
    // stamped eliminated with a place, 32.00 paid out, no hand ever dealt.
    const field = Array.from({ length: 16 }, () => ({ chips: 3000 }));
    expect(chipsCannotRank(field)).toBe(true);
  });

  it('refuses the two 300-plus freerolls that paid nobody but ranked everybody', () => {
    expect(chipsCannotRank(Array.from({ length: 313 }, () => ({ chips: 5000 })))).toBe(true);
    expect(chipsCannotRank(Array.from({ length: 326 }, () => ({ chips: 5000 })))).toBe(true);
  });

  it('allows a real finish, where the chips distinguish the survivors', () => {
    expect(chipsCannotRank([{ chips: 120_000 }, { chips: 41_500 }, { chips: 9_800 }])).toBe(false);
    // One chip of difference is still a result.
    expect(chipsCannotRank([{ chips: 3001 }, { chips: 3000 }])).toBe(false);
  });

  it('never blocks the lone-survivor rescue this path exists to perform', () => {
    expect(chipsCannotRank([{ chips: 5000 }])).toBe(false);
    expect(chipsCannotRank([])).toBe(false);
  });

  it('treats an unwritten chip column as a value, not as missing evidence', () => {
    // A whole field of nulls is identical, and identical is refused. Dropping
    // them instead would have made a field of unwritten stacks look rankable.
    expect(chipsCannotRank([{ chips: null }, { chips: null }, { chips: null }])).toBe(true);
    expect(chipsCannotRank([{ chips: null }, { chips: 5000 }])).toBe(false);
  });
});

describe('and no hand was dealt at all', () => {
  const start = Date.parse('2026-08-30T23:01:22.298Z');

  it('refuses a recent event with an empty hand history', () => {
    expect(
      noHandWasEverDealt({
        startedAt: new Date(start).toISOString(),
        anyHandDealt: false,
        now: start + 60_000,
      })
    ).toBe(true);
  });

  it('stands down once the horse-only prune could have emptied the history', () => {
    // Past the window an empty hand_history means sp_prune_hand_history ran,
    // not that nothing happened. chipsCannotRank carries the rule from there.
    expect(
      noHandWasEverDealt({
        startedAt: new Date(start).toISOString(),
        anyHandDealt: false,
        now: start + (HAND_EVIDENCE_WINDOW_DAYS + 1) * DAY,
      })
    ).toBe(false);
  });

  it('never refuses an event that dealt', () => {
    expect(
      noHandWasEverDealt({
        startedAt: new Date(start).toISOString(),
        anyHandDealt: true,
        now: start + 60_000,
      })
    ).toBe(false);
  });

  it('refuses an event that never started', () => {
    expect(noHandWasEverDealt({ startedAt: null, anyHandDealt: false })).toBe(true);
  });
});

describe('the guards are wired where they can guard something', () => {
  const src = read('./tournamentRecovery.ts');

  it('both tests run before guarantee funding or the atomic place payment', () => {
    const chipsAt = src.indexOf('if (chipsCannotRank(alive))');
    const handAt = src.indexOf('noHandWasEverDealt({');
    const fundAt = src.indexOf("'fn_apply_prize_guarantee'");
    // The atomic settler is now the only normal place-money marker.
    const payAt = src.indexOf('settleTournamentPlacesAtomically(');
    expect(chipsAt).toBeGreaterThan(-1);
    expect(handAt).toBeGreaterThan(-1);
    expect(fundAt).toBeGreaterThan(-1);
    expect(payAt).toBeGreaterThan(-1);
    expect(chipsAt).toBeLessThan(fundAt);
    expect(handAt).toBeLessThan(fundAt);
    expect(chipsAt).toBeLessThan(payAt);
    expect(handAt).toBeLessThan(payAt);
  });

  it('each refusal is reported under its own name', () => {
    expect(src).toContain('GameServer.recoverStuckCompleting_chips_cannot_rank');
    expect(src).toContain('GameServer.recoverStuckCompleting_no_hand_ever_dealt');
    expect(src).toContain('GameServer.recoverStuckCompleting_hand_evidence_unreadable');
  });

  it('an unreadable hand list pays nobody rather than reading as no hands', () => {
    const handErrAt = src.indexOf('recoverStuckCompleting_hand_evidence_unreadable');
    const block = src.slice(Math.max(0, handErrAt - 600), handErrAt);
    expect(block).toContain('if (handErr)');
  });

  it('started_at is selected, or the hand window cannot be evaluated', () => {
    expect(src).toMatch(/spin_multiplier, started_at/);
  });

  it('the older guards it backs up are still in place', () => {
    // Phase 7 adds to these two, it does not replace them.
    expect(src).toContain('GameServer.recoverStuckCompleting_no_dealt_in_survivor');
    expect(src).toContain('fieldIsStillLive({ livePlayers, paidPlaces })');
  });
});
