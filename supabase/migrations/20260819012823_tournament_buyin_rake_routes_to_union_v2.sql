-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819012823 "tournament_buyin_rake_routes_to_union_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 97352b08a713f6e1227ace92b8905f45 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TOURNAMENT BUY-IN RAKE FOLLOWS THE SAME ROUTE AS CASH RAKE (2026-08-18)
-- Dan: tournament rake is held in the union wallet (or the club wallet if the
-- club is standalone), and the player who paid it gets it credited to their
-- "rake generated" for the week.
--
-- WAS: this credited club_wallets unconditionally, so a tournament run by a
-- club inside a union banked its rake in the CLUB wallet while every cash hand
-- at that same club banked in the UNION wallet — two destinations for the same
-- club's rake depending only on whether the chips came from a buy-in or a pot.
--
-- NOW: identical routing to atomic_distribute_rake. Union club -> union_wallets
-- (chip_balance + rake_wallet + total_rake_collected) with a
-- union_wallet_transactions audit row, club accumulators still updated for
-- reporting; standalone club -> club_wallets as before.
--
-- PLAYER WEEKLY RAKE unchanged and already correct: the rake_records row
-- carries player_contributions = {player_id: fee}, and RakebackSettlerService
-- processes ALL rake_records, explicitly handling tournament/SNG fee rows by
-- keying idempotency on rake_records.id (they have no hand_id). Verified live:
-- rakeback_stats_applied holds 2,335,595 rows, still being written each minute.
--
-- Defaults preserved from the original signature.

DROP FUNCTION IF EXISTS public.record_tournament_buyin_rake(uuid, numeric, uuid);

CREATE FUNCTION public.record_tournament_buyin_rake(
  p_tournament_id uuid DEFAULT NULL::uuid,
  p_amount numeric DEFAULT 0,
  p_player_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_club_id uuid;
  v_union_id uuid;
  v_rake_id uuid;
  v_union_rake numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_tournament_id IS NULL THEN RETURN; END IF;

  SELECT club_id INTO v_club_id FROM public.tournaments WHERE id = p_tournament_id;
  IF v_club_id IS NULL THEN RETURN; END IF;

  SELECT union_id INTO v_union_id FROM public.clubs WHERE id = v_club_id;

  -- The ledger row. player_contributions names the payer, and that is what
  -- credits their weekly rake_generated downstream.
  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source
  ) VALUES (
    NULL, NULL, v_club_id, p_amount, 0, 0, 1,
    jsonb_build_object(p_player_id::text, p_amount), TRUE, p_tournament_id, 'tournament_buyin'
  ) RETURNING id INTO v_rake_id;

  IF v_union_id IS NOT NULL THEN
    INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
         VALUES (v_union_id, p_amount, p_amount, p_amount)
    ON CONFLICT (union_id) DO UPDATE SET
         chip_balance         = public.union_wallets.chip_balance + p_amount,
         rake_wallet          = public.union_wallets.rake_wallet + p_amount,
         total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_amount,
         updated_at           = NOW()
    RETURNING rake_wallet INTO v_union_rake;

    INSERT INTO public.union_wallet_transactions (
      union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
    ) VALUES (
      v_union_id, v_club_id, p_amount, 'rake', 'rake_wallet', 'credit', v_union_rake,
      'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
    );

    UPDATE public.club_wallets
       SET period_rake_collected   = COALESCE(period_rake_collected, 0) + p_amount,
           lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + p_amount,
           updated_at = NOW()
     WHERE club_id = v_club_id;
  ELSE
    UPDATE public.club_wallets
       SET period_rake_collected   = COALESCE(period_rake_collected, 0) + p_amount,
           lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + p_amount,
           chip_balance            = chip_balance + p_amount,
           updated_at = NOW()
     WHERE club_id = v_club_id;

    INSERT INTO public.club_wallet_transactions
      (club_id, type, amount, balance_after, related_id, reason)
    SELECT v_club_id, 'rake_in', p_amount, chip_balance, v_rake_id,
           'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
      FROM public.club_wallets WHERE club_id = v_club_id;
  END IF;

  UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW()
   WHERE id = v_club_id;
  UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW()
   WHERE id = p_tournament_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_tournament_buyin_rake(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_tournament_buyin_rake(uuid, numeric, uuid) TO service_role;
