/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN EMPTY LOBBY IS AN OUTAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Spin board was topped up every TEN MINUTES. That was never a measured
 * number -- it matched the drain rate only by accident, back when a seat-first
 * game sat waiting about ten minutes for its field.
 *
 * It does not match any more. A Spin now opens with a 60-180 second human
 * window, starts ~13 seconds after that window closes, and plays out
 * hyper-turbo three-handed: alive for roughly THREE MINUTES, start to finish.
 *
 * Measured in production on 2026-08-23, immediately after the seat-first work
 * went live: 125 Spins created and completed inside ninety minutes; at the
 * moment of measuring, ZERO open and the most recent created EIGHT MINUTES
 * earlier. For the majority of every cycle, a player opening the Spin lobby
 * found nothing to sit down at.
 *
 * The board is refilled on a cadence shorter than the shortest life of a game.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SHORTEST_POSSIBLE_SPIN_LIFE_MS = 60 * 1000; // the floor of the human window alone

describe('the seat-first boards are refilled faster than they drain', () => {
  it('declares the cadence once, as a named constant', () => {
    expect(code).toMatch(/const\s+BOARD_REFILL_INTERVAL_MS\s*=\s*30\s*\*\s*1000\s*;/);
  });

  it('refills inside the shortest life any Spin can have', () => {
    const m = code.match(/const\s+BOARD_REFILL_INTERVAL_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*;/);
    expect(m).toBeTruthy();
    const ms = Number(m![1]) * Number(m![2]);
    expect(ms).toBeLessThanOrEqual(SHORTEST_POSSIBLE_SPIN_LIFE_MS);
    expect(ms).toBeGreaterThanOrEqual(10 * 1000); // not so hot it hammers the engine loop
  });

  it('drives the Spin board from that constant, not a literal ten minutes', () => {
    expect(code).toMatch(
      /this\.spinInterval\s*=\s*setInterval\(\(\)\s*=>\s*\{\s*if\s*\(isMaintenanceFrozen\(\)\)\s*return;\s*this\.launchLifecycleJob\(\s*generation,\s*\(\)\s*=>\s*this\.checkAndLaunchSpins\(\),\s*'TournamentRecurring\.spin_tick_failed'\s*\);\s*\},\s*BOARD_REFILL_INTERVAL_MS\s*\)/
    );
    expect(code).not.toMatch(/checkAndLaunchSpins\(\),\s*10\s*\*\s*60\s*\*\s*1000/);
  });

  it('drives the SNG board from it too -- heads-up games are just as short', () => {
    expect(code).toMatch(
      /this\.sngInterval\s*=\s*setInterval\(\(\)\s*=>\s*\{\s*if\s*\(isMaintenanceFrozen\(\)\)\s*return;\s*this\.launchLifecycleJob\(\s*generation,\s*\(\)\s*=>\s*this\.checkAndLaunchSNGs\(\),\s*'TournamentRecurring\.sng_tick_failed'\s*\);\s*\},\s*BOARD_REFILL_INTERVAL_MS\s*\)/
    );
    expect(code).not.toMatch(/checkAndLaunchSNGs\(\),\s*15\s*\*\s*60\s*\*\s*1000/);
  });

  it('leaves the MTT cadence alone -- an MTT is scheduled, not a board', () => {
    expect(code).toMatch(
      /this\.tournamentInterval\s*=\s*setInterval\([\s\S]{0,500}?\(\)\s*=>\s*this\.checkAndLaunchTournaments\(\)[\s\S]{0,200}?5 \* 60 \* 1000/
    );
    expect(code).toMatch(
      /this\.xmttInterval\s*=\s*setInterval\([\s\S]{0,500}?\(\)\s*=>\s*this\.checkAndLaunchXMTTs\(\)[\s\S]{0,200}?5 \* 60 \* 1000/
    );
  });

  it('still caps a cold start, so a faster tick cannot stampede the engine', () => {
    expect(code).toMatch(/const\s+BURST\s*=\s*12\s*;/);
    // Changed 2026-08-23 with per-owner boards. BURST used to be sliced
    // directly, once per board. A pass now services the house board PLUS every
    // owner who has activated Spins, so a per-board cap stops being a cap at
    // all -- twenty owners would mean twenty times the work. BURST is now the
    // opening balance of a budget threaded through every board in the pass,
    // and the slice spends what is left of it.
    // The cap is a share of BURST per board since 2026-09-03 (see
    // boardBudgetShares); a cold start still cannot create more than its
    // share per board per tick.
    expect(code).toMatch(/const share = boardBudgetShares\(owners\.length \+ 1\);/);
    expect(code).toMatch(/missing\.slice\(0,\s*budget\.left\)/);
  });

  it('returns without writing when the board is already full', () => {
    // This is what makes a 30-second tick free in the common case.
    expect(code).toMatch(/if\s*\(missing\.length\s*===\s*0\)\s*return;/);
  });

  it('still counts only REGISTERING as open -- a live game is not a free seat', () => {
    expect(code).toMatch(/\.eq\('status',\s*'REGISTERING'\)/);
  });

  it('tells the operator the real cadence at boot', () => {
    expect(src).toMatch(/Service started[^']*30 s/);
    expect(src).not.toMatch(/Spins every 10 min/);
  });
});
