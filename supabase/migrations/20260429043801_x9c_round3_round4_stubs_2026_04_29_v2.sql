-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429043801 "x9c_round3_round4_stubs_2026_04_29_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8fd4ab2ab32b3eb0d1f938e76cb0e030 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS public.balance_tournament_tables(uuid);

CREATE OR REPLACE FUNCTION public.balance_tournament_tables(p_tournament_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_min_players integer;
  v_max_players integer;
  v_imbalanced integer := 0;
BEGIN
  IF p_tournament_id IS NULL THEN RETURN 0; END IF;
  SELECT MIN(c), MAX(c) INTO v_min_players, v_max_players FROM (
    SELECT COUNT(*) AS c FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE t.tournament_id = p_tournament_id AND ts.left_at IS NULL
     GROUP BY ts.table_id
  ) sub;
  IF v_max_players IS NULL OR v_min_players IS NULL THEN RETURN 0; END IF;
  IF v_max_players - v_min_players > 1 THEN
    v_imbalanced := v_max_players - v_min_players;
    UPDATE public.tournaments SET updated_at = NOW() WHERE id = p_tournament_id;
  END IF;
  RETURN v_imbalanced;
END $function$;
GRANT EXECUTE ON FUNCTION public.balance_tournament_tables(uuid) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.record_tournament_buyin_rake(
  p_tournament_id uuid DEFAULT NULL, p_amount numeric DEFAULT 0, p_player_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_club_id uuid; v_rake_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_tournament_id IS NULL THEN RETURN; END IF;
  SELECT club_id INTO v_club_id FROM public.tournaments WHERE id = p_tournament_id;
  IF v_club_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source
  ) VALUES (
    NULL, NULL, v_club_id, p_amount, 0, 0, 1,
    jsonb_build_object(p_player_id::text, p_amount), TRUE, p_tournament_id, 'tournament_buyin'
  ) RETURNING id INTO v_rake_id;
  UPDATE public.club_wallets
     SET period_rake_collected = period_rake_collected + p_amount,
         lifetime_rake_collected = lifetime_rake_collected + p_amount,
         chip_balance = chip_balance + p_amount, updated_at = NOW()
   WHERE club_id = v_club_id;
  INSERT INTO public.club_wallet_transactions
    (club_id, type, amount, balance_after, related_id, reason)
  SELECT v_club_id, 'rake_in', p_amount, chip_balance, v_rake_id,
         'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
    FROM public.club_wallets WHERE club_id = v_club_id;
  UPDATE public.clubs SET total_rake = COALESCE(total_rake,0)+p_amount, updated_at=NOW() WHERE id = v_club_id;
  UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0)+p_amount, updated_at=NOW() WHERE id = p_tournament_id;
END $function$;
GRANT EXECUTE ON FUNCTION public.record_tournament_buyin_rake(uuid, numeric, uuid) TO service_role;

DROP FUNCTION IF EXISTS public.record_insurance_transaction(uuid, uuid, numeric, text);
