-- ===========================================================================
-- fn_register_for_tournament / fn_register_horse_for_tournament
-- FEATURE PARITY (2026-08-22)
--
-- Base bodies are the LIVE production definitions (pg_get_functiondef pulled
-- 2026-08-22; the 20260815 repo file is a doc mirror, the 20260819 horse file
-- is verbatim). Everything they did is preserved: FOR UPDATE row lock, late
-- reg by levels/minutes, full/duplicate checks, fn_tournament_entry_split,
-- atomic_deduct_wallet_and_log + log_wallet_transaction, rake_records fee row
-- (table_id NULL - FK to tables), pool/rake/current_players bumps, and the
-- unique-violation exact-refund race path.
--
-- ADDED:
--  1. authorized_to_register gate: refuse 'not_authorized_to_register' unless
--     a tournament_registration_approvals row exists for (tournament, caller)
--     or the caller is the club owner/admin (is_club_admin).
--  2. is_vip_only gate: refuse 'vip_only' unless the member qualifies.
--     VIP FIELD INSPECTION (2026-08-22): club_members has NO vip column
--     (checked information_schema; nearest are tier/rank_level which are club
--     loyalty, not VIP). profiles DOES carry a real VIP flag: is_vip,
--     vip_tier, vip_expires_at. The gate is therefore:
--       profiles.is_vip AND (vip_expires_at IS NULL OR vip_expires_at > now())
--     with a bypass for club_members.role IN ('owner','admin','agent').
--  3. Early bird: when early_bird_enabled and registration happens BEFORE
--     start_time, the tournament_players row is inserted with
--     chips = early_bird_chips instead of 0. The engine adds starting_chips
--     when it seats players, so this column carries the pre-start BONUS; the
--     engine must add, not overwrite (server-side seating reads this row).
--     Applied to the horse function too - horses registered early get the
--     same bonus so human fields are not chip-advantaged over advertised.
--  4. Mystery bounty draw: the fixed ladder (60% x0.5, 25% x1, 10% x2,
--     4% x3, 1% x13) now scales to the tournament's advertised range.
--     mystery_bounty_min/max store MONEY (head * multiplier - the 2026-08-21
--     advertised-range convention). Dividing by the head recovers the
--     multiplier bounds; the ladder is linearly rescaled so the smallest tier
--     lands on min and the largest on max. Rows written by the 2026-08-21
--     migration recover exactly (0.5, 13), so their draw is unchanged; legacy
--     (bounty, bounty*10) rows draw inside the range they actually advertised.
--     THE DRAW LIVES ONLY in these two register functions (grepped all
--     migrations; fn_spin_draw_multiplier is the SPIN tier draw - untouched).
--
-- Horses deliberately skip gates 1 and 2: the engine seats horses to build
-- fields, and an approvals/VIP wall would break fleet filling.
--
-- TIER 3 (replaces SECURITY DEFINER functions; signatures unchanged).
-- ROLLBACK: previous bodies are in the remote migration history and (horse)
-- in supabase/migrations/20260819_fn_register_horse_for_tournament.sql.
-- ===========================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_register_for_tournament'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid') THEN
    RAISE EXCEPTION 'fn_register_for_tournament(uuid) not found - schema drift, aborting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_register_horse_for_tournament'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_user_id uuid') THEN
    RAISE EXCEPTION 'fn_register_horse_for_tournament(uuid, uuid) not found - schema drift, aborting';
  END IF;
  IF to_regclass('public.tournament_registration_approvals') IS NULL THEN
    RAISE EXCEPTION 'tournament_registration_approvals missing - apply 20260822100000 first';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Human registration
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0; v_mystery numeric := 0;
  v_roll numeric; v_mult numeric; v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_mb_min_mult numeric; v_mb_max_mult numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status = 'RUNNING' THEN
    IF COALESCE(v_t.late_reg_levels, 0) > 0 THEN
      v_late_open := COALESCE(v_t.current_level, 1) <= v_t.late_reg_levels;
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 AND v_t.started_at IS NOT NULL THEN
      v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins);
    END IF;
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.max_players IS NOT NULL AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events. club_members carries no VIP
  -- column (inspected 2026-08-22); profiles.is_vip / vip_expires_at is the
  -- platform VIP flag. Club owner/admin/agent may always enter their own event.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  -- The chips column is the pre-start bonus ledger; the engine ADDS
  -- starting_chips at seating.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
  END IF;

  -- Head value for this player.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
    IF COALESCE(v_t.is_mystery_bounty, false) AND v_head > 0 THEN
      v_roll := random() * 100;
      IF    v_roll < 60 THEN v_mult := 0.5;
      ELSIF v_roll < 85 THEN v_mult := 1;
      ELSIF v_roll < 95 THEN v_mult := 2;
      ELSIF v_roll < 99 THEN v_mult := 3;
      ELSE                   v_mult := 13;
      END IF;
      -- PARITY 4 (2026-08-22): rescale the ladder to the advertised range.
      -- Columns hold MONEY; divide by the head to recover multiplier bounds,
      -- then map [0.5 .. 13] linearly onto [min_mult .. max_mult].
      IF COALESCE(v_t.mystery_bounty_min, 0) > 0
         AND COALESCE(v_t.mystery_bounty_max, 0) > v_t.mystery_bounty_min THEN
        v_mb_min_mult := v_t.mystery_bounty_min / v_head;
        v_mb_max_mult := v_t.mystery_bounty_max / v_head;
        v_mult := v_mb_min_mult + (v_mult - 0.5) * (v_mb_max_mult - v_mb_min_mult) / 12.5;
      END IF;
      v_mystery := round(v_head * v_mult, 2);
      v_head := v_mystery;
    END IF;
  END IF;

  IF v_split.charge > 0 THEN
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, v_mystery, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(v_uid, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || v_uid::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'mystery_bounty', CASE WHEN v_mystery > 0 THEN v_mystery END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END);
END; $function$;

-- ---------------------------------------------------------------------------
-- 2. Horse registration (engine-only; same early-bird and mystery changes,
--    no approvals/VIP gates - the engine builds fields with horses).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0; v_mystery numeric := 0;
  v_roll numeric; v_mult numeric; v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_start_chips integer := 0;
  v_mb_min_mult numeric; v_mb_max_mult numeric;
BEGIN
  -- HARD GATE: horses only. A human's chips are never spent without them asking.
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, mystery_bounty_min, mystery_bounty_max,
         start_time, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.max_players IS NOT NULL AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY 3 (2026-08-22): early bird applies to horses too, so a horse-filled
  -- field carries exactly the chip counts the event advertised.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  IF v_is_bounty THEN
    v_head := v_split.bounty;
    IF COALESCE(v_t.is_mystery_bounty, false) AND v_head > 0 THEN
      v_roll := random() * 100;
      IF    v_roll < 60 THEN v_mult := 0.5;
      ELSIF v_roll < 85 THEN v_mult := 1;
      ELSIF v_roll < 95 THEN v_mult := 2;
      ELSIF v_roll < 99 THEN v_mult := 3;
      ELSE                   v_mult := 13;
      END IF;
      -- PARITY 4 (2026-08-22): same advertised-range rescale as the human path.
      IF COALESCE(v_t.mystery_bounty_min, 0) > 0
         AND COALESCE(v_t.mystery_bounty_max, 0) > v_t.mystery_bounty_min THEN
        v_mb_min_mult := v_t.mystery_bounty_min / v_head;
        v_mb_max_mult := v_t.mystery_bounty_max / v_head;
        v_mult := v_mb_min_mult + (v_mult - 0.5) * (v_mb_max_mult - v_mb_min_mult) / 12.5;
      END IF;
      v_mystery := round(v_head * v_mult, 2);
      v_head := v_mystery;
    END IF;
  END IF;

  IF v_split.charge > 0 THEN
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, v_mystery, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(p_user_id, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || p_user_id::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake);
END; $function$;

-- Grants unchanged by CREATE OR REPLACE, but restated for the horse function
-- because they are the security boundary: engine only.
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) TO service_role;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
DECLARE v_src text; v_src_h text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_register_for_tournament';
  SELECT pg_get_functiondef(p.oid) INTO v_src_h
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_register_horse_for_tournament';

  IF position('not_authorized_to_register' in v_src) = 0 THEN
    RAISE EXCEPTION 'human register fn is missing the approvals gate';
  END IF;
  IF position('vip_only' in v_src) = 0 THEN
    RAISE EXCEPTION 'human register fn is missing the VIP gate';
  END IF;
  IF position('early_bird_chips' in v_src) = 0 OR position('early_bird_chips' in v_src_h) = 0 THEN
    RAISE EXCEPTION 'early bird bonus missing from a register fn';
  END IF;
  IF position('12.5' in v_src) = 0 OR position('12.5' in v_src_h) = 0 THEN
    RAISE EXCEPTION 'mystery ladder rescale missing from a register fn';
  END IF;
  IF position('credit_player_wallet' in v_src) = 0 THEN
    RAISE EXCEPTION 'race-refund path lost from fn_register_for_tournament';
  END IF;
END $$;

COMMIT;
