-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820124035 "union_law_guard_payout_paths"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b3b3e1b1608d748219d97e096e629d60 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Extend the money-path guard to the PAYOUT side. Pass 4 found that entries
-- debited club chips while every payout credited the global wallet, draining
-- club wallets on every completed or cancelled tournament. These three must
-- keep their club routing or the leak returns.
CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer routes through club_members — club wallets would be commingled'
    FROM (VALUES
            -- cash
            ('atomic_table_buyin'),
            ('atomic_table_cashout'),
            ('atomic_table_rebuy'),
            ('atomic_table_addon'),
            -- tournament money in
            ('atomic_tournament_register'),
            ('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            -- tournament money out (prizes, bounties, cancellations)
            ('credit_player_wallet'),
            ('atomic_cancel_tournament')
         ) AS x(fn)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x.fn
        AND p.prosrc LIKE '%club_members%');
$function$;

