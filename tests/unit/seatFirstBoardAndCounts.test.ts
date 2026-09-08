/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN BOARD WEDGED ITSELF, AND THE HEADER COUNTED THE WRONG THINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23:
 *   "make sure the horses are sitting and playing the spins. two horses should
 *    fill the first two seats... wait 60-180 seconds before a 3rd horse sits."
 *   "club jaqk doesn't have 1172 players, and there are more then 12 active"
 *   "shark club same issue... says 0 current and bounces back and forth from
 *    1172 players to 588"
 *
 * MEASURED BEFORE ANY OF THIS. Of 33 REGISTERING Spins, THIRTY had no table
 * row at all; of 17 heads-ups, FOURTEEN. Oldest 15 hours old. None of them
 * could ever be joined, because a seat-first game is a table with seats and
 * they had no table.
 *
 * The board keeper decides what to open by NAME: a husk is REGISTERING, so
 * its name is "covered", so its price point is never reopened -- and it can
 * never leave REGISTERING, because a seat-first game starts when every seat is
 * sold. One dead row wedges one price point permanently. Exactly two of
 * thirty-two Spin configs were still cycling.
 *
 * Separately, fn_seat_horse_in_seat_first_game updated tables.current_players
 * and not tournaments.current_players -- the number the lobby card reads. So
 * the two healthy Spins, with horses genuinely sitting in seats 1 and 2, were
 * advertised to every player as 0/3. The horses were sitting; the board lied.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const service = read('server/src/services/TournamentRecurringService.ts');
const clubHome = read('src/pages/ClubHomePage.tsx');

const migrations = readdirSync(join(ROOT, 'supabase/migrations'));
const sqlNamed = (needle: string) =>
  migrations
    .filter((f) => f.includes(needle))
    .map((f) => read(join('supabase/migrations', f)))
    .join('\n');

const seatFirstSql = sqlNamed('seat_first_games_that_can_never_be_joined');
const atomicSeatFirstSql = sqlNamed('seat_first_board_creation_is_one_transaction');
const strictStageBSql = sqlNamed('tournament_manager_request_fencing_is_strict');
const countsSql = sqlNamed('club_home_own_members_and_live_players');

describe('a listing only counts if a player could sit at it', () => {
  it('retains the historical damage record and ships the atomic creator', () => {
    expect(seatFirstSql.length).toBeGreaterThan(0);
    expect(atomicSeatFirstSql.length).toBeGreaterThan(0);
  });

  it('creates each new listing and its table inside one transaction', () => {
    const tournamentInsert = atomicSeatFirstSql.indexOf('INSERT INTO public.tournaments');
    const tableInsert = atomicSeatFirstSql.indexOf('INSERT INTO public.tables');
    expect(tournamentInsert).toBeGreaterThan(-1);
    expect(tableInsert).toBeGreaterThan(tournamentInsert);
    expect(atomicSeatFirstSql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(atomicSeatFirstSql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('retires the timer-driven repair after one bounded migration pass', () => {
    expect(atomicSeatFirstSql).not.toContain(
      'DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games(integer)'
    );
    expect(strictStageBSql).toContain('SELECT public.fn_repair_seat_first_games(1000)');
    expect(strictStageBSql).toContain('unjoinable legacy listing remains');
    expect(strictStageBSql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games(integer)'
    );
    expect(strictStageBSql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games_before_maintenance_gate(integer)'
    );
    expect(service).not.toContain("supabase.rpc('fn_repair_seat_first_games'");
    expect(service).toContain("supabase.rpc('fn_create_seat_first_game_atomic'");
  });

  it('makes the seating function maintain the count the lobby reads', () => {
    expect(seatFirstSql).toMatch(/UPDATE public\.tournaments t/);
    expect(seatFirstSql).toMatch(/SET current_players =/);
  });

  it('keys ambiguous retries to the caller-generated tournament identity', () => {
    expect(service).toMatch(/const tournamentId = nodeCrypto\.randomUUID\(\)/);
    expect(atomicSeatFirstSql).toContain("'replayed', true");
    expect(atomicSeatFirstSql).toContain('SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH');
  });

  it('will not treat a seat-first game without a joinable table as covering its price point', () => {
    expect(service).toMatch(/joinability read failed/);
    expect(service).toMatch(/withJoinableTable\.has\(r\.id\)/);
    expect(service).toContain(".select('tournament_id, status, is_deleted')");
    expect(service).toContain('isJoinableTableRow');
  });
});

describe('the club header counts what it says it counts', () => {
  it('ships the counts migration', () => {
    expect(countsSql.length).toBeGreaterThan(0);
  });

  it('counts THIS club members, not the union', () => {
    expect(countsSql).toMatch(/WHERE cm\.club_id = v_club\.id/);
    expect(countsSql).toMatch(/the union total is not this club/);
    // And the client no longer answers with a different number.
    expect(clubHome).not.toMatch(/totalMembers/);
  });

  it('counts players from the seats, never from the stale column', () => {
    expect(countsSql).toMatch(/count\(DISTINCT ts\.user_id\)/);
    expect(countsSql).toMatch(/still carries the stale clubs\.online_count/);
    // The header passes the live figure into the shared identity card.
    expect(clubHome).toContain('playersPlaying={playersPlaying}');
    expect(clubHome).not.toMatch(/club\.online_count\.toLocaleString/);
  });
});
