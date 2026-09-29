-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429055333 "x15_create_detect_multi_account_ips_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 be1fbab391d6385d2fde55af27d36a12 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 15 — detect_multi_account_ips RPC.
-- Workers VM (smarter-poker-workers/src/routes/anti-cheat-multi-account.ts)
-- has a graceful fallback if this RPC is missing, but the fallback pulls up
-- to 50,000 rows and groups in JS. The RPC does the GROUP BY in Postgres
-- which is dramatically faster on a large action_audit_logs table.
--
-- Returns one row per IP that has ≥ 2 distinct user_id values in the window,
-- shaped to match the IpGroup type the caller expects.

CREATE OR REPLACE FUNCTION public.detect_multi_account_ips(
  p_since timestamptz
) RETURNS TABLE (
  ip_address text,
  user_ids   uuid[],
  hit_count  bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT
    ip_address,
    array_agg(DISTINCT user_id) AS user_ids,
    COUNT(*)                    AS hit_count
  FROM public.action_audit_logs
  WHERE created_at >= p_since
    AND ip_address IS NOT NULL
    AND user_id    IS NOT NULL
  GROUP BY ip_address
  HAVING COUNT(DISTINCT user_id) >= 2;
$function$;

REVOKE EXECUTE ON FUNCTION public.detect_multi_account_ips(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_multi_account_ips(timestamptz) TO service_role;
