import * as fs from 'fs';
import * as path from 'path';
/**
 * HORSE CONCURRENCY — Dan 2026-08-23: "each horse can play up to 4 tables"
 *
 * Before this, a horse holding ONE seat or ONE registration was invisible to
 * every tournament. Measured live: 584 horses existed and 37 were pickable,
 * because 554 were dealing cash. Tournament fields and cash tables were
 * competing for the same fleet instead of sharing it.
 *
 * The two things worth pinning are the ceiling itself and the double-count
 * rule underneath it. Getting the second one wrong is silent: it does not
 * throw, it just halves the effective ceiling and nobody notices except that
 * fields stay thin.
 */
import { describe, it, expect } from 'vitest';
import {
  buildHorseLoadMap,
  horseAtCapacity,
  HORSE_MAX_CONCURRENT_TABLES,
  REGISTRATION_LOAD_HORIZON_MS,
} from './TournamentRecurringService.js';

describe('horse concurrency ceiling', () => {
  it('is four, which is the number Dan gave', () => {
    expect(HORSE_MAX_CONCURRENT_TABLES).toBe(4);
  });

  it('lets a horse in below the ceiling and stops it at the ceiling', () => {
    expect(horseAtCapacity(0)).toBe(false);
    expect(horseAtCapacity(3)).toBe(false);
    expect(horseAtCapacity(4)).toBe(true);
    expect(horseAtCapacity(9)).toBe(true);
  });

  it('a horse dealing one cash table is still available for a tournament', () => {
    // The whole point of the change. Under the old rule this horse was out.
    const load = buildHorseLoadMap(['h1'], []);
    expect(horseAtCapacity(load.get('h1') ?? 0)).toBe(false);
  });

  it('treats a nonsense load as free rather than locking the fleet out', () => {
    expect(horseAtCapacity(Number.NaN)).toBe(false);
    expect(horseAtCapacity(undefined as unknown as number)).toBe(false);
  });
});

describe('horse load counting', () => {
  it('counts each live seat as one game', () => {
    const load = buildHorseLoadMap(['h1', 'h1', 'h2'], []);
    expect(load.get('h1')).toBe(2);
    expect(load.get('h2')).toBe(1);
  });

  it('counts a not-yet-started registration as one game', () => {
    const load = buildHorseLoadMap([], ['h1', 'h1']);
    expect(load.get('h1')).toBe(2);
  });

  it('sums seats and pending registrations', () => {
    const load = buildHorseLoadMap(['h1', 'h1'], ['h1']);
    expect(load.get('h1')).toBe(3);
    expect(horseAtCapacity(load.get('h1') ?? 0)).toBe(false);
    const full = buildHorseLoadMap(['h1', 'h1'], ['h1', 'h1']);
    expect(horseAtCapacity(full.get('h1') ?? 0)).toBe(true);
  });

  it('an unknown horse has no load', () => {
    const load = buildHorseLoadMap(['h1'], []);
    expect(load.get('nobody')).toBeUndefined();
    expect(horseAtCapacity(load.get('nobody') ?? 0)).toBe(false);
  });

  it('ignores null and undefined ids rather than counting them as a horse', () => {
    const load = buildHorseLoadMap([null, undefined, 'h1'], [null]);
    expect(load.size).toBe(1);
    expect(load.get('h1')).toBe(1);
  });
});

/**
 * ONE GAME IS ONE GAME (2026-08-28).
 *
 * The old counter summed the two lists blindly. Its comment argued that a
 * RUNNING tournament's entrants arrive only through the seat list, so nothing
 * could be counted twice — true, and not enough. A SEAT-FIRST game sells the
 * chair BEFORE it starts, so a spin sitting at REGISTERING has both a seat row
 * and a pending registration for the same horse and the same game.
 *
 * Measured against production the day this was written: 20 accounts read as
 * over the four-game cap, and only 3 actually were. Seventeen horses were held
 * out of every board by a game they were playing once.
 */
describe('a seat-first chair is not two games', () => {
  it('drops the registration when a seat at that tournament is already held', () => {
    const load = buildHorseLoadMap(
      [{ user_id: 'h1', tournament_id: 't1' }],
      [{ user_id: 'h1', tournament_id: 't1' }]
    );
    expect(load.get('h1')).toBe(1);
  });

  it('a spin plus three cash tables is four games, not five', () => {
    const load = buildHorseLoadMap(
      [
        { user_id: 'h1', tournament_id: 't1' },
        { user_id: 'h1', tournament_id: null },
        { user_id: 'h1', tournament_id: null },
        { user_id: 'h1', tournament_id: null },
      ],
      [{ user_id: 'h1', tournament_id: 't1' }]
    );
    expect(load.get('h1')).toBe(4);
    expect(horseAtCapacity(load.get('h1') ?? 0)).toBe(true);
  });

  it('still counts a booking for a DIFFERENT tournament', () => {
    // The dedupe must not become a licence to double-book.
    const load = buildHorseLoadMap(
      [{ user_id: 'h1', tournament_id: 't1' }],
      [{ user_id: 'h1', tournament_id: 't2' }]
    );
    expect(load.get('h1')).toBe(2);
  });

  it('counts an unattributed booking rather than guessing it away', () => {
    // Under-counting hands out a horse that is already full and the database
    // refuses the claim. Over-counting only costs a pass. Prefer the cheap
    // mistake when the pairing is unknown.
    const load = buildHorseLoadMap([{ user_id: 'h1', tournament_id: 't1' }], ['h1']);
    expect(load.get('h1')).toBe(2);
  });

  it('accepts bare ids exactly as before', () => {
    // Every existing caller and test passes plain strings; widening the input
    // must not change what they measure.
    expect(buildHorseLoadMap(['h1', 'h1'], ['h1']).get('h1')).toBe(3);
  });
});

describe('the double-count rule, which is the one that fails silently', () => {
  /**
   * A RUNNING tournament's entrants hold SEATS, so they reach the load map
   * through the seat list. The registration query must therefore ask only for
   * ANNOUNCED and REGISTERING. If RUNNING crept back in, every tournament
   * regular would read as 2 and the effective ceiling would halve to two
   * tables without a single test failing anywhere else.
   */
  it('the registration query excludes RUNNING', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
      'utf8'
    ) as string;
    const start = src.indexOf('private async horseLoadMap');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('private static atCapacity'));
    expect(body).toContain("'ANNOUNCED', 'REGISTERING'");
    expect(body).not.toContain("'ANNOUNCED', 'REGISTERING', 'RUNNING'");
  });

  /**
   * A REGISTRATION DAYS AWAY IS NOT A GAME TODAY (2026-09-07). Without a
   * horizon, 2,092 bookings for events hours to days out held 615 of 1,000
   * horses out of every open seat-first board (measured: 160 boards open, 36
   * of 367 seats paid, "0 of 3 claimable"). The query bounds start_time so a
   * booking counts only when its event is about to seat its field; a null
   * start_time (a seat-first game that starts when full) is still counted and
   * deduped against its own seat.
   */
  it('the registration query counts a booking only inside the start horizon', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
      'utf8'
    ) as string;
    const start = src.indexOf('private async horseLoadMap');
    const body = src.slice(start, src.indexOf('private static atCapacity'));
    expect(body).toContain('tournaments!inner(status, start_time)');
    expect(body).toMatch(
      /\.or\(`start_time\.is\.null,start_time\.lte\.\$\{horizonIso\}`, \{ referencedTable: 'tournaments' \}\)/
    );
    expect(body).toContain('REGISTRATION_LOAD_HORIZON_MS');
  });

  it('the horizon is thirty minutes: longer than any seat-first game, shorter than any ramp', () => {
    expect(REGISTRATION_LOAD_HORIZON_MS).toBe(30 * 60_000);
  });

  it('a horse seated in a running event is counted once, not twice', () => {
    // Seat list carries it; the registration list correctly does not.
    const load = buildHorseLoadMap(['h1'], []);
    expect(load.get('h1')).toBe(1);
  });
});
