-- ═══════════════════════════════════════════════════════════════════════════
-- MEMBER FEE ROLLUP - give the refresh functions their own statement timeout
-- 2026-08-23   (APPLIED to production via the Supabase MCP before this commit)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
--
-- The engine's refresh loop called fn_refresh_member_fee_rollup every 2s from
-- the moment it deployed and rolled up NOTHING. The watermark in
-- member_fee_rollup_state never moved.
--
-- The call reaches Postgres through PostgREST, which connects as
-- `authenticator` (statement_timeout=8s). `service_role` has no rolconfig of
-- its own, so it inherits that 8s. Measured on production, a batch costs about
-- 23ms per hand:
--
--     250 hands   ->  5.7s
--     2000 hands  ->  ~46s     (the batch size originally shipped)
--
-- So every call came back 57014 "canceling statement due to statement timeout"
-- as an HTTP 500. The loop reported the error and retried a minute later,
-- forever. The same call over a direct SQL connection succeeds every time,
-- which is why it looked healthy when tested by hand: that path runs as
-- `postgres` with a 2min timeout.
--
-- WHAT THIS DOES
--
-- Attaches statement_timeout=30s to the two rollup functions themselves. A
-- function-local GUC applies only for the duration of the call, so nothing
-- else reaching Postgres through PostgREST is loosened - deliberately NOT a
-- change to the `authenticator` or `service_role` defaults.
--
-- 30s sits above the worst plausible batch. The engine's supabase client
-- aborts at 15s via AbortController, so the CLIENT remains the real ceiling
-- and ROLLUP_BATCH_HANDS (server/src/index.ts) is set to 250 to fit inside it.
-- The headroom here means a slow batch fails on the client's terms - a clean
-- abort and a retry - rather than as a server-side 500.
--
-- SAFETY. Both functions are additive, idempotent and take a
-- transaction-scoped advisory lock, and the watermark only advances inside the
-- function's own transaction. A cancelled call costs time and nothing else,
-- which is precisely why this failure was silent.
--
-- ROLLBACK
--   ALTER FUNCTION public.fn_refresh_member_fee_rollup(integer) RESET statement_timeout;
--   ALTER FUNCTION public.ca_touch_member_fee_rollup() RESET statement_timeout;

ALTER FUNCTION public.fn_refresh_member_fee_rollup(integer) SET statement_timeout = '30s';
ALTER FUNCTION public.ca_touch_member_fee_rollup() SET statement_timeout = '30s';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname IN ('fn_refresh_member_fee_rollup', 'ca_touch_member_fee_rollup')
    AND p.proconfig @> ARRAY['statement_timeout=30s'];
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected both rollup functions to carry statement_timeout=30s, found % of 2', n;
  END IF;
END $$;
