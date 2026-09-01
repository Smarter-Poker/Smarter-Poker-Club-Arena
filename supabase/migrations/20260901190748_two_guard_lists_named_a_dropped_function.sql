-- ═══════════════════════════════════════════════════════════════════════════
--  TWO GUARD LISTS STILL NAMED A FUNCTION THAT NO LONGER EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 7 dropped atomic_pay_agent_settlement (staff paying an agent out of a
-- column nothing maintained) and took its name off fn_union_money_path_check
-- and guard_wallet_balance_write. The audit sweep afterwards found two more
-- lists still carrying it.
--
-- NEITHER CAN RAISE A FALSE ALARM, and that is worth saying plainly rather than
-- implying an outage that was not there:
--
--   fn_club_arena_global_wallet_check  SELECTs FROM pg_proc WHERE proname IN
--                                      (...). A dropped function returns no
--                                      row, so it cannot be reported.
--   fn_union_overload_check            same shape, GROUP BY ... HAVING count>1.
--                                      No rows, no overload, no finding.
--
-- They are cleaned up because a list that names things which cannot exist stops
-- being read as a list of things that must - phase 6 put it as "leaving a dead
-- name on an allow-list is how an allow-list stops meaning anything". Both are
-- LANGUAGE sql and are re-emitted whole; the assertions below check the name is
-- gone and that everything else in each list survived.
CREATE OR REPLACE FUNCTION public.fn_club_arena_global_wallet_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.proname::text,
         'Club Arena money path references the global wallets table - every club '
         || 'must be its own standalone wallet, never joined or pooled'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','atomic_tournament_unregister','process_tournament_rebuy',
       'atomic_cancel_tournament','fn_pay_player_chips',
       'atomic_pay_player_rakeback','credit_player_rakeback')
       -- atomic_pay_agent_settlement was here until phase 7 dropped it.
     AND p.prosrc ~* '(update|insert into|from)\s+(public\.)?wallets\M';
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_overload_check()
 RETURNS TABLE(fn text, signatures bigint, detail text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.proname::text, count(*),
         'money-path function has multiple signatures - callers may silently hit '
         || 'the stale one (this has already happened three times: buy-in, '
         || 'cascading commission, tournament register)'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'atomic_table_buyin','atomic_table_cashout','atomic_table_rebuy','atomic_table_addon',
       'atomic_tournament_register','atomic_tournament_unregister','process_tournament_rebuy',
       'calculate_cascading_commission','credit_agent_commission_from_rake',
       'atomic_distribute_rake','record_tournament_buyin_rake',
       'fn_pay_player_chips'
       -- atomic_pay_agent_settlement was here until phase 7 dropped it.
     )
   GROUP BY p.proname
  HAVING count(*) > 1;
$function$;

-- Both are estate diagnostics, and both were already service-role-only in
-- production (the autorevoke event trigger strips PUBLIC and anon from every new
-- definer function). Saying it in the file is what check-definer-authorization
-- reads, and what the next person reads: an intention that lives only in a
-- trigger is one nobody can see.
REVOKE ALL ON FUNCTION public.fn_club_arena_global_wallet_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_arena_global_wallet_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_overload_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overload_check() TO service_role;

DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_arena_global_wallet_check';
  IF v_def LIKE '%''atomic_pay_agent_settlement''%' THEN
    RAISE EXCEPTION 'the global wallet check still names a function that no longer exists';
  END IF;
  IF v_def NOT LIKE '%''atomic_pay_player_rakeback''%'
     OR v_def NOT LIKE '%''fn_pay_player_chips''%'
     OR v_def NOT LIKE '%wallets%' THEN
    RAISE EXCEPTION 'the global wallet check lost something it was still supposed to watch';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_overload_check';
  IF v_def LIKE '%''atomic_pay_agent_settlement''%' THEN
    RAISE EXCEPTION 'the overload check still names a function that no longer exists';
  END IF;
  IF v_def NOT LIKE '%''credit_agent_commission_from_rake''%'
     OR v_def NOT LIKE '%''calculate_cascading_commission''%'
     OR v_def NOT LIKE '%HAVING count(*) > 1%' THEN
    RAISE EXCEPTION 'the overload check lost something it was still supposed to watch';
  END IF;

  -- And nothing anywhere still carries the dead name as a list entry.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosrc LIKE '%''atomic_pay_agent_settlement''%'
  ) THEN
    RAISE EXCEPTION 'a function still lists atomic_pay_agent_settlement by name';
  END IF;
END;
$verify$;
