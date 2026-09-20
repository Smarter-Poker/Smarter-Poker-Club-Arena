/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND SEAT EXIT GOES HOME THROUGH ITS OWN DOOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 8 of the Diamond Arena programme, closed by its recheck. The lobby's
 * unregistration door routed a Diamond entry to the Diamond door; five other
 * callers of the chip unregistration authority did not, and the seat exit a
 * heads-up or sit-and-go player uses was one of them. The migration:
 *
 *   1. Routes inside the authority itself (fn_ca_unregister_tournament_player_exact),
 *      so every caller - lobby, seat, administrator, launch, and any future one -
 *      sends a Diamond entry home before a chip rail is touched, minting a
 *      request id for callers that named none exactly as the authority does.
 *   2. Passes asset and diamonds_after through the seat-first receipt.
 *   3. Makes the Diamond door replay a settled request id with the whole
 *      receipt (the client parses a replay as a receipt) and keeps the chip
 *      authority's clock (scheduled events close at start_time; seat-first
 *      products close when they actually start; the launch's release is held
 *      to the seat-first proofs; a persisted hand closes everything).
 *
 * Every chip edit is in place with the live md5 pinned and the reverse
 * substitution proved; the Diamond door is pinned, redefined with the same
 * signature and declared to the guard watch; the door is never opened.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_seat_exit_goes_home_through_its_own_door.sql'))
  .at(-1);
if (!NAME) throw new Error('the seat-exit migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const AUTHORITY = section(
  '-- 1. THE CHIP UNREGISTRATION AUTHORITY SENDS A DIAMOND ENTRY HOME',
  '-- 2. THE SEAT-FIRST RECEIPT NAMES ITS ASSET'
);
const RECEIPT = section(
  '-- 2. THE SEAT-FIRST RECEIPT NAMES ITS ASSET',
  '-- 3. THE DIAMOND DOOR REPLAYS ITS RECEIPT AND KEEPS THE CHIP CLOCK'
);
const DOOR = section(
  '-- 3. THE DIAMOND DOOR REPLAYS ITS RECEIPT AND KEEPS THE CHIP CLOCK',
  '-- 4. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 4. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});

describe('LAW: a Diamond seat exit goes home through its own door', () => {
  it('opens nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(FINAL).toContain('this migration must not open the tournament door');
  });

  it('routes inside the one authority every exit door calls, in place, minting a request id as the authority does', () => {
    expect(pinnedEdits(AUTHORITY)).toEqual({ pins: 1, reversals: 1 });
    expect(AUTHORITY).toContain("'46c455cf3f8195704da7182dc888fb30'");
    expect(AUTHORITY).toContain(
      "'public.fn_ca_unregister_tournament_player_exact(uuid, uuid, uuid, text, uuid)'::regprocedure"
    );
    expect(AUTHORITY).toContain('IF public.fn_poker_diamond_tournament(p_tournament_id) THEN');
    expect(AUTHORITY).toContain(
      'p_tournament_id, p_user_id, COALESCE(p_request_id, gen_random_uuid()));'
    );
    // the seat check the chip authority gives: not_seated, unless the request id is already settled
    expect(AUTHORITY).toContain(
      "RETURN jsonb_build_object(''ok'',false,''reason'',''not_seated'');"
    );
    expect(AUTHORITY).toContain("l.request->>''request_id''=p_request_id::text");
    // the route is prepended: the chip lane clause survives verbatim after it
    expect(AUTHORITY).toMatch(/\|\| v_old;/);
    expect(FINAL).toContain("'fn_leave_seat_and_refund','fn_unregister_from_tournament'");
    expect(FINAL).toContain(
      "'fn_admin_remove_tournament_player','fn_ca_release_unseatable_registrant_at_launch'"
    );
    expect(FINAL).toContain('no longer reaches the unregistration authority');
  });

  it('the seat-first receipt passes asset and diamonds_after through, in place', () => {
    expect(pinnedEdits(RECEIPT)).toEqual({ pins: 1, reversals: 1 });
    expect(RECEIPT).toContain("'14d555291b857c15912d4028828f3d5b'");
    expect(RECEIPT).toContain(
      "jsonb_build_object(''asset'', v_reg->''asset'', ''diamonds_after'', v_reg->''diamonds_after'')"
    );
    expect(RECEIPT).toContain("CASE WHEN v_reg ? ''asset''");
    expect(FINAL).toContain(
      'the seat-first receipt does not pass asset and diamonds_after through'
    );
  });

  it('the Diamond door is pinned, keeps its signature, replays a whole receipt and is declared', () => {
    expect(DOOR).toContain("'84fc1ea36ee4338b646af2b4675aa70b'");
    expect(DOOR).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)'
    );
    expect(DOOR).toContain('SECURITY DEFINER');
    expect(DOOR).toContain("SET search_path TO 'public', 'pg_temp'");
    const replay = sliceBetween(DOOR, "'idempotent',true", 'END IF;');
    for (const key of [
      "'request_id'",
      "'refunded_diamonds'",
      "'registration_id'",
      "'asset','diamonds'",
      "'diamonds_after'",
    ]) {
      expect(replay).toContain(key);
    }
    expect(DOOR).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(DOOR).toContain(
      "fn_ca_declare_guard_redefinition(\n  'fn_poker_diamond_tournament_unregister',"
    );
    expect(FINAL).toContain(
      "has_function_privilege('authenticated', 'public.fn_poker_diamond_tournament_unregister(uuid, uuid, uuid)', 'EXECUTE')"
    );
  });

  it('the Diamond door keeps the chip clock', () => {
    const body = code(DOOR);
    expect(body).toContain("v_authority := 'spin_actual_start'");
    expect(body).toContain("v_authority := 'heads_up_sng_actual_start'");
    expect(body).toContain("v_authority := 'launch_release'");
    expect(body).toContain("current_setting('app.ca_launch_release_launch_id',true)");
    expect(body).toContain('clock_timestamp()>=v_t.start_time');
    expect(body).toContain("'registration_schedule_unset'");
    expect(body).toContain('FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id');
    expect(body).toContain('r.completed_at IS NOT NULL');
    // money still moves through the refund door, and the same roster effects follow
    expect(body).toContain('public.fn_poker_diamond_tournament_refund(');
    expect(body).toContain('DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;');
    expect(FINAL).toContain('the Diamond unregister does not keep the chip clock');
  });

  it('asserts at the end that every watched guard is on its baseline', () => {
    expect(FINAL).toContain('watched guards off their baseline');
    expect(FINAL).toContain('public.fn_ca_guard_watchlist()');
  });
});
