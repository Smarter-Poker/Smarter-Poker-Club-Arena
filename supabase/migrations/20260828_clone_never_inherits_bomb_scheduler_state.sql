-- ═══════════════════════════════════════════════════════════════════════════
-- A CLONED TABLE MUST NOT INHERIT A BOMB IT NEVER EARNED (2026-08-28)
--
-- fn_clone_table_row copies the whole `tables` row through
-- to_jsonb -> jsonb_populate_record and resets an explicit list of
-- identity/live-state keys. Its own comment says "Identity and live state are
-- the ONLY things that do not carry over" — and the three columns the bomb
-- pot engine WRITES were not on that list:
--
--   bomb_pot_sched_state    the scheduler's trigger state, including the
--                           PENDING TOKEN (`p`) and the orbit anchor
--   bomb_pot_next_due_at    the timed mode's next due timestamp
--   bomb_pot_manual_pending an armed MANUAL_NEXT_HAND request
--
-- Both callers make this reachable in production:
--   * fn_launch_table_from_template — a template saved while a bomb was
--     pending would arm every table launched from it, forever;
--   * fn_table_lifecycle_pass — the AUTOMATIC restart/extension sweep, so a
--     restarted table inherits the dead table's clock and token with nobody
--     asking for it.
--
-- Effect of the bug: a brand-new table could deal a bomb pot on its first
-- hand (inherited token), or immediately (a due timestamp from hours ago),
-- or fire a manual bomb a host armed on a DIFFERENT table. Configuration is
-- meant to travel with a template; live scheduler state never is.
--
-- Fix: add the three to the reset list. Config columns (board count, trigger
-- mode, interval, ante, variant, button policy, announce window) are
-- deliberately left carrying over — those ARE the template.
--
-- Tier 2: function body change, no schema change, no data change.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_clone_table_row(p_source_id uuid, p_name text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb;
  v_new uuid := gen_random_uuid();
BEGIN
  SELECT to_jsonb(t) INTO v_row FROM public.tables t WHERE t.id = p_source_id LIMIT 1;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND: %', p_source_id;
  END IF;

  -- Identity and live state are the ONLY things that do not carry over.
  v_row := v_row || jsonb_build_object(
    'id',              v_new,
    'is_template',     false,
    'status',          'waiting',
    'current_players', 0,
    'hands_dealt',     0,
    'avg_pot',         0,
    'live_state',      NULL,
    'is_deleted',      false,
    'created_at',      now(),
    'updated_at',      now(),
    -- BOMB POT LIVE STATE (2026-08-28). Engine-written, per-table, and NOT
    -- part of the template: a clone that inherited these would deal a bomb
    -- pot it never earned. The bomb CONFIG columns above/below this line are
    -- untouched on purpose — those are exactly what a template is for.
    'bomb_pot_sched_state',    NULL,
    'bomb_pot_next_due_at',    NULL,
    'bomb_pot_manual_pending', false
  );
  IF p_name IS NOT NULL THEN
    v_row := v_row || jsonb_build_object('name', p_name);
  END IF;

  INSERT INTO public.tables
  SELECT * FROM jsonb_populate_record(NULL::public.tables, v_row);

  RETURN v_new;
END;
$function$;

-- ── AUTHORIZATION (check-definer-authorization.mjs, and it is right) ────────
--
-- fn_clone_table_row is SECURITY DEFINER, it WRITES, and it never asks who is
-- calling — its two callers do the asking (fn_launch_table_from_template
-- checks club staff; fn_table_lifecycle_pass is service_role). A browser role
-- holding EXECUTE here could clone any table by id into any club.
--
-- The live grants are already correct (postgres + service_role only), but a
-- migration that REPLACES the function and stays silent about grants reads as
-- "open" to the guard — and rightly so, because a replay of this file into a
-- fresh database would land the function with default PUBLIC EXECUTE. Say it
-- explicitly, naming PUBLIC as well as the browser roles: revoking one role
-- while PUBLIC still holds the grant reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_clone_table_row(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clone_table_row(uuid, text) TO service_role;

-- ── AND THE SAME MISTAKE IN MY OWN ROUND-4 FUNCTION ─────────────────────────
--
-- fn_request_manual_bomb_pot shipped with `REVOKE ALL ... FROM public` and a
-- GRANT to authenticated. Verified against the live ACL today, `anon` STILL
-- held EXECUTE: Supabase grants anon and authenticated explicitly through
-- default privileges, and revoking the PUBLIC pseudo-role does not touch an
-- explicit role grant. Exactly the trap the guard's own remedy text warns
-- about. It was not exploitable — the function's first act is to refuse a
-- null auth.uid() — but a staff-only writer must not sit in anon's reach.
REVOKE ALL ON FUNCTION public.fn_request_manual_bomb_pot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_request_manual_bomb_pot(uuid) TO authenticated;

-- Post-apply assertions: the reset list now names all three, the config
-- columns are still absent from it (i.e. they still carry over), and neither
-- function is reachable by a browser role that should not have it.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'fn_clone_table_row' AND n.nspname = 'public';

  IF v_def NOT LIKE '%bomb_pot_sched_state%'
     OR v_def NOT LIKE '%bomb_pot_next_due_at%'
     OR v_def NOT LIKE '%bomb_pot_manual_pending%' THEN
    RAISE EXCEPTION 'assertion failed: clone does not reset the bomb live-state columns';
  END IF;

  IF v_def LIKE '%''bomb_pot_board_count''%' OR v_def LIKE '%''bomb_pot_trigger_mode''%' THEN
    RAISE EXCEPTION 'assertion failed: clone is resetting bomb CONFIG, which must travel with a template';
  END IF;

  -- No browser role may execute the clone helper.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_clone_table_row'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'assertion failed: a browser role can still execute fn_clone_table_row';
  END IF;

  -- The manual bomb trigger is staff-only: authenticated yes, anon never.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_request_manual_bomb_pot'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'assertion failed: anon can still execute fn_request_manual_bomb_pot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_request_manual_bomb_pot'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'assertion failed: authenticated lost EXECUTE on fn_request_manual_bomb_pot';
  END IF;
END $$;
