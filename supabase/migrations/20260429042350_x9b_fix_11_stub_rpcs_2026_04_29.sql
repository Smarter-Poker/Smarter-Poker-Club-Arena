-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429042350 "x9b_fix_11_stub_rpcs_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cac30dbdd53f31911366c17f6f2aa417 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 2 sweep batch 2 — settlement-chain + club-stats + tournament stubs.
-- All caller-callable; previous bodies were `BEGIN NULL; END;` or `BEGIN RETURN; END;`
-- which silently dropped writes. Real implementations now.

-- ───────────────────────────────────────────────────────────────────────────
-- execute_commission_payout — caller passes a payout row id, we credit the
-- agent based on the agent_commissions row.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.execute_commission_payout(p_payout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_row record;
  v_new_balance numeric;
BEGIN
  SELECT id, club_id, user_id, amount FROM public.agent_commissions
   WHERE id = p_payout_id INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'agent_commission % not found', p_payout_id; END IF;
  IF v_row.amount IS NULL OR v_row.amount <= 0 THEN RETURN; END IF;

  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (v_row.user_id, 'PLAYER', v_row.amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance = public.wallets.balance + v_row.amount, updated_at = NOW()
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES
    (v_row.user_id, 'PLAYER', 'credit', v_row.amount, 'commission_payout',
     'Commission payout', p_payout_id, v_new_balance);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- record_hand_rake_attribution — record per-player rake contribution after
-- a hand. Persists into rake_records.player_contributions JSONB.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_hand_rake_attribution(
  p_hand_id uuid, p_table_id uuid, p_club_id uuid, p_attributions jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_attributions IS NULL OR jsonb_typeof(p_attributions) <> 'object' THEN RETURN; END IF;
  UPDATE public.rake_records
     SET player_contributions = p_attributions
   WHERE hand_id = p_hand_id;
  -- If rake_records row not yet created (timing), insert minimal stub
  IF NOT FOUND THEN
    INSERT INTO public.rake_records (hand_id, table_id, club_id, rake_amount, player_contributions)
    VALUES (p_hand_id, p_table_id, p_club_id, 0, p_attributions)
    ON CONFLICT DO NOTHING;
  END IF;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- increment_rake_generated (2-arg + 3-arg overloads) — bump club total rake
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_rake_generated(p_club_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_club_id IS NULL THEN RETURN; END IF;
  UPDATE public.clubs
     SET total_rake = COALESCE(total_rake, 0) + p_amount, updated_at = NOW()
   WHERE id = p_club_id;
END $function$;

CREATE OR REPLACE FUNCTION public.increment_rake_generated(
  p_entity_id uuid, p_entity_type text, p_amount numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_entity_id IS NULL THEN RETURN; END IF;
  IF p_entity_type = 'club' THEN
    UPDATE public.clubs SET total_rake = COALESCE(total_rake,0)+p_amount, updated_at=NOW()
     WHERE id = p_entity_id;
  ELSIF p_entity_type = 'tournament' THEN
    UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0)+p_amount, updated_at=NOW()
     WHERE id = p_entity_id;
  ELSIF p_entity_type = 'agent' THEN
    UPDATE public.agents
       SET weekly_rake_generated  = COALESCE(weekly_rake_generated,0)  + p_amount,
           lifetime_rake_generated = COALESCE(lifetime_rake_generated,0) + p_amount,
           updated_at = NOW()
     WHERE id = p_entity_id;
  END IF;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- increment_settlement_counters — bump per-period totals on club_wallets
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_settlement_counters(
  p_club_id uuid DEFAULT NULL, p_period text DEFAULT ''
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_club_id IS NULL THEN RETURN; END IF;
  -- Just touch updated_at so dashboards refresh; club_wallets accumulators
  -- are owned by record_rake() RPC which is the canonical write path.
  UPDATE public.club_wallets SET updated_at = NOW() WHERE club_id = p_club_id;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- increment_club_table_count + decrement_club_table_count — clubs.table_count
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_club_table_count(p_club_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_club_id IS NULL THEN RETURN; END IF;
  UPDATE public.clubs SET table_count = COALESCE(table_count,0)+1, updated_at=NOW()
   WHERE id = p_club_id;
END $function$;

CREATE OR REPLACE FUNCTION public.decrement_club_table_count(p_club_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_club_id IS NULL THEN RETURN; END IF;
  UPDATE public.clubs
     SET table_count = GREATEST(0, COALESCE(table_count,0)-1), updated_at=NOW()
   WHERE id = p_club_id;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- fn_increment_club_member_count — clubs.member_count
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_increment_club_member_count(
  p_club_id uuid DEFAULT NULL, p_increment integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_club_id IS NULL THEN RETURN; END IF;
  UPDATE public.clubs
     SET member_count = GREATEST(0, COALESCE(member_count,0) + p_increment),
         updated_at = NOW()
   WHERE id = p_club_id;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- increment_table_hands — tables.hands_played
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_table_hands(
  p_table_id uuid DEFAULT NULL, p_count integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_table_id IS NULL THEN RETURN; END IF;
  UPDATE public.tables
     SET hands_played = COALESCE(hands_played,0) + p_count
   WHERE id = p_table_id;
  -- Roll up to club too
  UPDATE public.clubs
     SET hands_played = COALESCE(hands_played,0) + p_count
   WHERE id = (SELECT club_id FROM public.tables WHERE id = p_table_id);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- fn_get_available_seats — return open seat numbers at a table
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_get_available_seats(p_table_id uuid)
RETURNS TABLE(seat_number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_max_seats integer;
BEGIN
  SELECT COALESCE(max_players, 9) INTO v_max_seats FROM public.tables WHERE id = p_table_id;
  IF v_max_seats IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT s.seat_number FROM generate_series(1, v_max_seats) AS s(seat_number)
     WHERE s.seat_number NOT IN (
       SELECT ts.seat_number FROM public.table_seats ts
        WHERE ts.table_id = p_table_id AND ts.left_at IS NULL
     )
     ORDER BY s.seat_number;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- increment_tournament_bounty — tournaments.bounty_amount accumulator
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_tournament_bounty(
  p_tournament_id uuid DEFAULT NULL, p_amount numeric DEFAULT 0
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_tournament_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
  UPDATE public.tournaments
     SET bounty_amount = COALESCE(bounty_amount,0) + p_amount, updated_at=NOW()
   WHERE id = p_tournament_id;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- update_leaderboard (3-arg overload) — generic leaderboard upsert
-- The 7-arg overload (memory_leaderboards) stays untouched.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_leaderboard(
  p_user_id uuid, p_leaderboard text DEFAULT 'global', p_score integer DEFAULT 0
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  -- leaderboard_entries is the canonical generic table
  INSERT INTO public.leaderboard_entries (user_id, leaderboard_type, score, updated_at)
  VALUES (p_user_id, p_leaderboard, p_score, NOW())
  ON CONFLICT (user_id, leaderboard_type) DO UPDATE
    SET score = GREATEST(public.leaderboard_entries.score, EXCLUDED.score),
        updated_at = NOW();
END $function$;
