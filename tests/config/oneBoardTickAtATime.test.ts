/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TWO TICKS READING THE SAME SNAPSHOT BUILD THE BOARD TWICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `setInterval` does not wait for its previous callback to finish. The board
 * refill went from ten minutes to thirty seconds, and a tick that has to fill
 * a drained board performs up to BURST creations SEQUENTIALLY -- each an
 * insert, a table, and two horse registrations. That comfortably exceeds
 * thirty seconds, so the next tick starts while the first is still working,
 * reads the same "what is missing" snapshot, and creates every one of the
 * same games a second time.
 *
 * Measured in production within two minutes of the faster cadence going live:
 * 56 open Spins against a board of 40 configs -- sixteen names carrying
 * exactly TWO copies each.
 *
 * Exactly two, never three, because once the duplicate is REGISTERING the name
 * stops being missing. So the board self-heals as the extra copies play out,
 * and no repair migration is needed. It was still wrong, and it doubled the
 * write load at precisely the moment the engine was restarting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('a board refills one tick at a time', () => {
  it('tracks an in-flight tick per board', () => {
    expect(code).toMatch(
      /private\s+boardTickInFlight\s*:\s*Record<\s*'spin'\s*\|\s*'sng'\s*,\s*boolean\s*>/
    );
  });

  it('starts each board unlocked', () => {
    expect(code).toMatch(/\{\s*spin:\s*false,\s*sng:\s*false\s*\}/);
  });

  it('returns immediately when that board is already refilling', () => {
    expect(code).toMatch(/if\s*\(this\.boardTickInFlight\[variant\]\)\s*\{[\s\S]{0,200}?return;/);
  });

  it('claims the board before the first read, not after', () => {
    const claim = code.indexOf('this.boardTickInFlight[variant] = true');
    const read = code.indexOf("from('tournaments')", claim > 0 ? claim : 0);
    expect(claim).toBeGreaterThan(-1);
    // The claim must precede the read that produces the snapshot, or two ticks
    // can still both read before either claims.
    expect(claim).toBeLessThan(read);
  });

  it('wraps the WHOLE pass, not one board read', () => {
    // Changed 2026-08-23 with per-owner boards. The guard used to live inside
    // ensureBoardOpen, which is now called once per OWNER in a single pass --
    // so the second owner in a tick would have found the flag set by the first
    // and been skipped forever. It belongs around the pass, which is also what
    // it always meant.
    expect(code).toMatch(/private async withBoardTick\(/);
    expect(code).toMatch(/await this\.withBoardTick\('spin', async \(\) => \{/);
    expect(code).toMatch(/await this\.withBoardTick\('sng', async \(\) => \{/);
  });

  it('releases in a finally, so an early return cannot freeze the board', () => {
    // The read-error path returns early on purpose (fail closed, skip a cycle).
    // Releasing only at the end of the try would strand the flag set forever
    // and the board would never refill again.
    expect(code).toMatch(
      /\}\s*finally\s*\{\s*this\.boardTickInFlight\[variant\]\s*=\s*false;\s*\}/
    );
  });

  it('is per board, so a slow SNG fill cannot stall the Spin board', () => {
    expect(code).toMatch(/this\.boardTickInFlight\[variant\]/);
    expect(code).not.toMatch(/private\s+boardTickInFlight\s*:\s*boolean/);
  });

  it('keeps the cadence that made the guard necessary', () => {
    expect(code).toMatch(/const\s+BOARD_REFILL_INTERVAL_MS\s*=\s*30\s*\*\s*1000\s*;/);
    /* RESHAPED 2026-09-01 (freeze phase C): every launcher tick is now
       wrapped in the maintenance-freeze gate -
         () => (isMaintenanceFrozen() ? undefined : this.checkAndLaunchX())
       - because launching a game registers and seats horses, which is chip
       movement during a break players were told nothing moves in. The pins
       below now REQUIRE the gate as well as the cadence: dropping either one
       re-ships a real bug (the ten-minute board drought, or chips moving
       mid-break). */
    expect(code).toMatch(
      /isMaintenanceFrozen\(\) \? undefined : this\.checkAndLaunchSpins\(\)\),\s*BOARD_REFILL_INTERVAL_MS/
    );
    expect(code).toMatch(
      /isMaintenanceFrozen\(\) \? undefined : this\.checkAndLaunchSNGs\(\)\),\s*BOARD_REFILL_INTERVAL_MS/
    );
  });

  it('keeps the burst cap -- the guard bounds overlap, not batch size', () => {
    expect(code).toMatch(/const\s+BURST\s*=\s*12\s*;/);
  });

  it('spends that cap ACROSS every board a pass touches, not per board', () => {
    // 2026-09-03: the cap is still BURST for the pass, but it is SPLIT into a
    // share per board before anyone spends (boardBudgetShares) rather than
    // handed to the house first - the house was never full and starved every
    // owner board. Each ensureBoardOpen still spends only what it was given.
    expect(code).toMatch(
      /export function boardBudgetShares\(ownerCount: number, burst: number = BURST\)/
    );
    expect(code).toMatch(/const share = boardBudgetShares\(owners\.length \+ 1\);/);
    // Changed 2026-08-23 with per-owner boards: a per-board cap stops being a
    // cap once one pass can service the house plus every activated owner.
    expect(code).toMatch(/missing\.slice\(0, budget\.left\)/);
    expect(code).toMatch(/budget\.left--/);
  });
});
