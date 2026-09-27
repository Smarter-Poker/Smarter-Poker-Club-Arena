-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820140457 "union_law_resolve_selftest_false_positive_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 16073c9f4ef743e25429701382fee3da of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Resolve the single critical raised at 13:58 by fn_union_law_selftest. It was
-- a FALSE POSITIVE of the guard added minutes earlier: atomic_pay_player_rakeback
-- and atomic_pay_agent_settlement ARE club-scoped, but they reach club_members
-- through the shared helper fn_pay_player_chips, which the first version of
-- fn_union_money_path_check did not recognise. The guard is now delegation-aware
-- and the self-test reports healthy. The reason is appended to context so the
-- record explains itself.
UPDATE public.financial_alerts
   SET resolved = true,
       resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'resolution',
         'False positive: guard was not delegation-aware. Both functions route '
         || 'club chips via fn_pay_player_chips. fn_union_money_path_check '
         || 'updated 2026-08-20; self-test healthy.')
 WHERE source = 'fn_union_law_selftest'
   AND severity = 'critical'
   AND COALESCE(resolved, false) = false
   AND context::text LIKE '%money_path_not_club_scoped%';

