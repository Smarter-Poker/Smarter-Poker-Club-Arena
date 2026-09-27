-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820135925 "union_law_p9c_money_path_guard_delegation_aware"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 be1e0a158dea521622b57c6f72136614 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- The guard tested for a literal club_members reference, which produced a
-- FALSE POSITIVE on atomic_pay_player_rakeback and atomic_pay_agent_settlement:
-- both are correctly club-scoped, but they route through the shared helper
-- fn_pay_player_chips instead of touching club_members directly. A guard that
-- cries wolf gets ignored, so it now accepts either direct club_members access
-- OR delegation to the helper (the helper itself is still checked directly).
CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer routes through club_members (directly or via '
         || 'fn_pay_player_chips) — club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('atomic_tournament_register'),('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback'),
            ('atomic_pay_agent_settlement'),
            ('transfer_chips_agent_to_player')
         ) AS x(fn)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x.fn
        AND (p.prosrc LIKE '%club_members%' OR p.prosrc LIKE '%fn_pay_player_chips%'));
$function$;

