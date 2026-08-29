-- ═══════════════════════════════════════════════════════════════════════════
-- THE ANTE MULTIPLIER IS WHOLE BIG BLINDS, AND THE RPC SAYS SO (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tables.bomb_pot_ante_multiplier` is an INTEGER column. `fn_update_table_bomb_settings`
-- accepted a numeric and let Postgres round it on assignment, so a caller asking
-- for 2.5 got 3 stored, an `{"ok": true}` back, and no indication anything had
-- changed. Every player at that table would then be charged the larger ante.
--
-- Found by probing the function's happy path inside a rolled-back transaction
-- (CLAUDE.md 11.5) and noticing the echoed row said 3 when the probe asked for
-- 2.5. Both config forms were fixed in the same change to step by 1 rather than
-- 0.5; the fractional case keeps its proper home in `bomb_pot_ante_fixed`, which
-- is `numeric` and prices the ante in chips rather than in multiples.
--
-- Rounding is explicit here and reported in the return value, so a caller can
-- see what was actually stored instead of discovering it from the felt.
--
-- ── PROVENANCE ──────────────────────────────────────────────────────────────
-- This file was written AFTER the migration was applied, and that gap is the
-- reason it exists at all: the playbook's Part C3 asks whether every applied
-- migration is in the repo, and this one was not. A function that lives only in
-- the database is exactly the drift 20260827f caused — a migration claiming a
-- behaviour the live function did not have, and three weeks on the wrong
-- wallet before anybody noticed. The body below is byte-identical in effect to
-- what ran as `bomb_ante_multiplier_is_whole_blinds_and_says_so`
-- (version 20260829161712); re-running it is a no-op.
--
-- Tier 2: CREATE OR REPLACE of one SECURITY DEFINER function. No schema change.

CREATE OR REPLACE FUNCTION public.fn_update_table_bomb_settings(
  p_table_id uuid,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_club  uuid;
  v_role  text;
  v_owner boolean := false;
  v_before jsonb;
  v_after  jsonb;
  v_enabled   boolean;
  v_mode      text;
  v_freq      int;
  v_interval  int;
  v_boards    int;
  v_minp      int;
  v_anteBBraw numeric;
  v_anteBB    int;
  v_anteFix   numeric;
  v_variant   text;
  v_button    text;
  v_announce  int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT club_id INTO v_club FROM public.tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.owner_id = v_uid)
    INTO v_owner;
  SELECT lower(cm.role) INTO v_role
  FROM public.club_members cm
  WHERE cm.club_id = v_club AND cm.user_id = v_uid
  LIMIT 1;

  IF NOT (v_owner OR v_role IN ('owner', 'co_owner', 'admin')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_enabled := COALESCE((p_settings ->> 'bomb_pot_enabled')::boolean, false);

  v_mode := lower(COALESCE(p_settings ->> 'bomb_pot_trigger_mode', 'every_n_hands'));
  IF v_mode NOT IN ('every_n_hands', 'once_per_orbit', 'timed', 'bomb_pot_only') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_trigger_mode');
  END IF;

  v_freq := GREATEST(COALESCE((p_settings ->> 'bomb_pot_frequency')::int, 0), 0);
  IF v_enabled AND v_mode = 'every_n_hands' AND v_freq < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frequency_must_be_at_least_1');
  END IF;

  v_interval := COALESCE((p_settings ->> 'bomb_pot_interval_seconds')::int, 0);
  IF v_enabled AND v_mode = 'timed' AND v_interval < 60 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'interval_must_be_at_least_60s');
  END IF;

  v_boards := LEAST(GREATEST(COALESCE((p_settings ->> 'bomb_pot_board_count')::int, 1), 1), 3);
  v_minp   := LEAST(GREATEST(COALESCE((p_settings ->> 'bomb_pot_min_players')::int, 3), 2), 10);

  -- WHOLE BIG BLINDS. The column is an integer; rounding here rather than on
  -- assignment means the caller is TOLD what was stored (ante_multiplier_rounded
  -- in the return) instead of discovering it later at the table.
  v_anteBBraw := GREATEST(COALESCE((p_settings ->> 'bomb_pot_ante_multiplier')::numeric, 0), 0);
  v_anteBB    := LEAST(round(v_anteBBraw)::int, 100);

  v_anteFix := NULLIF(GREATEST(COALESCE((p_settings ->> 'bomb_pot_ante_fixed')::numeric, 0), 0), 0);

  v_variant := NULLIF(lower(COALESCE(p_settings ->> 'bomb_pot_variant', '')), '');
  IF v_variant IS NOT NULL AND v_variant NOT IN ('nlh', 'plo4', 'plo5', 'plo6') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_variant');
  END IF;

  v_button := lower(COALESCE(p_settings ->> 'bomb_pot_button_policy', 'regular'));
  IF v_button NOT IN ('regular', 'separate') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_button_policy');
  END IF;

  v_announce := GREATEST(COALESCE((p_settings ->> 'bomb_pot_announce_seconds')::int, 0), 0);

  SELECT to_jsonb(t) INTO v_before
  FROM (
    SELECT bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_frequency,
           bomb_pot_interval_seconds, bomb_pot_board_count, bomb_pot_min_players,
           bomb_pot_ante_multiplier, bomb_pot_ante_fixed, bomb_pot_variant,
           bomb_pot_button_policy, bomb_pot_announce_seconds, bomb_pot_double_board
    FROM public.tables WHERE id = p_table_id
  ) t;

  UPDATE public.tables SET
    bomb_pot_enabled           = v_enabled,
    bomb_pot_trigger_mode      = CASE WHEN v_enabled THEN v_mode ELSE 'every_n_hands' END,
    bomb_pot_frequency         = CASE WHEN v_enabled THEN v_freq ELSE 0 END,
    bomb_pot_interval_seconds  = CASE WHEN v_enabled AND v_mode = 'timed' THEN v_interval ELSE NULL END,
    bomb_pot_board_count       = CASE WHEN v_enabled THEN v_boards ELSE 1 END,
    bomb_pot_min_players       = CASE WHEN v_enabled THEN v_minp ELSE 3 END,
    bomb_pot_ante_multiplier   = CASE WHEN v_enabled THEN v_anteBB ELSE 0 END,
    bomb_pot_ante_fixed        = CASE WHEN v_enabled THEN v_anteFix ELSE NULL END,
    bomb_pot_variant           = CASE WHEN v_enabled THEN v_variant ELSE NULL END,
    bomb_pot_button_policy     = CASE WHEN v_enabled THEN v_button ELSE 'regular' END,
    bomb_pot_announce_seconds  = CASE WHEN v_enabled AND v_mode = 'timed' AND v_announce > 0
                                      THEN v_announce ELSE NULL END,
    bomb_pot_double_board      = v_enabled AND v_boards >= 2,
    -- LIVE STATE IS NOT CONFIG: a host changing the mode is starting a new
    -- schedule, not resuming one, and a token from the old schedule must not
    -- detonate under the new rules.
    bomb_pot_sched_state       = NULL,
    bomb_pot_next_due_at       = NULL,
    bomb_pot_manual_pending    = false
  WHERE id = p_table_id;

  SELECT to_jsonb(t) INTO v_after
  FROM (
    SELECT bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_frequency,
           bomb_pot_interval_seconds, bomb_pot_board_count, bomb_pot_min_players,
           bomb_pot_ante_multiplier, bomb_pot_ante_fixed, bomb_pot_variant,
           bomb_pot_button_policy, bomb_pot_announce_seconds, bomb_pot_double_board
    FROM public.tables WHERE id = p_table_id
  ) t;

  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO public.table_settings_changes (table_id, club_id, changed_by, before, after)
    VALUES (p_table_id, v_club, v_uid, v_before, v_after);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', v_before IS DISTINCT FROM v_after,
    -- Say so when the ante was not stored as asked, rather than letting the
    -- caller find out from the felt.
    'ante_multiplier_rounded', v_anteBBraw IS DISTINCT FROM v_anteBB::numeric,
    'settings', v_after);
END;
$fn$;

DO $chk$
BEGIN
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_update_table_bomb_settings')
     NOT LIKE '%ante_multiplier_rounded%' THEN
    RAISE EXCEPTION 'assertion failed: the ante rounding is still silent';
  END IF;
END $chk$;

-- ROLLBACK: CREATE OR REPLACE the 20260829142855 version
-- (a_host_can_change_a_running_table), which assigns the numeric straight to
-- the integer column and returns no ante_multiplier_rounded flag. That restores
-- the silent rounding, so do not roll back to "fix" a caller — send a whole
-- number instead.
