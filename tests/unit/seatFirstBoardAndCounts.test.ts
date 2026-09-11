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
const seatFirstRetirementSql = sqlNamed('seat_first_inventory_is_created_atomically');
const legacyPlayedAdoptionSql = sqlNamed('legacy_played_seat_first_games_are_adopted_as_running');
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

  it('retires the timer-driven repair without mutating unrelated joinable boards', () => {
    expect(atomicSeatFirstSql).not.toContain(
      'DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games(integer)'
    );
    expect(seatFirstRetirementSql).not.toContain('SELECT public.fn_repair_seat_first_games(1000)');
    expect(seatFirstRetirementSql).toContain(
      'unjoinable legacy listing requires intentional repair'
    );
    expect(seatFirstRetirementSql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_repair_seat_first_games(integer) RESTRICT'
    );
    expect(seatFirstRetirementSql).toContain(
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

  it('adopts only the measured pre-atomic games that already dealt real hands', () => {
    expect(legacyPlayedAdoptionSql.length).toBeGreaterThan(0);
    expect(legacyPlayedAdoptionSql).toContain('v_count IS DISTINCT FROM 39');
    expect(legacyPlayedAdoptionSql).toContain('v_hand_count IS DISTINCT FROM 870');
    expect(legacyPlayedAdoptionSql).toContain('v_spin_count IS DISTINCT FROM 22');
    expect(legacyPlayedAdoptionSql).toContain('v_heads_up_count IS DISTINCT FROM 17');
    expect(legacyPlayedAdoptionSql).toContain(
      '3d7f10f5150526e93c8e302837da8f9f6a8265f4fcb6d0d83870b0c44de77aec'
    );
    expect(legacyPlayedAdoptionSql).toContain('FOR UPDATE OF t NOWAIT');
    expect(legacyPlayedAdoptionSql).toContain('FOR UPDATE OF p NOWAIT');
    expect(legacyPlayedAdoptionSql).toContain('FOR UPDATE OF tb NOWAIT');
    expect(legacyPlayedAdoptionSql).toContain('FOR UPDATE OF s NOWAIT');
    const realtimeLock = legacyPlayedAdoptionSql.indexOf(
      'LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT'
    );
    const leaseLock = legacyPlayedAdoptionSql.indexOf(
      'LOCK TABLE public.engine_tournament_leases,'
    );
    const tournamentLock = legacyPlayedAdoptionSql.indexOf(
      'DISABLE TRIGGER zz_freeze_launch_guard'
    );
    expect(realtimeLock).toBeGreaterThan(-1);
    expect(leaseLock).toBeGreaterThan(realtimeLock);
    expect(tournamentLock).toBeGreaterThan(leaseLock);
    expect(legacyPlayedAdoptionSql).toContain('pointed.tournament_id = p.tournament_id');
    expect(legacyPlayedAdoptionSql).toContain("pointed.status = 'running'");
  });

  it('changes only the historical parent lifecycle fields and invents no receipt', () => {
    const disable = legacyPlayedAdoptionSql.indexOf('DISABLE TRIGGER zz_freeze_launch_guard');
    const update = legacyPlayedAdoptionSql.indexOf('UPDATE public.tournaments t');
    const enable = legacyPlayedAdoptionSql.indexOf('ENABLE TRIGGER zz_freeze_launch_guard');

    expect(disable).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(disable);
    expect(enable).toBeGreaterThan(update);
    expect(legacyPlayedAdoptionSql).toMatch(
      /SET status = 'RUNNING',\s+started_at = a\.first_hand_at,\s+updated_at = clock_timestamp\(\)/
    );
    expect(legacyPlayedAdoptionSql).toContain(
      "to_jsonb(t) - ARRAY['status', 'started_at', 'updated_at']::text[]"
    );
    expect(legacyPlayedAdoptionSql).not.toMatch(
      /INSERT\s+INTO\s+public\.tournament_launch_receipts/i
    );
    expect(legacyPlayedAdoptionSql).not.toMatch(
      /UPDATE\s+public\.(?:wallets|table_seats|tournament_players)/i
    );
    expect(legacyPlayedAdoptionSql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
    expect(legacyPlayedAdoptionSql).not.toMatch(/\bSELECT\s+cron\.schedule|pg_cron/i);
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
