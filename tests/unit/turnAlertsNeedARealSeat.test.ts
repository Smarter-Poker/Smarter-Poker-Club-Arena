/**
 * ═══ "YOUR TURN" MUST MEAN YOUR TURN (Dan 2026-08-29) ══════════════════════
 *
 * Observed live while SPECTATING a 9-handed table with no seat at all: the
 * browser tab read "YOUR TURN - nlh 0.1/0.2" the entire time.
 *
 * Cause: TablePage's onTableInfoUpdate reported
 *     currentPlayerSeat === heroSeat && isHandInProgress
 * with NO `> 0` guards. A spectator's heroSeat is 0, and currentPlayerSeat is
 * ALSO 0 between hands and during snapshot churn — so `0 === 0` published
 * isMyTurn TRUE. This is the same 2026-04-14 trap the felt's own
 * `isHeroTurnContext` was fixed for; this reporting path never got the guard.
 *
 * It is not cosmetic. MultiTablePage feeds that one flag to the tab title,
 * the favicon badge, the desktop Notification, the flash/haptic alerts and
 * the dock countdown. Firing them at someone with no seat is how a real
 * "act now" alert stops being believed.
 *
 * Pinned two ways: the rule itself, and the source that must keep the guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The published rule, extracted exactly as TablePage computes it. */
const isHeroTurn = (heroSeat: number, currentPlayerSeat: number, handInProgress: boolean) =>
  heroSeat > 0 && currentPlayerSeat > 0 && currentPlayerSeat === heroSeat && handInProgress;

describe('a turn alert requires a REAL seat on both sides', () => {
  it('THE BUG: a spectator between hands is not "your turn"', () => {
    // heroSeat 0 (no seat) and currentPlayerSeat 0 (nobody on the clock).
    expect(isHeroTurn(0, 0, true)).toBe(false);
  });

  it('a spectator watching someone else act is not "your turn"', () => {
    expect(isHeroTurn(0, 4, true)).toBe(false);
  });

  it('a seated player between hands is not "your turn"', () => {
    expect(isHeroTurn(7, 0, true)).toBe(false);
  });

  it('a seated player when it IS their turn is "your turn"', () => {
    expect(isHeroTurn(7, 7, true)).toBe(true);
  });

  it('no hand in progress is never "your turn"', () => {
    expect(isHeroTurn(7, 7, false)).toBe(false);
  });

  it('another seat acting is not "your turn"', () => {
    expect(isHeroTurn(7, 3, true)).toBe(false);
  });
});

describe('the source keeps the guard', () => {
  const src = readFileSync(path.resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('onTableInfoUpdate computes isHeroTurn with both seats > 0', () => {
    // The reporting effect's own copy — the one that feeds every alert.
    const guarded =
      /const isHeroTurn =\s*\n?\s*tableState\.heroSeat > 0 &&\s*\n?\s*tableState\.currentPlayerSeat > 0 &&/;
    expect(
      guarded.test(src),
      'the unguarded `currentPlayerSeat === heroSeat` is back — spectators will be told YOUR TURN again'
    ).toBe(true);
  });

  it('no isHeroTurn in this file is computed without the > 0 guards', () => {
    // Every assignment of an isHeroTurn-shaped variable must carry the guard.
    const assignments = src.match(/const isHeroTurn[A-Za-z]* =[\s\S]{0,240}?;/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      if (!a.includes('currentPlayerSeat === ') && !a.includes('currentPlayerSeat ===')) continue;
      expect(
        a.includes('heroSeat > 0') && a.includes('currentPlayerSeat > 0'),
        `an isHeroTurn is computed without > 0 guards:\n${a}`
      ).toBe(true);
    }
  });
});
