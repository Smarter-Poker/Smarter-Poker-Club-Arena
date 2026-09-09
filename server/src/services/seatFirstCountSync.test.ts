/**
 * SEAT-FIRST GAMES MUST ADVERTISE THE SEATS THEY HAVE SOLD — Dan 2026-08-23
 *
 * A Spin or heads-up SNG starts on SEATS BOUGHT, so its lobby number has to
 * come from the seat rows. Every canonical seat transaction now writes that
 * exact count before returning its receipt; application-side recounts are a
 * forbidden second writer.
 *
 * seedOpenSeatTable was the one that did not. Measured live: 16 open Spins
 * advertising "0/3" while holding 32 paid seats between them - two of three
 * sold, one seat from dealing, and the lobby said empty. The fourteen that
 * read correctly had all been through topUpWithHorses, which syncs.
 *
 * This is a source-shape assertion rather than a behavioural one, matching
 * afkSitOutGuard.test.ts and ActionPacing.test.ts. The regression is a MISSING
 * CALL, and the seating path needs a live Postgres to exercise - so the thing
 * worth pinning is that the call is still there, next to the seating it
 * describes. A behavioural test would need the database this cannot have.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(process.cwd(), 'src/services/TournamentRecurringService.ts'), 'utf8');

/** The body of seedOpenSeatTable, so assertions cannot pass on a neighbour. */
function seedOpenSeatTableBody(): string {
  const start = src.indexOf('private async seedOpenSeatTable');
  expect(start).toBeGreaterThan(-1);
  // Up to the next method at the same indent level.
  const rest = src.slice(start);
  const end = rest.indexOf('\n  /**\n   * Horses that are genuinely free');
  return end > -1 ? rest.slice(0, end) : rest;
}

describe('seat-first lobby counts', () => {
  it('seedOpenSeatTable uses only the atomic seating authority', () => {
    const body = seedOpenSeatTableBody();
    expect(body).toContain('fn_seat_horse_in_seat_first_game');
    expect(body).not.toContain('fn_sync_seat_first_player_count');
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * topUpWithHorses must branch: seat-first derives current_players from the
   * SEAT rows, MTTs use the registration count. That branch was written,
   * reviewed, and lost - the explanatory comment merged into main while the
   * code under it was flattened to the MTT half alone. Prose is not a
   * safeguard, so this is.
   */
  it('topUpWithHorses seats through the atomic root and keeps the MTT registration read separate', () => {
    const start = src.indexOf('async topUpWithHorses');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('private async registerHorses'));

    // The branch itself.
    expect(body).toMatch(/if\s*\(seatFirst\)\s*\{/);
    expect(body).toContain('fn_seat_horse_in_seat_first_game');
    expect(body).not.toContain('fn_sync_seat_first_player_count');

    // And the MTT half still reads the registration count, in the else.
    const seatFirstAt = body.indexOf('if (seatFirst)');
    const registrationCountAt = body.indexOf(
      "in('status', ['registered', 'playing'])",
      seatFirstAt
    );
    expect(registrationCountAt).toBeGreaterThan(seatFirstAt);
  });

  it('the service never writes a seat-first count it merely counted up', () => {
    // Registrations and seats disagree constantly for these formats. A counter
    // that counts registrations is what had spins reading 3/3 on two bought
    // seats and 0/3 on three.
    const executable = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(executable).not.toContain('fn_sync_seat_first_player_count');
    expect(src).not.toMatch(/current_players:\s*seated\b/);
  });
});

describe('nothing writes a seat-first count the application invented', () => {
  /**
   * THE ROOT CAUSE, and the reason two earlier fixes did not take.
   *
   * createSpin seats two horses in real seats, then its very next statement
   * used to write `current_players: registered` where `registered` is a
   * hardcoded 0 - a leftover from when a Spin pre-registered nobody. Both the
   * sync inside seedOpenSeatTable and the trigger on table_seats set the
   * number correctly, and this overwrote it microseconds later. 16 open Spins
   * advertised "0/3" on 32 paid seats because of one stale constant.
   */
  /**
   * Comments are stripped first, and that is not incidental: the comment
   * explaining this bug necessarily QUOTES the line it forbids, so an
   * assertion against raw source fails on its own documentation. Match code.
   */
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  function bodyOf(fnName: string, endMarker: string): string {
    const start = src.indexOf(fnName);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(endMarker, start);
    return stripComments(src.slice(start, end > -1 ? end : undefined));
  }

  it('createSpin sets status only, never the player count', () => {
    const body = bodyOf('async createSpin', 'return { tournamentId: spin.id');
    expect(body).toContain('seedOpenSeatTable');
    // The clobber, in any spacing.
    expect(body).not.toMatch(/current_players:\s*registered/);
  });

  it('createSNG writes the count only for FIELD sngs, never seat-first ones', () => {
    const body = bodyOf('async createSNG', 'return { tournamentId: sng.id');
    // Guarded by the seat-first test rather than written unconditionally.
    expect(body).toMatch(/isSeatFirstFormat\('sng'/);
    expect(body).toMatch(/if\s*\(!seatFirstSng\)/);
    // The unconditional form must not come back.
    expect(body).not.toMatch(/\.update\(\{\s*current_players:\s*registered,/);
  });
});
