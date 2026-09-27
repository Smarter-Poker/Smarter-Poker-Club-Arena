-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260808234603 "a5_bbj_drift_since"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 199168cdc39630c87af28708bff86410 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A5: independent drift alarm for the BBJ leg.
--
-- Every chip rake_records books as a BBJ contribution is supposed to reach the
-- jackpot pool via bbj_record_contribution. atomic_distribute_rake deliberately
-- withholds that slice from the club wallet (v_net := p_rake - v_bbj), so if the
-- pool write fails the chips exist nowhere. Comparing the two ledgers is the
-- only check that catches a failure the engine itself did not notice.
--
-- Read-only, and kept in SQL so the two aggregates run server-side against the
-- created_at indexes rather than shipping 90k rows to the engine.
CREATE OR REPLACE FUNCTION public.bbj_drift_since(p_since timestamptz)
 RETURNS TABLE(booked numeric, received numeric, booked_rows bigint, received_rows bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE((SELECT sum(bbj_contribution) FROM rake_records
               WHERE created_at >= p_since AND bbj_contribution > 0), 0)::numeric,
    COALESCE((SELECT sum(amount) FROM bbj_contributions
               WHERE created_at >= p_since), 0)::numeric,
    COALESCE((SELECT count(*) FROM rake_records
               WHERE created_at >= p_since AND bbj_contribution > 0), 0)::bigint,
    COALESCE((SELECT count(*) FROM bbj_contributions
               WHERE created_at >= p_since), 0)::bigint;
$function$;
