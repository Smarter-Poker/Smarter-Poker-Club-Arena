-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 15 — detect_multi_account_ips RPC.
--
-- Found by greppping every supabase.rpc(...) in smarter-poker-workers/src
-- and joining against pg_proc. Workers tier was 100% clean except this one
-- RPC, which the anti-cheat-multi-account handler calls.
--
-- The handler has a graceful fallback (queries action_audit_logs directly
-- when the RPC errors), but the fallback pulls up to 50,000 rows and groups
-- in JS. The RPC does the GROUP BY in Postgres which is dramatically faster
-- on a large action_audit_logs table.
--
-- Returns one row per IP that has ≥ 2 distinct user_id values in the window,
-- shaped to match the IpGroup type the caller expects.
--
-- Applied to production via Supabase MCP migration
-- x15_create_detect_multi_account_ips_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

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
