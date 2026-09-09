/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPINS AND HEADS-UP ARE SEAT-FIRST, NOT MINI-MTTs
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-21 (verbatim): "SPINS AREN'T SET UP RIGHT, YOU HAVE THEM SET UP
 * LIKE A TRADITIONAL TOURNAMENT, INSTEAD OF MORE LIKE A CASH GAME. SPINS AND
 * HEADS UP ARE FIRST COME FIRST SERVE, A PLAYER 'SITS DOWN' AT A TABLE AND BUYS
 * INTO THE SPIN OR HEADS UP, LIKE A CASH GAME, NOT LIKE A MTT TOURNAMENT. THE
 * SPIN STARTS WHEN ALL 3 PLAYERS HAVE BOUGHT INTO THE SPIN, THE HEADS UP BEGINS
 * WHEN BOTH PLAYERS BUY IN."
 *
 * The shape this pins:
 *   1. A Spin / Heads-Up is CREATED as a table with EMPTY seats. Nobody is
 *      pre-registered — pre-seeding horses is what made it a registration list.
 *   2. Taking a seat and paying are ONE atomic step
 *      (fn_take_seat_and_buy_in), so a player can never be charged without a
 *      seat or hold a seat without paying.
 *   3. Larger SNG fields and MTTs are untouched: they are events, not tables.
 *   4. An early sitter's stack is re-synced at start, because the tier drawn
 *      then may carry a different starting stack than the placeholder they
 *      sat down with (spin tiers run 300/400/500).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod } from '../helpers/sourceWindow';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const RECURRING = strip(
  readFileSync(
    resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
    'utf8'
  )
);
const BASE = strip(
  readFileSync(resolve(__dirname, '../../server/src/tournament/TournamentManagerBase.ts'), 'utf8')
);
const TABLE_PAGE = strip(readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8'));
const LOBBY = strip(readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8'));
const MIGRATION = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260821d_seat_first_spins_and_heads_up.sql'),
  'utf8'
);
const ATOMIC_CREATION = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260908043250_seat_first_board_creation_is_one_transaction.sql'
  ),
  'utf8'
);

describe('which formats are seat-first', () => {
  it('the predicate covers spins and any 2-seat game, and nothing else', () => {
    expect(RECURRING).toMatch(/export function isSeatFirstFormat/);
    // spin by variant, heads-up by seat count.
    expect(RECURRING).toMatch(/=== 'spin' \|\| maxPlayers <= 2/);
  });
});

describe('creation opens a table with empty seats', () => {
  it('a Spin creates its table up front and pre-registers NOBODY', () => {
    // Bound the slice by createSpin's OWN return, not by "the next method":
    // createSNG precedes it and the following helper is not `private async`,
    // so a name/keyword bound overran into topUpWithHorses and read its
    // registerHorses call as if it were the Spin's.
    const spinAt = RECURRING.indexOf('private async createSpin');
    const endAt = RECURRING.indexOf('return { tournamentId: spin.id', spinAt);
    expect(spinAt, 'createSpin not found').toBeGreaterThan(-1);
    expect(endAt, 'createSpin return not found').toBeGreaterThan(spinAt);
    const createSpin = RECURRING.slice(spinAt, endAt);
    expect(createSpin).toMatch(/createSeatFirstGameAtomic\(/);
    expect(createSpin).toMatch(/seedOpenSeatTable\(/);
    expect(createSpin).toMatch(/const registered = 0;/);
    // The old MTT-shaped pre-seeding must be gone from the Spin path.
    expect(createSpin).not.toMatch(/registerHorses\(/);
  });

  it('the open table commits waiting with zero players and the same real seat count', () => {
    const tournamentInsert = ATOMIC_CREATION.indexOf('INSERT INTO public.tournaments');
    const tableInsert = ATOMIC_CREATION.indexOf('INSERT INTO public.tables');
    expect(tournamentInsert).toBeGreaterThan(-1);
    expect(tableInsert).toBeGreaterThan(tournamentInsert);
    expect(ATOMIC_CREATION).toContain("v_max_players, 0, 'waiting'");
    expect(ATOMIC_CREATION).toContain('v_club_id, p_tournament_id, v_name');
  });

  it('an exact-id replay rejects every durable config or table mismatch', () => {
    for (const durableField of [
      'v_existing.club_id IS DISTINCT FROM v_club_id',
      'v_existing.union_id IS DISTINCT FROM v_union_id',
      'v_existing.name IS DISTINCT FROM v_name',
      'lower(v_existing.game_type) IS DISTINCT FROM lower(v_game_type)',
      'lower(v_existing.variant) IS DISTINCT FROM v_variant',
      'upper(v_existing.tournament_type) IS DISTINCT FROM v_tournament_type',
      'v_existing.buy_in_amount IS DISTINCT FROM v_buy_in',
      'v_existing.buy_in_fee IS DISTINCT FROM v_buy_in_fee',
      'v_existing.guaranteed_prize IS DISTINCT FROM v_guarantee',
      'v_existing.starting_chips IS DISTINCT FROM v_starting_chips',
      'v_existing.max_players IS DISTINCT FROM v_max_players',
      'v_existing.min_players IS DISTINCT FROM v_min_players',
      'v_existing.table_size IS DISTINCT FROM v_table_size',
      '(v_existing.blind_structure)::jsonb IS DISTINCT FROM v_blinds',
      '(v_existing.payout_structure)::jsonb IS DISTINCT FROM v_payouts',
      'v_existing.start_time IS DISTINCT FROM v_start_time',
      'v_existing.late_reg_levels IS DISTINCT FROM v_late_reg_levels',
      'v_existing.late_reg_mins IS DISTINCT FROM v_late_reg_mins',
      'v_existing.satellite_target_id IS DISTINCT FROM v_satellite_target_id',
      'v_existing.satellite_seats IS DISTINCT FROM v_satellite_seats',
      'v_existing.short_description IS DISTINCT FROM v_short_description',
      'v_existing_table.club_id IS DISTINCT FROM v_club_id',
      'v_existing_table.tournament_id IS DISTINCT FROM p_tournament_id',
      'v_existing_table.name IS DISTINCT FROM v_name',
      "lower(v_existing_table.game_type) IS DISTINCT FROM 'tournament'",
      'lower(v_existing_table.game_variant) IS DISTINCT FROM v_table_variant',
      'v_existing_table.small_blind IS DISTINCT FROM v_small_blind',
      'v_existing_table.big_blind IS DISTINCT FROM v_big_blind',
      'v_existing_table.max_players IS DISTINCT FROM v_max_players',
    ]) {
      expect(ATOMIC_CREATION, durableField).toContain(durableField);
    }
    expect(ATOMIC_CREATION).toContain('SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY');
    expect(ATOMIC_CREATION).toContain('SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH');
  });

  it('maps the canonical tournament game type to the exact table variant', () => {
    expect(ATOMIC_CREATION).toContain('v_table_variant := lower(v_game_type)');
    expect(ATOMIC_CREATION).toContain(
      "v_table_variant NOT IN ('nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'flh', 'flo8')"
    );
    expect(ATOMIC_CREATION).toContain(
      "v_club_id, p_tournament_id, v_name, 'tournament', v_table_variant"
    );
  });

  it('heads-up SNGs are seat-first while bigger fields keep registration', () => {
    const sngAt = RECURRING.indexOf('private async createSNG');
    const createSNG = RECURRING.slice(sngAt, RECURRING.indexOf('private async ', sngAt + 10));
    expect(createSNG).toMatch(/isSeatFirstFormat\('sng', config\.maxPlayers\)/);
    // The registration branch still exists for 6-max / 9-max.
    expect(createSNG).toMatch(/registerHorses\(/);
  });
});

describe('sitting down and paying are one atomic step', () => {
  it('the RPC exists, is security definer, and locks the table row first', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_take_seat_and_buy_in/);
    expect(MIGRATION).toMatch(/SECURITY DEFINER/);
    // The lock must be taken before any seat read, or two taps race.
    const lockAt = MIGRATION.indexOf('FOR UPDATE');
    const seatReadAt = MIGRATION.indexOf('FROM public.table_seats');
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(seatReadAt);
  });

  it('money goes through the audited registration path, never re-implemented', () => {
    expect(MIGRATION).toMatch(/public\.fn_register_for_tournament\(v_t\.id\)/);
    // No second entry-fee formula: the RPC must not compute a split itself.
    expect(MIGRATION).not.toMatch(/fn_tournament_entry_split/);
    expect(MIGRATION).not.toMatch(/atomic_deduct_wallet_and_log/);
  });

  it('it refuses politely instead of charging: taken seats, wrong format, started games', () => {
    for (const reason of [
      'seat_taken',
      'not_a_seat_first_game',
      'game_already_started',
      'invalid_seat',
    ]) {
      expect(MIGRATION, `missing refusal: ${reason}`).toContain(reason);
    }
  });

  it('re-tapping your own seat is idempotent, never a second buy-in', () => {
    expect(MIGRATION).toMatch(/'already_seated', true/);
  });

  it('seats are reused by UPDATE before INSERT (one row per seat)', () => {
    const upd = MIGRATION.indexOf('UPDATE public.table_seats');
    const ins = MIGRATION.indexOf('INSERT INTO public.table_seats');
    expect(upd).toBeGreaterThan(-1);
    expect(upd).toBeLessThan(ins);
  });
});

describe('the client buys the seat instead of opening a cash buy-in', () => {
  it('TablePage has a seat-first branch that calls the RPC', () => {
    expect(TABLE_PAGE).toMatch(/seatFirstBuyIn/);
    expect(TABLE_PAGE).toMatch(/rpc\('fn_take_seat_and_buy_in'/);
  });

  it('seat-first only applies while the game is still selling seats', () => {
    expect(TABLE_PAGE).toMatch(/REGISTERING/);
    expect(TABLE_PAGE).toMatch(/setSeatFirstBuyIn\(null\)/);
  });

  it('the lobby tile OPENS THE TABLE and never registers the player', () => {
    const fn = LOBBY.slice(
      LOBBY.indexOf('const spinQuickJoin'),
      LOBBY.indexOf('const spinQuickJoin') + 4000
    );
    // The tile navigates to the table...
    expect(fn.indexOf('navigate(`/table/${tableId}`)')).toBeGreaterThan(-1);

    /**
     * ...and registration is GONE, not merely late (Dan 2026-08-23: "it
     * currently now only gives you this generic 'dealing you in' pop up").
     * That pop-up was the fallback branch calling fn_register_for_tournament,
     * which takes the buy-in before the player has chosen a seat. A tile must
     * never move money. Comments naming the retired call are fine; a live call
     * is not.
     */
    expect(fn).not.toMatch(/rpc\(\s*'fn_register_for_tournament'/);
    expect(fn).not.toMatch(/Dealing You In/);
  });
});

describe('an early sitter is not left on the placeholder stack', () => {
  it('start credits seated stacks to the drawn tier', () => {
    // The sync moved into creditSeatStacks() on 2026-08-21 so it could be
    // called from a timer AFTER the wheel (Dan: "AFTER THE SPIN COMPLETES,
    // CHIP STACKS GET ADDED"). It is the same write, made idempotent and
    // reusable; tests/unit/spinPostReveal.test.ts pins the new ordering.
    expect(BASE).toMatch(/seat_stack_credit_failed|Credited .* seat\(s\) to/);
    const credit = sliceMethod(BASE, 'protected async creditSeatStacks');
    expect(credit).toMatch(/from\('table_seats'\)/);
    expect(credit).toMatch(/\.update\(\{ stack: target \}\)/);
    expect(credit).toMatch(/Number\(tournament\?\.starting_chips\)/);
  });

  it('a seat still holds ZERO chips until the tier is known', () => {
    // The reservation model: stack depth belongs to the tier (300/400/500),
    // so there is no honest number to seat a player with before the draw.
    // Crediting at start put stacks on the felt mid-spin.
    expect(BASE).toMatch(/deferStacksForSpinReveal/);
  });
});
