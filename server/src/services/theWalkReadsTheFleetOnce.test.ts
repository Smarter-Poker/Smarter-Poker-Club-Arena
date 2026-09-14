/**
 * ONE FLEET READ PER DISCOVERY PASS (2026-09-11).
 *
 * Measured on production: every top-up in the REGISTERING walk re-read the
 * four-game load map, the whole fleet, the cash-room reserve and its club's
 * membership - ~11 of ~16 sequential round trips, 2.6 s median per call - and
 * a pass took 8-10 minutes, so every MTT start waited behind ~200 of them.
 * HorseTopUpPass holds those answers once per pass. This pins what it may hold,
 * when it must let go, and that the walk no longer queues starts behind fills.
 *
 * REVIEWED BEFORE LANDING (2026-09-11). The first draft ran eight top-ups at
 * once, held its answers for as long as the walk ran, spent an event's turn
 * before it knew the top-up would run, and let a pass that threw leave its
 * top-ups running into the next one. "holds an answer for seconds" and "the
 * top-ups beside the walk are bounded" pin the fixes: ten seconds at most,
 * four at once, a turn spent only by a launched top-up, and a drain on every
 * path out of the pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HorseTopUpPass, HORSE_TOP_UP_PASS_MAX_AGE_MS } from './TournamentRecurringService.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);
const GAME_SERVER = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');

describe('HorseTopUpPass holds an answer once, and only a known one', () => {
  it('concurrent callers share one read', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => {
      reads++;
      return 7;
    };
    const all = await Promise.all([1, 2, 3].map(() => pass.once('k', read, () => true)));
    expect(all).toEqual([7, 7, 7]);
    expect(await pass.once('k', read, () => true)).toBe(7);
    expect(reads).toBe(1);
  });

  it('never holds an unknown answer: the next caller asks again', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => (++reads === 1 ? null : 5);
    const known = (v: number | null) => v !== null;
    expect(await pass.once('k', read, known)).toBeNull();
    expect(await pass.once('k', read, known)).toBe(5);
    expect(await pass.once('k', read, known)).toBe(5);
    expect(reads).toBe(2);
  });

  it('never holds a failed read', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => {
      if (++reads === 1) throw new Error('boom');
      return 1;
    };
    await expect(pass.once('k', read, () => true)).rejects.toThrow('boom');
    expect(await pass.once('k', read, () => true)).toBe(1);
    expect(reads).toBe(2);
  });

  it('forgets everything the moment somebody is seated', async () => {
    const pass = new HorseTopUpPass();
    let reads = 0;
    const read = async () => ++reads;
    expect(await pass.once('k', read, () => true)).toBe(1);
    pass.forget();
    expect(await pass.once('k', read, () => true)).toBe(2);
  });
});

describe('HorseTopUpPass holds an answer for seconds, not for a walk', () => {
  // The pass only hears about ITS OWN seats. The fleet's cash seating, the
  // fast lane, the scheduler and humans move horses without telling it, and a
  // walk after a thaw runs for tens of seconds.
  it('reads again once an answer is older than its max age', async () => {
    let clock = 0;
    const pass = new HorseTopUpPass(10_000, () => clock);
    let reads = 0;
    const read = async () => ++reads;
    expect(await pass.once('k', read, () => true)).toBe(1);
    clock = 9_999;
    expect(await pass.once('k', read, () => true)).toBe(1);
    clock = 10_000;
    expect(await pass.once('k', read, () => true)).toBe(2);
    expect(reads).toBe(2);
  });

  it('the walk holds for ten seconds at most', () => {
    expect(HORSE_TOP_UP_PASS_MAX_AGE_MS).toBeGreaterThan(0);
    expect(HORSE_TOP_UP_PASS_MAX_AGE_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('what a pass may hold', () => {
  it('the cash-room reserve only when it was READ, never its fail-open 0', () => {
    const reserve = sliceMethod(RECURRING, 'private async cashRoomReserve(');
    expect(reserve).toContain('(value) => value !== null');
    expect(reserve).toContain('return reserve ?? 0;');
    const read = sliceMethod(RECURRING, 'private async readCashRoomReserve(');
    expect(read).toContain('if (tErr || !cashTables) return null;');
    expect(read).not.toMatch(/catch \{\s*return 0;/);
  });

  it('club membership per club and union, not per tournament', () => {
    const club = sliceMethod(RECURRING, 'private async clubMemberIdsForTournament(');
    expect(club).toContain("`club-members:${hostClubId}:${unionId ?? ''}`");
  });

  it('nothing after a seat, a registration or a throw', () => {
    const top = sliceMethod(RECURRING, 'async topUpWithHorses(');
    expect(top).toContain('if (added > 0) pass?.forget();');
    // The whole catch body, comments aside - a structure, not a byte window.
    expect(blankNonCode(top)).toMatch(/catch \{\s*pass\?\.forget\(\);\s*return 0;\s*\}/);
  });
});

describe('the REGISTERING walk', () => {
  const walk = sliceMethod(GAME_SERVER, 'private async discoverTournaments(');

  it('holds one pass for every top-up it makes', () => {
    expect(walk).toContain('const topUpPass = new HorseTopUpPass();');
    expect((walk.match(/\{ pass: topUpPass(?:, redeemTickets)? \}/g) || []).length).toBe(2);
  });

  it('fills beside the walk - bounded, throttled - and waits before it moves on', () => {
    expect(walk).toMatch(/while \(pastStartTopUps\.size >= PAST_START_TOP_UP_CONCURRENCY\)/);
    // 45 s at most, backing off to the old pass length on empty top-ups.
    expect(walk).toContain('MTT_PRESTART_TICK_MS * 2 ** Math.min(misses, 4)');
    expect(walk).toContain('PAST_START_TOP_UP_MAX_INTERVAL_MS');
    expect(walk).toContain('misses: added > 0 ? 0 : misses + 1');
    const drained = walk.indexOf('await Promise.allSettled([...pastStartTopUps]);');
    expect(drained).toBeGreaterThan(walk.indexOf('for (const tournament of registering || []) {'));
    expect(drained).toBeLessThan(walk.indexOf('FULLY PAID BUT NEVER STARTED'));
  });

  it('never awaits a past-start top-up inline, so no later row waits on it for its start', () => {
    // The line this replaced made every REGISTERING -> RUNNING decision after
    // a short board wait for that board's whole top-up.
    expect(blankNonCode(walk)).not.toMatch(
      /await this\.tournamentRecurring\s*\.topUpWithHorses\(\s*tournament\.id,\s*target\b/
    );
  });
});

describe('the top-ups beside the walk are bounded', () => {
  const walk = sliceMethod(GAME_SERVER, 'private async discoverTournaments(');
  const code = blankNonCode(walk);

  it('four at a time at most, and more than one', () => {
    const cap = Number(/const PAST_START_TOP_UP_CONCURRENCY = (\d+);/.exec(GAME_SERVER)?.[1]);
    // One at a time is the 8-10 minute pass this file exists for.
    expect(cap).toBeGreaterThanOrEqual(2);
    // A terminal authority takes the platform lane exclusively and waits for
    // the LONGEST seat in flight, with every later seat purchase behind it;
    // and each top-up beside another may claim from answers that one has
    // just changed (the cash-room reserve is enforced by nobody else).
    expect(cap).toBeLessThanOrEqual(4);
  });

  it("spends an event's turn only on a top-up that is actually launched", () => {
    const recheck = code.indexOf(
      'if (!this.directAdmissionIsCurrent(generation) || isMaintenanceFrozen()) continue;'
    );
    const spent = code.indexOf('this.pastStartTopUpClock.set(tournament.id, { at: now, misses });');
    expect(recheck).toBeGreaterThan(-1);
    expect(spent, 'the clock is set before the slot wait and its re-check').toBeGreaterThan(
      recheck
    );
  });

  it('no top-up outlives its pass, even a pass that throws part-way', () => {
    const held = code.indexOf('const pastStartTopUps = new Set<Promise<void>>();');
    expect(held).toBeGreaterThan(-1);
    expect(held, 'the in-flight set must live outside the try').toBeLessThan(code.indexOf('try {'));
    const caught = walk.indexOf("reportError(err, 'GameServer.Tournament_discovery_error');");
    expect(caught).toBeGreaterThan(-1);
    const drain = code.indexOf('await Promise.allSettled([...pastStartTopUps]);', caught);
    const sleep = code.indexOf('await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL);', caught);
    expect(drain, 'no drain after the catch').toBeGreaterThan(caught);
    expect(drain).toBeLessThan(sleep);
  });
});
