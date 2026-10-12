/**
 * A HUMAN'S SPIN BOARD FILLS FIRST (2026-10-03).
 *
 * SpinUnfilledBacklog fired all night on 2026-10-02/03 while HorseOverlayGuard
 * logged "every candidate is at the four-table cap" and the board opener "the
 * pool is thin". The free horses were first come, first served, so a waiting
 * human's board (asking every 12 s) could lose the last free horse to a board
 * opener or a horse-only top-up. These pins keep the human's claim first.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUMAN_SEAT_DEMAND_TTL_MS,
  humanSeatsOwed,
  selectHorseCandidates,
  selectHumanFillCandidates,
} from './TournamentRecurringService.js';
import { gameLaneFor, isActiveNow } from './HorseBehavior.js';

const TRS = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');
const GS = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');

function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} must still exist`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  private ', start + signature.length);
  return src.slice(start, next > -1 ? next : src.length);
}

describe('humanSeatsOwed', () => {
  it('sums live human demand and never counts the asking game against itself', () => {
    const now = 1_000_000;
    const demand = new Map([
      ['a', { seats: 2, at: now - 1_000 }],
      ['b', { seats: 1, at: now - 10_000 }],
    ]);
    expect(humanSeatsOwed(demand, undefined, now)).toBe(3);
    expect(humanSeatsOwed(demand, 'a', now)).toBe(1);
    expect(humanSeatsOwed(demand, 'b', now)).toBe(2);
  });

  it('a declaration lapses, so a started board or a departed player stops holding horses', () => {
    const now = 5_000_000;
    const demand = new Map([['a', { seats: 2, at: now - HUMAN_SEAT_DEMAND_TTL_MS - 1 }]]);
    expect(humanSeatsOwed(demand, undefined, now)).toBe(0);
  });

  it('nonsense never becomes a reservation', () => {
    const demand = new Map([
      ['a', { seats: -3, at: 0 }],
      ['b', { seats: Number.NaN, at: 0 }],
    ]);
    expect(humanSeatsOwed(demand, undefined, 0)).toBe(0);
  });
});

describe('selectHumanFillCandidates', () => {
  const fleet: string[] = Array.from({ length: 4000 }, () => randomUUID());
  const hour = 14;

  it('offers the events lanes first and only active cash-lane horses after them', () => {
    const busy = new Set(fleet.slice(0, 50));
    const { events, cash } = selectHumanFillCandidates(fleet, busy, hour);
    expect(events).toEqual(selectHorseCandidates(fleet, busy, false, hour));
    expect(cash.length).toBeGreaterThan(0);
    for (const id of cash) {
      expect(gameLaneFor(id)).toBe('cash');
      expect(isActiveNow(id, hour)).toBe(true);
      expect(events).not.toContain(id);
    }
    for (const id of [...events, ...cash]) expect(busy.has(id)).toBe(false);
  });
});

describe('the wiring that gives the human the first claim', () => {
  it('every non-human claim leaves the seats waiting humans need', () => {
    const pick = bodyOf(TRS, 'private async pickFreeHorses(');
    expect(pick).toContain('humanSeatsOwed(this.humanSeatDemand, tournamentId)');
    expect(pick).toMatch(/candidates\.length - reserved - owedToHumans/);
    // The human's own ask is not held to the cash-room floor.
    expect(pick.indexOf('if (humanTiers)')).toBeLessThan(pick.indexOf('cashRoomReserve('));
  });

  it('the seat-first top-up passes the human flag to the pool', () => {
    const topUp = bodyOf(TRS, 'async topUpWithHorses(');
    expect(topUp).toContain('opts.forHuman === true');
  });

  it("the fast lane declares a human's demand before asking, and clears it once full", () => {
    const topUp = bodyOf(GS, 'private async topUpPartialSeatFirst(');
    const note = topUp.indexOf('noteHumanSeatDemand(tournamentId, seats - paid)');
    const ask = topUp.indexOf('topUpWithHorses(tournamentId, seats, {');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(ask);
    expect(topUp).toContain('clearHumanSeatDemand(tournamentId)');
  });

  it('a human on a board whose window has closed is still served as a human', () => {
    const fill = bodyOf(GS, 'private async fillPartialSeatFirstGame(');
    // The occupancy answer comes before the cadence, and the window-closed
    // shortcut that skipped it is gone.
    expect(fill.indexOf('seatFirstHasHuman(')).toBeLessThan(fill.indexOf('const interval'));
    expect(fill).not.toMatch(/if \(windowClosed\) \{\s*await this\.topUpPartialSeatFirst/);
    expect(fill).toContain('hasHuman ? 0 :');
  });
});
