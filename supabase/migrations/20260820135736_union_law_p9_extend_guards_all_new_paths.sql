-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820135736 "union_law_p9_extend_guards_all_new_paths"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c38ee619feb2c6ab42c450d58b4a587b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P9 — GUARD EVERYTHING ADDED IN THIS PASS (2026-08-20)
--
-- Extends the money-path guard to the payout and agent paths fixed in P1-P3,
-- and folds two new hard breaches into the daily law self-test:
--   * duplicate money-path signatures (the overload trap, which has now bitten
--     three separate times and each time silently disabled a shipped fix)
--   * club_members.chip_balance losing numeric precision (which would restart
--     the rounding leak on every fractional buy-in and cash-out)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer routes through club_members — club wallets would be commingled'
    FROM (VALUES
            -- cash
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            -- tournament money in
            ('atomic_tournament_register'),('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            -- money out
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback'),
            ('atomic_pay_agent_settlement'),
            -- agent chip custody
            ('transfer_chips_agent_to_player')
         ) AS x(fn)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x.fn
        AND p.prosrc LIKE '%club_members%');
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_law_extra_breaches()
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb := '[]'::jsonb; v_dupes text[]; v_type text;
BEGIN
  -- Duplicate signatures on money paths: callers may hit the stale one.
  SELECT array_agg(fn || ' x' || signatures) INTO v_dupes
    FROM public.fn_union_overload_check();
  IF v_dupes IS NOT NULL THEN
    v_out := v_out || jsonb_build_object('check','money_path_duplicate_signatures',
                                         'functions', to_jsonb(v_dupes));
  END IF;

  -- Club chip balance must stay numeric or fractional money rounds again.
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='club_members' AND column_name='chip_balance';
  IF v_type IS DISTINCT FROM 'numeric' THEN
    v_out := v_out || jsonb_build_object('check','club_chip_balance_not_numeric',
                                         'actual_type', COALESCE(v_type,'missing'));
  END IF;

  RETURN v_out;
END $function$;

