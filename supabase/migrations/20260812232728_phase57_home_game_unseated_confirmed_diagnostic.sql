-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812232728 "phase57_home_game_unseated_confirmed_diagnostic"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ee39ff17a21a4defd1bca73ceb99f811 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 57 — fn_home_game_unseated_confirmed(): who is confirmed but has
--            no seat?
--
-- BACKGROUND (and a correction to the audit)
-- The audit reported two "competing seat models" and claimed confirmed
-- players "vanish at rpc_hg_start_table". Reading the whole flow, that
-- framing is wrong:
--
--   commander_home_rsvps               = "I am coming"      (per GAME)
--   commander_home_seat_reservations   = "I am in seat 4"   (per TABLE)
--
-- These are not duplicates. The intended flow is RSVP first, then a seat is
-- assigned — either the player claims one (rpc_hg_claim_seat) or the host
-- places them (rpc_hg_host_claim_for_member / the roster picker). A yes-RSVP
-- with no seat is therefore a NORMAL intermediate state, not corruption, and
-- rpc_hg_start_table is CORRECT to seat only players actually assigned to a
-- seat. Auto-seating every yes-RSVP would invent policy the product does not
-- define: a game can have several tables (7 exist today), so "which table,
-- which seat" has no mechanical answer.
--
-- THE REAL RISK is a UX gap, and it is live: production currently holds 8
-- yes-RSVPs and 0 seat reservations. A host can start a table believing
-- everyone who confirmed is seated, and silently begin without them.
--
-- This function makes that visible so the host dashboard can warn BEFORE
-- starting a table, instead of guessing on the host's behalf.
--
--   SELECT * FROM fn_home_game_unseated_confirmed('<game_id>');
--
-- Read-only. Staff-gated: it exposes who is attending a game, so it reuses
-- fn_home_is_group_staff rather than being readable by any member.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fn_home_game_unseated_confirmed(p_game_id uuid)
RETURNS TABLE (user_id uuid, display_name text, rsvp_response text, responded_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_caller   uuid := auth.uid();
    v_group_id uuid;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

    SELECT g.group_id INTO v_group_id
    FROM public.commander_home_games g
    WHERE g.id = p_game_id;

    IF v_group_id IS NULL THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    IF NOT public.fn_home_is_group_staff(v_caller, v_group_id) THEN
        RAISE EXCEPTION 'NOT_GROUP_STAFF';
    END IF;

    RETURN QUERY
    SELECT r.user_id,
           COALESCE(public.fn_hg_caller_display_name(r.user_id), 'Player') AS display_name,
           r.response,
           r.responded_at
    FROM public.commander_home_rsvps r
    WHERE r.game_id = p_game_id
      AND r.response = 'yes'
      AND r.user_id IS NOT NULL
      -- No active seat anywhere in this game.
      AND NOT EXISTS (
          SELECT 1
          FROM public.commander_home_seat_reservations sr
          JOIN public.commander_home_game_tables t ON t.id = sr.table_id
          WHERE t.game_id = p_game_id
            AND sr.user_id = r.user_id
            AND sr.status IN ('reserved', 'seated')
      )
    ORDER BY r.responded_at NULLS LAST;
END;
$function$;

COMMENT ON FUNCTION public.fn_home_game_unseated_confirmed(uuid) IS
  'Players who RSVP''d yes to a game but hold no seat at any of its tables. Staff-only. Intended as a pre-flight warning before rpc_hg_start_table, which deliberately seats ONLY players with a reservation — RSVP and seat assignment are separate steps by design. See migration phase57.';

REVOKE EXECUTE ON FUNCTION public.fn_home_game_unseated_confirmed(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_home_game_unseated_confirmed(uuid) TO authenticated, service_role;

-- ---------- POST-APPLY ----------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_home_game_unseated_confirmed'
          AND p.prosecdef
    ) THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: function missing or not SECURITY DEFINER';
    END IF;
    RAISE NOTICE 'phase57 OK: unseated-confirmed diagnostic available.';
END $$;
