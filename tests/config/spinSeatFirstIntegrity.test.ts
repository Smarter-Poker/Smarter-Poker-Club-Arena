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
import { sliceMethod } from '../helpers/sourceWindow';

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
    // 2026-08-27: a third argument was added (the freeroll all-lanes
    // override). The property here is REACHABILITY of the registration path
    // with the computed shortfall, not the arity, so the trailing arguments
    // are left open. The two leading arguments stay pinned.
    expect(topUp).toMatch(/registerHorses\(tournamentId, shortfall[),]/);
  });

  it('never takes a horse out of a game it is already in', () => {
    /**
     * 2026-08-23: the busy-set reads moved OUT of pickFreeHorses and into
     * horseLoadMap, when Dan raised the limit from "excluded at one game" to
     * "up to four tables". The slice therefore starts at horseLoadMap now.
     *
     * The property under test has not changed and is not weakened: a horse's
     * commitments are still read from tournament_players and table_seats
     * before it is handed out, and a horse at the ceiling is still excluded.
     * What changed is the ceiling, not whether we look.
     */
    const pick = recurring.slice(
      recurring.indexOf('private async horseLoadMap'),
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
    // 2026-08-27: an optional second argument was added (the freeroll
    // all-lanes override, defaulted so every existing caller is unchanged).
    // The property under test is the PLURAL, count-taking, batched shape -
    // one call answering with many horses - so the first parameter and the
    // string[] return stay pinned and the optional tail is left open.
    expect(recurring).toMatch(
      /private async pickFreeHorses\(\s*count:\s*number[,)][^)]*\)\s*:\s*Promise<string\[\]>/
    );
    // The singular form must be gone, or a caller can quietly reintroduce the
    // per-horse shape.
    expect(recurring).not.toMatch(/pickFreeHorse\(\)/);

    /**
     * SLICE TO THE TWO METHODS THIS TEST IS ABOUT (2026-08-25).
     *
     * The end marker was `private async createSpin`, which is four methods
     * further down the file, so the count silently covered everything in
     * between. #805 landed `unseatedRegistrantHorses` in that gap - a read
     * that runs ONCE PER GAME to fill a seat-first game from its own roster,
     * not once per horse - and this assertion went red on `main` for a query
     * it was never written to police. A guard that fails on unrelated code is
     * a guard nobody can ship past.
     *
     * `unseatedRegistrantHorses` is the method immediately after
     * `pickFreeHorses`, so ending there scopes the count to exactly the pair
     * named in the comment below, which is what it always claimed to measure.
     */
    const pick = recurring.slice(
      recurring.indexOf('private async horseLoadMap'),
      recurring.indexOf('private async unseatedRegistrantHorses')
    );
    // Exactly one read of each source across horseLoadMap + pickFreeHorses,
    // which together are one call. The batching this protects is unchanged -
    // the reads simply live in horseLoadMap now (see the note above).
    expect((pick.match(/from\('tournament_players'\)/g) || []).length).toBe(1);
    expect((pick.match(/from\('table_seats'\)/g) || []).length).toBe(1);
    expect((pick.match(/from\('profiles'\)/g) || []).length).toBe(1);

    /* #805's roster-full path reads the same three tables to find registrants
       who hold no seat. Same rule: one batched read each, and no query inside
       a loop - a per-registrant scan here would be the same saturation by
       another door, on the same five-second discovery pass. */
    const unseated = recurring.slice(
      recurring.indexOf('private async unseatedRegistrantHorses'),
      recurring.indexOf('private async createSpin')
    );
    expect(unseated.length, 'unseatedRegistrantHorses has moved or been renamed').toBeGreaterThan(
      0
    );
    for (const table of ['tournament_players', 'table_seats', 'profiles']) {
      expect(
        (unseated.match(new RegExp(`from\\('${table}'\\)`, 'g')) || []).length,
        `${table} must be read exactly once in unseatedRegistrantHorses`
      ).toBe(1);
    }
    expect(
      /(for|while)\s*\([\s\S]{0,400}?\.from\(/.test(unseated),
      'a query inside a loop in unseatedRegistrantHorses is the per-horse shape again'
    ).toBe(false);

    /**
     * ...AND ONCE PER CALL, which the widened window alone no longer proves.
     *
     * Counting reads across horseLoadMap + pickFreeHorses keeps the "one read
     * of each source" property, but it stops being a statement about how OFTEN
     * they run: the load map now lives behind a call, and a caller that awaits
     * it once per horse inside a loop would still count exactly one of each and
     * pass. That is precisely the per-horse shape the case above exists to
     * forbid, so it has to be pinned where it now actually lives.
     */
    const picker = recurring.slice(
      recurring.indexOf('private async pickFreeHorses'),
      recurring.indexOf('private async createSpin')
    );
    expect((picker.match(/this\.horseLoadMap\(\)/g) || []).length).toBe(1);
    expect(picker).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*horseLoadMap/);
  });

  it('both callers batch, so neither loops a query', () => {
    // Anchored on the DEFINITION, not the first mention: the first occurrence of
    // `createOpenSeatTable` is a call site, and slicing a method from there
    // returns the call, not the body.
    for (const caller of ['private async createOpenSeatTable(', 'async topUpWithHorses(']) {
      expect(recurring.indexOf(caller), `${caller} is gone`).toBeGreaterThan(-1);
      // The held-empty gates (Dan 2026-08-26) sit between each entry point and
      // its pickFreeHorses call, so the window has to be the whole method - a
      // byte count here only says how long the gates happened to be that day.
      const body = sliceMethod(recurring, caller);
      expect(body).toMatch(/pickFreeHorses\(/);
    }
  });
});

describe('the last seat belongs to a human for 45 to 90 seconds', () => {
  it('the window is 45 to 90 seconds (Dan 2026-09-01: "WAIT ANYWHERE FROM 45-90 SECONDS FOR A HUMAN, BEFORE A HORSE JUMPS IN")', () => {
    expect(recurring).toMatch(/SEAT_FIRST_HUMAN_WINDOW_MIN_MS = 45 \* 1000/);
    expect(recurring).toMatch(/SEAT_FIRST_HUMAN_WINDOW_MAX_MS = 90 \* 1000/);
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
