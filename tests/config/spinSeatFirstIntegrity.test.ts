/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SPIN IS A TABLE YOU SIT AT, AND EVERYTHING THAT BROKE BECAUSE IT WAS NOT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23, from a seat: "I registered, said final table, then I was
 * booted and said i finished 4th somehow".
 *
 * Every part of that was real, and it was one fault with four faces.
 *
 * A seat-first game starts when every SEAT is sold. The past-start top-up
 * filled short games by calling fn_register_horse_for_tournament, which writes
 * tournament_players and NOTHING ELSE. So a topped-up Spin reached "3
 * registered / 0 seated" and:
 *
 *   - it could never start, because no seat had been sold;
 *   - it kept advertising three EMPTY seats on the lobby;
 *   - fn_register_for_tournament's capacity check reads the denormalised
 *     tournaments.current_players, which those inserts had left stale, so a
 *     human who sat down was admitted as a FOURTH entrant to a 3-max event;
 *   - the elimination path then computed his place from a field of four and
 *     told him he finished 4th, in a game that cannot have a 4th place.
 *
 * Measured before the fix: 12 of 24 open Spins were in that state, stuck
 * between 9 and 25 hours.
 *
 * The Final Table announcement was a separate, simpler insult: the engine
 * broadcasts `final_table` once 9 or fewer players remain, which for a
 * 3-handed Spin is true before a card is dealt.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const recurring = tsCode(read('server/src/services/TournamentRecurringService.ts'));
const page = tsCode(read('src/pages/TablePage.tsx'));

describe('horses take seats, not just places on a list', () => {
  it('the opening fill seats horses through the seating RPC', () => {
    expect(recurring).toMatch(/fn_seat_horse_in_seat_first_game/);
    expect(recurring).toMatch(/openingHorsesForSeatFirst/);
  });

  it('opens a seat-first game one seat short', () => {
    // Spin (3) -> 2 horses. Heads-up (2) -> 1 horse. Dan's rule verbatim.
    expect(recurring).toMatch(
      /function openingHorsesForSeatFirst\(seats: number\): number \{\s*return Math\.max\(0, seats - 1\);/
    );
  });

  it('the past-start top-up seats rather than registers for seat-first', () => {
    const topUp = recurring.slice(
      recurring.indexOf('async topUpWithHorses'),
      recurring.indexOf('private async registerHorses')
    );
    expect(topUp).toMatch(/isSeatFirstFormat\(/);
    expect(topUp).toMatch(/fn_seat_horse_in_seat_first_game/);
    // registerHorses is still correct for an MTT, so it must remain reachable.
    expect(topUp).toMatch(/registerHorses\(tournamentId, shortfall\)/);
  });

  it('never takes a horse out of a game it is already in', () => {
    const pick = recurring.slice(
      recurring.indexOf('private async pickFreeHorses'),
      recurring.indexOf('private async createSpin')
    );
    expect(pick).toMatch(/tournament_players/);
    expect(pick).toMatch(/table_seats/);
    expect(pick).toMatch(/is_horse/);
  });

  it('reads the busy set ONCE per call, not once per horse', () => {
    /**
     * The first version answered with a single horse, so seating a Spin called
     * it twice and a top-up called it once per empty seat - each call scanning
     * up to 2,000 tournament_players, 2,000 table_seats and 400 profiles.
     * GameServer's discovery pass runs every FIVE SECONDS across every
     * past-start short tournament, and this database had already been
     * saturated once that day. Batching is not a micro-optimisation here.
     */
    expect(recurring).toMatch(/private async pickFreeHorses\(count: number\): Promise<string\[\]>/);
    // The singular form must be gone, or a caller can quietly reintroduce the
    // per-horse shape.
    expect(recurring).not.toMatch(/pickFreeHorse\(\)/);

    const pick = recurring.slice(
      recurring.indexOf('private async pickFreeHorses'),
      recurring.indexOf('private async createSpin')
    );
    // Exactly one read of each source inside the function.
    expect((pick.match(/from\('tournament_players'\)/g) || []).length).toBe(1);
    expect((pick.match(/from\('table_seats'\)/g) || []).length).toBe(1);
    expect((pick.match(/from\('profiles'\)/g) || []).length).toBe(1);
  });

  it('both callers batch, so neither loops a query', () => {
    for (const caller of ['createOpenSeatTable', 'topUpWithHorses']) {
      const start = recurring.indexOf(caller);
      expect(start, `${caller} is gone`).toBeGreaterThan(-1);
      const body = recurring.slice(start, start + 3000);
      expect(body).toMatch(/pickFreeHorses\(/);
    }
  });
});

describe('the last seat belongs to a human for a minute to three', () => {
  it('the window is 60 to 180 seconds', () => {
    expect(recurring).toMatch(/SEAT_FIRST_HUMAN_WINDOW_MIN_MS = 60 \* 1000/);
    expect(recurring).toMatch(/SEAT_FIRST_HUMAN_WINDOW_MAX_MS = 180 \* 1000/);
  });

  it('is randomised per game, not a fixed tick, and not with the banned RNG', () => {
    // A constant delay makes every table on the board fill in lockstep.
    // CryptoRandom.test.ts forbids the unseeded language-level RNG anywhere in
    // TournamentRecurringService - item A8 of its header records
    // rollSpinMultiplier having picked a REAL MONEY multiplier with it. This
    // window is only a timer, but a guard narrow enough to allow "but mine is
    // only a timer" is a guard that gets talked around.
    const fn = recurring.slice(
      recurring.indexOf('function seatFirstHumanWindowMs'),
      recurring.indexOf('function openingHorsesForSeatFirst')
    );
    expect(fn).toMatch(/SEAT_FIRST_HUMAN_WINDOW_MIN_MS \+ secureRandomInt\(span \+ 1\)/);
    expect(recurring).toMatch(/import \{ secureRandomInt \} from '\.\.\/engine\/CryptoRandom\.js'/);
    expect(recurring).not.toMatch(/Math\.random/);
  });

  it('applies to Spins and to heads-up, and not to a 6-max field', () => {
    expect(recurring).toMatch(/seatFirstHumanWindowMs\(\)/);
    const sng = recurring.slice(recurring.indexOf('private async createSNG'));
    expect(sng).toMatch(
      /isSeatFirstFormat\('sng', config\.maxPlayers\)\s*\?\s*seatFirstHumanWindowMs\(\)\s*:\s*OPEN_TABLE_WAIT_MS/
    );
  });
});

describe('no final table announcement on a game that only ever had one table', () => {
  it('the overlay and the toast are both gated on mtt', () => {
    const branch = page.slice(
      page.indexOf("data?.type === 'final_table'"),
      page.indexOf("data?.type === 'bubble_burst'")
    );
    expect(branch).toMatch(/const fmt = tournamentFormatRef\.current;/);
    expect(branch).toMatch(/fmt === 'mtt' \? tableStateRef\.current\.tournamentId : null/);
    // The toast used to sit OUTSIDE the fetch block, so it fired regardless.
    expect(branch).toMatch(/if \(fmt === 'mtt'\) \{[\s\S]*?Final Table!/);
  });

  it('reads the format from a ref, because the callback would go stale', () => {
    expect(page).toMatch(/const tournamentFormatRef = useRef\(tournamentFormat\);/);
  });
});
