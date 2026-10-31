/**
 * LAW - A SEATED PLAYER WHO IS SITTING OUT ALWAYS GETS THE I'M BACK BUTTON
 *
 * Dan 2026-10-12: "THERE IS NO 'I'M BACK' BUTTON TO CLICK FOR THE DIAMOND
 * ARENA WHEN YOU ARE SITTING OUT. THIS NEEDS TO BE FIXED."
 *
 * A sat-out hero is not in the current hand's player list, so the footer's
 * "Seat Reserved" branch (which keys on that list) matched first and the
 * sitting-out bar with I'm Back was never reached. The reserved branch now
 * stands aside whenever the hero's seat row says they are sitting out, and
 * the placeholder seat drawn for them prints the row's stack rather than 0.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');

describe("LAW - I'm Back is never shadowed by the reserved bar", () => {
  it('the reserved branch stands aside for a sitting-out hero', () => {
    // Bounded by the structure: from the guard that opens the cash reserved
    // branch to the bar it opens.
    const start = PAGE.indexOf('!(seatFirstBuyIn && tableState.heroSeat > 0) &&');
    expect(start, 'the cash reserved branch guard moved; re-point this law').toBeGreaterThan(0);
    const reserved = PAGE.indexOf('data-state="reserved"', start);
    expect(PAGE.slice(start, reserved)).toMatch(/!heroIsSittingOut \? \(/);
  });

  it('the sitting-out bar still offers I am back', () => {
    const bar = PAGE.indexOf('data-state="sitting-out"');
    expect(bar).toBeGreaterThan(0);
    // Bounded by the structure: the bar ends where the footer chain's next
    // branch begins.
    const end = PAGE.indexOf(') : !tableState.isHandInProgress', bar);
    expect(end).toBeGreaterThan(bar);
    expect(PAGE.slice(bar, end)).toContain("I'm Back");
  });

  it('the placeholder hero prints the seat row stack, not zero', () => {
    expect(PAGE).toMatch(
      /stack:\s*lightningWaitingSeat\?\.stack \?\? heroRowStack \?\? pendingSeatStackRef\.current \?\? 0,/
    );
    expect(PAGE).toMatch(
      /select\(\s*'user_id, seat_number, occupancy_id, is_sitting_out, sit_out_at, leave_pending, stack'\s*\)/
    );
  });
});
