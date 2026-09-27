-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501004038 "x42_credit_club_wallet_rake_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 18cb52df01efce101b169cfff79c16ed of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 42 fix: a focused RPC the engine can call from logRakeCollection
-- to update club_wallets accumulators + write a club_wallet_transactions
-- audit row, WITHOUT re-inserting rake_records (the engine already does
-- that in postHandTasks) and WITHOUT touching bbj_pools (the engine's
-- logBBJCollection path owns that).
--
-- Before this, club_wallets.lifetime_rake_collected was 0 for every active
-- club despite millions of dollars of rake in rake_history (verified live:
-- Shark Club has $5,020 of 24h rake, club_wallets shows $0). The dashboard
-- + period close-out logic that reads from club_wallets was therefore
-- showing all zeros for every active club.
--
-- The standalone record_rake RPC (which already exists) does this PLUS
-- inserting rake_records, updating bbj_pools, and clubs.total_rake — too
-- much overlap with the engine's existing writes to call from
-- logRakeCollection without doubling.
--
-- Why it's safe to update for both standalone AND union clubs: club_wallets
-- accumulators measure RAKE COLLECTED at the table level, regardless of
-- where the chips ultimately settle (clubs.chip_pool for standalone,
-- union_wallets.rake_wallet for union). The accumulator is the audit
-- counter, not a balance.

CREATE OR REPLACE FUNCTION public.credit_club_wallet_rake(
  p_club_id    uuid,
  p_rake       numeric,
  p_bbj        numeric DEFAULT 0,
  p_hand_id    uuid    DEFAULT NULL,
  p_hand_number integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance_after numeric;
  v_net_credit    numeric;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN;
  END IF;

  -- net credit (what stays with the club after BBJ contribution)
  v_net_credit := p_rake - COALESCE(p_bbj, 0);

  UPDATE public.club_wallets
     SET period_rake_collected     = period_rake_collected     + p_rake,
         period_bbj_contribution   = period_bbj_contribution   + COALESCE(p_bbj, 0),
         lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
         lifetime_bbj_contribution = lifetime_bbj_contribution + COALESCE(p_bbj, 0),
         chip_balance              = chip_balance + v_net_credit,
         updated_at                = NOW()
   WHERE club_id = p_club_id
   RETURNING chip_balance INTO v_balance_after;

  -- If club_wallets row didn't exist (shouldn't happen — backfilled in
  -- migration 20260428000004 — but be defensive), insert one.
  IF v_balance_after IS NULL THEN
    INSERT INTO public.club_wallets (
      club_id, chip_balance,
      period_rake_collected, period_bbj_contribution,
      lifetime_rake_collected, lifetime_bbj_contribution
    ) VALUES (
      p_club_id, v_net_credit,
      p_rake, COALESCE(p_bbj, 0),
      p_rake, COALESCE(p_bbj, 0)
    )
    ON CONFLICT (club_id) DO UPDATE SET
      period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
      period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
      lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
      lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
      chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
      updated_at                = NOW()
    RETURNING chip_balance INTO v_balance_after;
  END IF;

  -- Append-only audit row in club_wallet_transactions.
  -- amount = net (post-BBJ) chip increment to the club balance.
  INSERT INTO public.club_wallet_transactions (
    club_id, type, amount, balance_after, related_id, reason
  ) VALUES (
    p_club_id, 'rake_in', v_net_credit, v_balance_after, p_hand_id,
    'Rake collected (hand ' ||
      COALESCE('#' || p_hand_number::text, 'unknown') ||
      ', BBJ contribution ' || COALESCE(p_bbj, 0)::text || ')'
  );
END;
$function$;
