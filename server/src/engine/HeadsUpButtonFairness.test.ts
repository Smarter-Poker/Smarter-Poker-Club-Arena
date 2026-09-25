/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PHASE 2 -- FAIRNESS IN THE HAND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two defects, both invisible in production statistics because the formats run
 * almost entirely on horses (one human Spin in the 24h before this was
 * written), and both real money:
 *
 *   2.1 The first button at a two-handed table was `buttonSeats[0]` -- the
 *       lowest occupied seat. Seating is seat-first, so that is whoever
 *       arrived first, and heads-up the button IS the small blind.
 *
 *   2.2 When a 3-handed Spin dropped to two the button rotated forward, which
 *       makes the previous big blind post the big blind again. Roughly one in
 *       three Spins reaches heads-up; each one moved a full big blind of EV
 *       from one player to the other.
 *
 * Measured win rate by seat before the fix was 49.94 / 50.06 -- horse against
 * horse cancels the edge out in aggregate, which is exactly why a win-rate
 * query could never have found either of these.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { drawFirstButtonSeat, headsUpButtonSeat, nextOccupiedSeat } from './headsUpButton.js';
import { secureRandomInt } from './CryptoRandom.js';
import { sliceEnclosingBlock, sliceMethod, sliceStatement } from '../testHelpers/sourceWindow.js';

const DEALING = readFileSync(join(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
const BASE = readFileSync(join(__dirname, 'ServerTableEngineBase.ts'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// 2.2 -- the dead button, table-driven over which of three seats busts
// ═══════════════════════════════════════════════════════════════════════════
describe('3-handed to heads-up: nobody posts the big blind twice', () => {
  /**
   * Opening hand is always seats 1/2/3, button on 1: small blind 2, big blind
   * 3. The survivors then play one heads-up hand, and the assertion is the
   * same in every row -- the player who just posted the big blind does not
   * post it again.
   */
  const LAST_BIG_BLIND = 3;

  const cases = [
    { busted: 1, survivors: [2, 3], expectedButton: 3, expectedBigBlind: 2 },
    { busted: 2, survivors: [1, 3], expectedButton: 3, expectedBigBlind: 1 },
    { busted: 3, survivors: [1, 2], expectedButton: 2, expectedBigBlind: 1 },
  ];

  for (const c of cases) {
    it(`seat ${c.busted} busts -> button ${c.expectedButton}, big blind ${c.expectedBigBlind}`, () => {
      const button = headsUpButtonSeat(c.survivors, LAST_BIG_BLIND);
      expect(button).toBe(c.expectedButton);
      // Heads-up the button IS the small blind, so the other seat is the big.
      const bigBlind = c.survivors.find((s) => s !== button);
      expect(bigBlind).toBe(c.expectedBigBlind);
      expect(bigBlind).not.toBe(LAST_BIG_BLIND);
    });
  }

  it('the old rule -- rotate the button forward -- fails the first case', () => {
    // Documents the defect: button 1 busts, the button walks to seat 2, seat 2
    // is therefore the small blind and seat 3 posts the big blind again.
    const rotatedForward = nextOccupiedSeat(1, [2, 3]);
    expect(rotatedForward).toBe(2);
    const bigBlindUnderOldRule = [2, 3].find((s) => s !== rotatedForward);
    expect(bigBlindUnderOldRule).toBe(LAST_BIG_BLIND); // the bug, stated
  });

  it('alternates for as long as the duel runs, and never repeats a big blind', () => {
    const seats = [4, 7];
    let lastBigBlind = 7;
    const seen: number[] = [];
    for (let hand = 0; hand < 20; hand++) {
      const button = headsUpButtonSeat(seats, lastBigBlind)!;
      const bigBlind = seats.find((s) => s !== button)!;
      expect(bigBlind).not.toBe(lastBigBlind);
      seen.push(bigBlind);
      lastBigBlind = bigBlind;
    }
    // Perfect alternation over 20 hands: 10 each.
    expect(seen.filter((s) => s === 4).length).toBe(10);
    expect(seen.filter((s) => s === 7).length).toBe(10);
  });

  it('stands down rather than guessing when there is no previous big blind', () => {
    expect(headsUpButtonSeat([2, 3], 0)).toBeNull();
    expect(headsUpButtonSeat([1, 2, 3], 3)).toBeNull(); // not heads-up
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2.1 -- the first button is drawn
// ═══════════════════════════════════════════════════════════════════════════
describe('the first button at a two-handed table is drawn, not the low seat', () => {
  it('can land on either seat', () => {
    expect(drawFirstButtonSeat([3, 5], () => 0)).toBe(3);
    expect(drawFirstButtonSeat([3, 5], () => 1)).toBe(5);
  });

  it('is not deterministic across many starts', () => {
    // The real generator the engine passes in.
    const counts = new Map<number, number>();
    for (let i = 0; i < 400; i++) {
      const seat = drawFirstButtonSeat([1, 2], secureRandomInt)!;
      counts.set(seat, (counts.get(seat) ?? 0) + 1);
    }
    // Both seats must appear. P(all 400 on one seat) is 2^-399.
    expect(counts.get(1) ?? 0).toBeGreaterThan(0);
    expect(counts.get(2) ?? 0).toBeGreaterThan(0);
    // And neither seat may dominate the way `buttonSeats[0]` did (100%).
    expect(counts.get(1)! / 400).toBeGreaterThan(0.3);
    expect(counts.get(1)! / 400).toBeLessThan(0.7);
  });

  it('a stray index can never fall off the seat list', () => {
    expect(drawFirstButtonSeat([2, 6], () => 99)).toBe(6);
    expect(drawFirstButtonSeat([2, 6], () => -3)).toBe(2);
    expect(drawFirstButtonSeat([], () => 0)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wiring -- the rules above are worthless if the dealing loop does not use them
// ═══════════════════════════════════════════════════════════════════════════
describe('the dealing loop is wired to both rules', () => {
  it('draws the first heads-up button with the crypto generator', () => {
    expect(DEALING).toMatch(/drawFirstButtonSeat\(sortedSeats, secureRandomInt\)/);
  });

  it('persists the drawn button so a restart cannot re-draw it', () => {
    const block = sliceEnclosingBlock(DEALING, 'first_button_seat: headsUpFirstButton', 0, 3);
    expect(block).toMatch(/first_button_seat: headsUpFirstButton/);
    expect(block).toMatch(/from\('tables'\)/);
  });

  it('derives the heads-up button from the last big blind', () => {
    expect(DEALING).toMatch(/headsUpButtonSeat\(sortedSeats, this\.lastBigBlindSeat\)/);
    expect(DEALING).toMatch(/this\.lastBigBlindSeat = bbSeat;/);
  });

  it('never records a big blind on a bomb pot, where nobody posts one', () => {
    /**
     * A bomb pot antes; HandController returns before postBlinds(). Writing
     * the anchor anyway walks it one seat too far, and the next hand hands the
     * big blind back to the player who last actually paid it -- the very bug
     * the rule removes, at a two-handed bomb-pot table. Shipped in the first
     * Phase 2 commit, caught in its audit.
     */
    const block = sliceEnclosingBlock(DEALING, 'this.lastBigBlindSeat = bbSeat;');
    expect(block).toMatch(/this\.lastBigBlindSeat = bbSeat;/);
    // The guard is the block's own condition, so read the statement that owns it.
    const stmt = sliceStatement(DEALING, 'if (!bombPotConfig) {');
    expect(stmt).toMatch(/this\.lastBigBlindSeat = bbSeat;/);
    // And it must not also be set beside the sb/bb computation, which runs on
    // bomb hands too.
    expect(DEALING.match(/this\.lastBigBlindSeat = bbSeat;/g)!.length).toBe(1);
  });

  it('persists the draw only where something reads it back', () => {
    // TournamentManagerBase.restoreDrawnFirstButtons is the sole reader of
    // tables.first_button_seat. A cash table re-draws on restart instead.
    expect(DEALING).toMatch(/if \(headsUpFirstButton !== null && this\.isTournamentTable\(\)\) \{/);
  });

  it('keeps a newcomer out of the heads-up button seat', () => {
    // Dan 2026-08-25, binding: a player sitting down never receives the button.
    // The guard and the call must live in the SAME block, or the rule can be
    // reached by a player who has never been dealt a hand at this table.
    const block = sliceEnclosingBlock(DEALING, 'headsUpButtonSeat(sortedSeats');
    expect(block).toMatch(/players\.every\(\(p\) => this\.dealtInUserIds\.has\(p\.user_id\)\)/);
  });

  it('restores the last big blind seat across an engine restart', () => {
    expect(BASE).toMatch(/protected lastBigBlindSeat: number = 0;/);
    const body = sliceMethod(BASE, 'private async restoreButtonFromHistory');
    // 2026-09-25 (the dead button at every table size): the blind POSTS are
    // read back with the row, so the seat that posted each blind is exact and
    // a dead small blind is visible; the walk from the button stays as the
    // fallback for a row written before posts were recorded.
    expect(body).toMatch(/select\('button_seat, players, actions'\)/);
    expect(body).toMatch(/this\.lastBigBlindSeat = bbPosted > 0 \? bbPosted : nextOf\(walkedSb\);/);
    expect(body).toMatch(/this\.lastSmallBlindSeat = /);
  });
});
