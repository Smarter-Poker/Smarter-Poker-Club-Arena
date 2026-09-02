/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEAT-FIRST BOARD SELLS ITS SEATS ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This law has TWO halves and each one exists because the other, alone, was
 * shipped and broke something. Never remove either.
 *
 * HALF ONE - count LIVE entrants, not every row that ever existed.
 * `fn_enforce_tournament_capacity` originally counted every `tournament_players`
 * row for the tournament with no status filter, so a row that reached
 * `eliminated` held its place forever. One horse leaving a REGISTERING Spin made
 * the board read 3 of 3 with two live seats, the top-up was refused
 * `tournament_full`, and the board could never again reach the three paid seats
 * it starts on. 2,059 such refusals in one hour.
 *
 * HALF TWO - once the board is no longer joinable, it takes NOBODY.
 * Fixing half one alone opened a worse hole: once a Spin is RUNNING and players
 * bust, their rows go terminal, capacity frees up, and a late registration is
 * accepted into a game already being played. Measured over the 965 seat-first
 * games created in the gap: 2 over-subscribed, 3 extra entrants, 40.00 of
 * excess prize pool. The worked example:
 *
 *     "20 Chip Spin PLO5", buy-in 20, multiplier 2 -> prize should be 40.00
 *     5 entrants on a 3-handed board
 *     prize_pool written 80.00, winner credited 80.00
 *     the reserve pool correctly drew only 40.00
 *
 * So the player was overpaid 40.00 and the extra did NOT come out of the Spin
 * treasury - precisely the divergence the treasury work exists to prevent.
 *
 * Non-seat-first formats are deliberately untouched: an MTT with late
 * registration or re-entry legitimately admits players after it starts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

describe('capacity counts the living, and a started board is closed', () => {
  const sql = migration('a_seat_first_board_is_closed_once_it_starts');

  it('still excludes terminal rows, so a departed player frees the seat', () => {
    expect(sql).toContain(
      "'eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted'"
    );
  });

  it('refuses any entrant once a seat-first board stops being joinable', () => {
    expect(sql).toMatch(/NOT IN \('ANNOUNCED', 'REGISTERING'\)/);
    expect(sql).toContain('takes no further entrants');
  });

  it('applies the closed-board rule to spins and duels only', () => {
    // An MTT with late reg or re-entry must still admit players after it starts.
    expect(sql).toMatch(/v_seat_first\s*:=\s*\(v_variant = 'spin' OR v_max <= 2\)/);
    expect(sql).toMatch(/IF v_seat_first\s*\n\s*AND upper/);
  });

  it('asserts BOTH halves at apply time, because either alone is a known bug', () => {
    expect(sql).toContain('a departed horse will deadlock the board again');
    expect(sql).toContain('a running Spin can take a fourth entrant again');
  });

  it('records the money the gap actually cost', () => {
    expect(sql).toContain('40.00');
    expect(sql).toMatch(/overpaid/i);
  });
});
