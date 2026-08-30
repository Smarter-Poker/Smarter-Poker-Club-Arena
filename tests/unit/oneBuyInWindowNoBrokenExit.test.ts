/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE BUY-IN WINDOW, AND IT NEVER EXITS TO A DEAD URL (2026-08-29, round 14)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "IT NEVER WORKS, NEVER REGISTERS WITHOUT ERRORS." This is the errors
 * half, and it was a real shipping defect on the Spin buy-in sheet.
 *
 * TablePage carried TWO 60-second buy-in timers. The second one:
 *
 *   1. called `navigate('/hub/club-arena')` while the router's basename
 *      ALREADY is '/hub/club-arena' (src/main.tsx), so it resolved to
 *      '/hub/club-arena/hub/club-arena' - a route that does not exist. A
 *      player who lingered on the sheet was thrown to a dead URL;
 *   2. raised a red ERROR toast for a timeout that is not an error, saying
 *      the player had been "removed from the table" they had never sat at;
 *   3. on a CASH table fired ALONGSIDE the real timer, so a red error and a
 *      calm info toast both appeared and two navigations raced;
 *   4. used a bare setTimeout, which a background tab throttles, so it could
 *      fire late against a sheet already dealt with.
 *
 * It is deleted. The surviving timer is wall-clock, shows a live countdown,
 * releases the optimistic seat, closes the tab and routes to the REAL lobby
 * via exitDestination() - and it now governs the seat-first sheet too.
 *
 * Every assertion here runs against COMMENT-STRIPPED source, because the
 * deletion note quotes the old strings verbatim (handoff trap 6: never let a
 * pin pass or fail on your own prose).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const RAW = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');
const MAIN = readFileSync(join(root, 'src', 'main.tsx'), 'utf8');

/** Source with block and line comments removed - executable code only. */
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the duplicate buy-in timer is gone from executable code', () => {
  it('no longer navigates to a path that double-includes the basename', () => {
    expect(MAIN).toContain('basename="/hub/club-arena"');
    expect(CODE).not.toMatch(/navigate\(\s*['"`]\/hub\/club-arena['"`]\s*\)/);
  });

  it('no longer raises an ERROR toast for a buy-in timeout', () => {
    expect(CODE).not.toContain('Buy-in timed out');
    expect(CODE).not.toContain('You have been removed from the table');
  });

  it('leaves exactly ONE 60-second buy-in window implementation', () => {
    // The window is expressed once, via the wall-clock constant.
    const windows = CODE.match(/BUY_IN_WINDOW_SECONDS/g) || [];
    expect(windows.length).toBeGreaterThan(0);
    // and no bare 60000ms timer survives to race it.
    expect(CODE).not.toMatch(/setTimeout\([\s\S]{0,400}?60000\s*\)/);
  });
});

describe('the surviving timer governs the seat-first sheet too', () => {
  /**
   * UPDATED IN THE SAME COMMIT THAT CHANGED THE BEHAVIOUR (round 16).
   *
   * This pin used to require, verbatim:
   *
   *     const sheetOpen = showBuyInModal || seatFirstConfirm !== null
   *
   * and that line is the bug Dan hit on 2026-08-30. `seatFirstConfirm` is
   * cleared only AFTER `fn_take_seat_and_buy_in` resolves, so the in-flight
   * RPC counted as an open sheet and the 60-second clock ran straight through
   * a purchase that had already succeeded — closing the tab and sending him to
   * the lobby off a seat he owned, with nothing logged anywhere.
   *
   * So the pin now requires the two guards that make that impossible, rather
   * than the line that allowed it. CLAUDE.md section 8: replace the pinned
   * behaviour and the pin together, and say so.
   */
  it('arms only while the sheet is a DECISION - not while money is moving', () => {
    expect(CODE).toContain(
      'const commitInFlight = seatFirstPending || seatFirstPendingRef.current'
    );
    expect(CODE).toContain(
      'const alreadySeated = tableState.heroSeat > 0 || heroSeatRef.current > 0'
    );
    expect(CODE).toMatch(
      /const sheetOpen =\s*\(showBuyInModal \|\| seatFirstConfirm !== null\) && !commitInFlight && !alreadySeated;/
    );
  });

  it('the old unguarded form can never come back', () => {
    expect(CODE).not.toMatch(
      /const sheetOpen = showBuyInModal \|\| seatFirstConfirm !== null;\s*$/m
    );
  });

  /* The expiry branch, bounded by the block it lives in - never a byte count
     (tests/unit/noFixedSizeSourceWindows.test.ts, which caught this pin doing
     exactly that on its first run). One window serves every assertion below. */
  const expiry = sliceEnclosingBlock(CODE, 'Your Seat Was Released Because The Buy In');

  it('clears the seat-first sheet on expiry, not just the cash modal', () => {
    expect(expiry).toContain('setSeatFirstConfirm(null)');
    expect(expiry).toContain('setShowBuyInModal(false)');
  });

  it('re-arms when the seat-first sheet opens, and DISARMS when it must', () => {
    /* The guards above are only guards if the effect re-runs when they
       change: pressing Buy In flips `seatFirstPending` and must tear the
       interval down in that same commit. Round 16 added both. */
    expect(CODE).toContain(
      '[showBuyInModal, seatFirstConfirm, tableId, seatFirstPending, tableState.heroSeat]'
    );
  });

  it('and checks once more in the instant it would eject', () => {
    /* A whole second separates the guard from the fire. The RPC can land
       inside it - which is exactly the race that cost Dan his seat. */
    expect(expiry).toContain('if (seatFirstPendingRef.current || heroSeatRef.current > 0) return;');
  });

  it('exits to the real lobby, never a hard-coded path', () => {
    expect(expiry).toContain('navigate(exitDestination())');
  });
});

describe('the window is visible on the spin sheet, not a surprise', () => {
  it('renders a live countdown while the seat is held', () => {
    expect(CODE).toContain('Seat Held For {buyInSecondsLeft}s');
  });
});
