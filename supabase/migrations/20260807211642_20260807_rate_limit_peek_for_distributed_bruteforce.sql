-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807211642 "20260807_rate_limit_peek_for_distributed_bruteforce"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fe903ff1d7bc82c5af464ad1008f8425 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Read-only "is this key currently locked out?" check (does NOT increment).
--
-- Why this exists: per-IP throttling alone does not stop a distributed attack.
-- Testing the new limiter against production showed the counter working exactly
-- as designed while the burst still sailed through, because the attempts arrived
-- from a rotating pool of source IPs (a cloud NAT range) — each IP had its own
-- counter and none reached the threshold. Any attacker with a few proxies gets
-- the same result.
--
-- The fix is to also throttle on a dimension the attacker cannot rotate: the
-- venue whose PINs are being guessed. That counter must only be incremented on
-- FAILED attempts (so a busy room's successful logins never trip it), and it has
-- to be *checked* without incrementing before the PIN is verified — hence this
-- peek function.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_rate_limit_blocked(text,text,text);

CREATE OR REPLACE FUNCTION public.fn_rate_limit_blocked(
  p_identifier      text,
  p_endpoint        text,
  p_identifier_type text DEFAULT 'ip'
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (rl.blocked_until - now())))::int)
       FROM public.commander_rate_limits rl
      WHERE rl.identifier = p_identifier
        AND rl.identifier_type = p_identifier_type
        AND rl.endpoint = p_endpoint
        AND rl.blocked_until IS NOT NULL
        AND rl.blocked_until > now()
      LIMIT 1),
    0);
$$;

REVOKE ALL ON FUNCTION public.fn_rate_limit_blocked(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_rate_limit_blocked(text,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_rate_limit_blocked(text,text,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rate_limit_blocked(text,text,text) TO service_role;
