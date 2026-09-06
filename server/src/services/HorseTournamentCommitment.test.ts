/**
 * A HORSE LEAVES CASH FOR ITS TOURNAMENT (2026-09-06). See
 * HorseTournamentCommitment.ts. The decision is pure and proven here; the
 * rotator wiring is pinned against the source at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LEAVE_FOR_TOURNAMENT_BY_MS,
  LEAVE_FOR_TOURNAMENT_FROM_MS,
  seatsInLeavingOrder,
  tournamentCommitmentVerdict,
  type CommittedCashSeat,
} from './HorseTournamentCommitment.js';
import { BOOKING_COUNTS_WITHIN_MS } from './HorseGameLoad.js';

const NOW = Date.parse('2026-09-06T15:00:00Z');
const MIN = 60_000;
const CYCLE = 90_000;
const seat = (tableId: string, minutesAgo: number, humanPresent = false): CommittedCashSeat => ({
  tableId,
  joinedAtMs: NOW - minutesAgo * MIN,
  humanPresent,
});
const booking = (minutesFromNow: number | null, id = 't') => ({
  tournamentId: id,
  startMs: minutesFromNow === null ? null : NOW + minutesFromNow * MIN,
});
const base = {
  nowMs: NOW,
  cycleMs: CYCLE,
  random: 0.5,
};

describe('the window is the database window', () => {
  it('starts leaving when the booking starts counting, and is certain at fifteen minutes', () => {
    expect(LEAVE_FOR_TOURNAMENT_FROM_MS).toBe(BOOKING_COUNTS_WITHIN_MS);
    expect(LEAVE_FOR_TOURNAMENT_BY_MS).toBe(15 * MIN);
  });
});

describe('nothing to do', () => {
  it('no imminent booking: no commitment, whatever the seats', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      cashSeats: [seat('a', 40), seat('b', 30), seat('c', 20), seat('d', 10)],
      liveSeatsTotal: 4,
      imminentBookings: [booking(3 * 60)],
    });
    expect(v.reason).toBe('no_commitment');
    expect(v.leaveNow).toEqual([]);
  });

  it('three seats and one booking fit in four: no excess', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      cashSeats: [seat('a', 40), seat('b', 30), seat('c', 20)],
      liveSeatsTotal: 3,
      imminentBookings: [booking(30)],
    });
    expect(v.reason).toBe('no_excess');
    expect(v.excess).toBe(0);
  });

  it('the excess is all tournament seats: a cash seat is not what is over', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      cashSeats: [],
      liveSeatsTotal: 4,
      imminentBookings: [booking(10)],
    });
    expect(v.excess).toBe(1);
    expect(v.leaveNow).toEqual([]);
  });
});

describe('the certain departure', () => {
  it('four cash seats and a start in ten minutes: leaves one, the seat held longest', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      random: 0.999,
      cashSeats: [seat('newest', 5), seat('oldest', 90), seat('mid', 40), seat('mid2', 30)],
      liveSeatsTotal: 4,
      imminentBookings: [booking(10)],
    });
    expect(v.reason).toBe('certain');
    expect(v.leaveNow.map((s) => s.tableId)).toEqual(['oldest']);
  });

  it('two imminent tournaments against four seats: leaves two', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      random: 0.999,
      cashSeats: [seat('a', 90), seat('b', 80), seat('c', 70), seat('d', 60)],
      liveSeatsTotal: 4,
      imminentBookings: [booking(14, 't1'), booking(50, 't2')],
    });
    expect(v.excess).toBe(2);
    expect(v.leaveNow.map((s) => s.tableId)).toEqual(['a', 'b']);
  });

  it('a seat-first booking with no start time is starting now', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      random: 0.999,
      cashSeats: [seat('a', 90), seat('b', 80), seat('c', 70), seat('d', 60)],
      liveSeatsTotal: 4,
      imminentBookings: [booking(null)],
    });
    expect(v.reason).toBe('certain');
    expect(v.minutesToStart).toBe(0);
  });

  it('a tournament that should already have started is certain too', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      random: 0.999,
      cashSeats: [seat('a', 90), seat('b', 80), seat('c', 70), seat('d', 60)],
      liveSeatsTotal: 4,
      imminentBookings: [booking(-3)],
    });
    expect(v.reason).toBe('certain');
  });
});

describe('the hazard between sixty and fifteen minutes', () => {
  const fourSeats = [seat('a', 90), seat('b', 80), seat('c', 70), seat('d', 60)];

  it('is spread evenly: with 30 cycles left the chance this cycle is 1/30', () => {
    // 60 minutes out: 45 minutes of hazard window = 30 cycles of 90 s.
    const held = tournamentCommitmentVerdict({
      ...base,
      random: 1 / 30 + 0.001,
      cashSeats: fourSeats,
      liveSeatsTotal: 4,
      imminentBookings: [booking(60)],
    });
    expect(held.reason).toBe('hazard_held');
    const fired = tournamentCommitmentVerdict({
      ...base,
      random: 1 / 30 - 0.001,
      cashSeats: fourSeats,
      liveSeatsTotal: 4,
      imminentBookings: [booking(60)],
    });
    expect(fired.reason).toBe('hazard_fired');
    expect(fired.leaveNow.map((s) => s.tableId)).toEqual(['a']);
  });

  it('leaves one seat per cycle even when two are owed, so the room empties gradually', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      random: 0,
      cashSeats: fourSeats,
      liveSeatsTotal: 4,
      imminentBookings: [booking(30, 't1'), booking(45, 't2')],
    });
    expect(v.excess).toBe(2);
    expect(v.reason).toBe('hazard_fired');
    expect(v.leaveNow).toHaveLength(1);
  });

  it('pushes harder when more seats are owed: two owed doubles the per-cycle chance', () => {
    const one = tournamentCommitmentVerdict({
      ...base,
      random: 1.5 / 30,
      cashSeats: fourSeats,
      liveSeatsTotal: 4,
      imminentBookings: [booking(60, 't1')],
    });
    expect(one.reason).toBe('hazard_held');
    const two = tournamentCommitmentVerdict({
      ...base,
      random: 1.5 / 30,
      cashSeats: fourSeats,
      liveSeatsTotal: 4,
      imminentBookings: [booking(60, 't1'), booking(60, 't2')],
    });
    expect(two.reason).toBe('hazard_fired');
  });

  it('a booking outside the window is not counted, so it holds no seat', () => {
    const v = tournamentCommitmentVerdict({
      ...base,
      random: 0,
      cashSeats: fourSeats,
      liveSeatsTotal: 4,
      imminentBookings: [booking(61)],
    });
    expect(v.reason).toBe('no_commitment');
  });
});

describe('which seat a person gives up', () => {
  it('a table with no human first, then the seat held longest', () => {
    const order = seatsInLeavingOrder([
      seat('human-old', 120, true),
      seat('horse-new', 10),
      seat('horse-old', 90),
      seat('human-new', 5, true),
    ]).map((s) => s.tableId);
    expect(order).toEqual(['horse-old', 'horse-new', 'human-old', 'human-new']);
  });
});

describe('the wiring in HorseSessionRotator', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(join(here, 'HorseSessionRotator.ts'), 'utf8');

  it('the rotator asks the verdict and leaves through the human door', () => {
    expect(SRC).toContain('tournamentCommitmentVerdict(');
    expect(SRC).toContain('leaveCashForTournaments(');
    /* The departure must be engine.leaveTable - never a seat-row write. */
    const fn = SRC.slice(SRC.indexOf('private async leaveCashForTournaments('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body).toContain('engine.leaveTable(');
    expect(body).not.toMatch(/from\('table_seats'\)\s*\.(update|delete)/);
  });

  it('reads the bookings with the same window the fleet and the database use', () => {
    expect(SRC).toContain('LEAVE_FOR_TOURNAMENT_FROM_MS');
    expect(SRC).toContain("['ANNOUNCED', 'REGISTERING']");
  });

  it('runs outside the discretionary departure cap, like the lone stand', () => {
    const idx = SRC.indexOf('this.lastTournamentLeaves = await this.leaveCashForTournaments(');
    const cap = SRC.indexOf('if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;');
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(cap);
  });
});
