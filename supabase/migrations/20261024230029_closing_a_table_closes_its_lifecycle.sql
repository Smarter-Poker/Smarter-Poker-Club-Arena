-- 20261024230029_closing_a_table_closes_its_lifecycle.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE CAUSE. The managed close door, fn_close_managed_game('table', id),
-- closes a cash table with
--   UPDATE public.tables SET status = 'closed', current_players = 0, ...
-- and never writes lifecycle. Every other path that closes a table writes
-- status and lifecycle together: fn_cash_cluster_tick,
-- fn_poker_diamond_close_cash_table, atomic_cancel_tournament,
-- fn_complete_tournament_terminal_pre_seat_guard, both satellite closeouts
-- and fn_poker_diamond_tournament_cancel. So every table closed through the
-- door was left status='closed' but lifecycle='live': a dead table that the
-- cluster still counts as its own. fn_cash_cluster_census, fn_cash_game_join
-- (its table count and existing-seat check), fn_offer_open_seat's sweep and
-- idx_tables_cluster_open all select lifecycle <> 'closed', and
-- fn_closed_cluster_main_releases_index only releases a main table's
-- main_index once lifecycle becomes 'closed'.
--
-- Measured 2026-10-24 23:00Z (read-only): 30 tables in that state, every one
-- a game's MAIN table, every game switched off (enabled = false), no open
-- seat at any of them, closed between 2026-10-15 17:01Z and 2026-10-24
-- 16:03Z; 21 still hold their main_index. By club: Lightning Internal Pilot
-- 9, Club Savage 9, Crest Cert Template 095896f4 3, and Crest Cert Template
-- c4059717 9 - that last club is RETIRED, and fn_guard_retired_club_mutation
-- makes a retired club's gameplay records read-only by design, so its rows
-- are left exactly as they are (nothing can run in a retired club).
--
-- THE FIX. The door now writes lifecycle = 'closed' in the same UPDATE, as
-- every other closer does. Nothing else in the function changes. The body is
-- production's current body byte for byte (prosrc md5
-- 57ed378cd27c0031cb0cb81e47029089: the 20260909192240 text with the
-- 20260910035435 lane rewrite applied) plus that one assignment, so this file
-- is again the literal source of what production runs.
--
-- THE DAMAGE. The 21 tables of live clubs are settled to lifecycle = 'closed'
-- in the same transaction: only tables already status 'closed', of a
-- switched-off game, in a club that is not retired, with no open seat. No seat, chip, wallet or game row is touched. The BEFORE
-- triggers on tables see a close-to-close update (f06 does not count it as a
-- reopening) and release each main_index as designed.
--
-- PINNED BY tests/closing-a-table-closes-its-lifecycle.law.test.ts.
--
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id JOIN public.clubs c ON c.id = t.club_id WHERE lower(coalesce(t.status, '')) = 'closed' AND t.lifecycle IS DISTINCT FROM 'closed' AND NOT g.enabled AND c.lifecycle_status IS DISTINCT FROM 'retired') AND position('lifecycle = ''closed''' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_close_managed_game(text,uuid)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

CREATE OR REPLACE FUNCTION public.fn_close_managed_game(
  p_kind text,
  p_game_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $managed_close$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
  v_cluster uuid;
  v_role text;
  v_initial_cluster uuid;
  v_cancel jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    -- Match the cluster controller's game-to-table order. Authorize the
    -- initial scope before locking, then recheck the locked table below.
    SELECT club_id, cluster_id
      INTO v_club, v_initial_cluster
      FROM public.tables
     WHERE id = p_game_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF v_initial_cluster IS NOT NULL THEN
      PERFORM 1
        FROM public.cash_games
       WHERE id = v_initial_cluster
       FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
      END IF;
    END IF;

    SELECT club_id, status, cluster_id, role
      INTO v_club, v_status, v_cluster, v_role
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF v_cluster IS DISTINCT FROM v_initial_cluster THEN
      RAISE EXCEPTION 'STALE_GAME_CONTEXT: table changed games while closing'
        USING ERRCODE = '55000';
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF lower(COALESCE(v_status, '')) IN (
      'closed', 'completed', 'cancelled', 'finished'
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    -- The native admission FK serializes new seats against this parent lock.
    -- A refusal needs a snapshot, not a seat lock ahead of an engine cashout.
    PERFORM 1
      FROM public.table_seats ts
     WHERE ts.table_id = p_game_id
       AND ts.left_at IS NULL
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_seated');
    END IF;

    UPDATE public.tables
       SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;

    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled = false,
             state = 'dormant',
             closed_at = now(),
             closed_by = v_uid,
             updated_at = now()
       WHERE id = v_cluster
         AND enabled;
    END IF;
    RETURN jsonb_build_object('ok', true);
  ELSIF p_kind = 'tournament' THEN
    -- Every terminal owner takes this lock before the first tournament row.
    PERFORM public.fn_ca_lock_settlement_lane_global();

    SELECT club_id, status
      INTO v_club, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF upper(COALESCE(v_status, '')) IN (
      'COMPLETED', 'CANCELLED', 'CANCELED', 'COMPLETING'
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;

    PERFORM set_config('app.managed_game_lifecycle', 'on', true);
    v_cancel := public.atomic_cancel_tournament(p_game_id, v_uid);
    PERFORM set_config('app.managed_game_lifecycle', '', true);
    IF v_cancel->>'ok' IS DISTINCT FROM 'true'
       OR v_cancel->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_cancel->>'status' IS DISTINCT FROM 'CANCELLED'
       OR v_cancel->>'tournament_id' IS DISTINCT FROM p_game_id::text
       OR (v_cancel->>'source_player_count')::integer IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION
        'managed tournament close did not return its exact atomic cancellation receipt'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$managed_close$;

REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid)
  TO service_role;

DO $settle$
DECLARE
  v_fixed integer;
BEGIN
  UPDATE public.tables t
     SET lifecycle = 'closed', updated_at = now()
    FROM public.cash_games g, public.clubs c
   WHERE g.id = t.cluster_id
     AND c.id = t.club_id
     AND c.lifecycle_status IS DISTINCT FROM 'retired'
     AND NOT g.enabled
     AND lower(coalesce(t.status, '')) = 'closed'
     AND t.lifecycle IS DISTINCT FROM 'closed'
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = t.id AND s.left_at IS NULL
     );
  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  -- Measured 21. A game closed through the door before this commits adds
  -- one; many more means something else is writing this shape.
  IF v_fixed > 30 THEN
    RAISE EXCEPTION 'expected about 21 half-closed tables, found %', v_fixed;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tables t
      JOIN public.cash_games g ON g.id = t.cluster_id
      JOIN public.clubs c ON c.id = t.club_id
     WHERE lower(coalesce(t.status, '')) = 'closed'
       AND t.lifecycle IS DISTINCT FROM 'closed'
       AND NOT g.enabled
       AND c.lifecycle_status IS DISTINCT FROM 'retired'
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: a closed table of a switched-off game still reads lifecycle live';
  END IF;

  IF position('lifecycle = ''closed''' IN (
       SELECT prosrc FROM pg_proc
        WHERE oid = 'public.fn_close_managed_game(text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POST-APPLY: the close door still leaves lifecycle unwritten';
  END IF;

  RAISE NOTICE 'closing a table closes its lifecycle: % half-closed tables settled', v_fixed;
END
$settle$;

COMMIT;
