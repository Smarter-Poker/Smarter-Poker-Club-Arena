-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807211132 "20260807_durable_rate_limiter_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 09f62f6f7a51b7c21bdc46775e11ab5c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Durable, shared rate limiter.
-- Staff PIN login documented "5 attempts/minute, lockout after 10 failures" but
-- enforced it in a per-process in-memory Map. On Vercel each lambda instance has
-- its own Map (and it resets on deploy), so a burst spread across instances is
-- never throttled: 14 consecutive wrong-PIN attempts were measured against
-- production with zero lockouts. That is an unauthenticated brute-force path
-- against a 6-digit PIN, and the bcrypt cost was deliberately tuned low on the
-- assumption that online attempts were throttled.
--
-- commander_rate_limits already existed with the right shape and a unique index
-- on (identifier, identifier_type, endpoint) but had never been written to.
-- This RPC makes it the shared source of truth. SELECT ... FOR UPDATE serialises
-- concurrent lambdas, so counting is correct no matter how many instances serve
-- the burst.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_rate_limit_hit(text,text,integer,integer,integer,text);

CREATE OR REPLACE FUNCTION public.fn_rate_limit_hit(
  p_identifier      text,
  p_endpoint        text,
  p_max_requests    integer DEFAULT 5,
  p_window_minutes  integer DEFAULT 1,
  p_lockout_minutes integer DEFAULT 5,
  p_identifier_type text    DEFAULT 'ip'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r          public.commander_rate_limits;
  v_count    integer;
  v_window   timestamptz;
  v_now      timestamptz := now();
BEGIN
  -- Ensure the counter row exists (starts at 0; the update below does the count).
  INSERT INTO public.commander_rate_limits
        (identifier, identifier_type, endpoint, request_count, window_start,
         window_minutes, max_requests, last_request_at)
  VALUES (p_identifier, p_identifier_type, p_endpoint, 0, v_now,
          p_window_minutes, p_max_requests, v_now)
  ON CONFLICT (identifier, identifier_type, endpoint) DO NOTHING;

  -- Serialise concurrent callers on this counter.
  SELECT * INTO r
    FROM public.commander_rate_limits
   WHERE identifier = p_identifier
     AND identifier_type = p_identifier_type
     AND endpoint = p_endpoint
   FOR UPDATE;

  -- Still inside an active lockout.
  IF r.blocked_until IS NOT NULL AND r.blocked_until > v_now THEN
    UPDATE public.commander_rate_limits
       SET last_request_at = v_now
     WHERE id = r.id;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'LOCKED_OUT',
      'retry_after', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (r.blocked_until - v_now)))::int)
    );
  END IF;

  -- Roll the window if it has expired, otherwise increment inside it.
  IF r.window_start IS NULL
     OR r.window_start + make_interval(mins => COALESCE(r.window_minutes, p_window_minutes)) <= v_now THEN
    v_count  := 1;
    v_window := v_now;
  ELSE
    v_count  := COALESCE(r.request_count, 0) + 1;
    v_window := r.window_start;
  END IF;

  -- Over the limit: start a lockout.
  IF v_count > p_max_requests THEN
    UPDATE public.commander_rate_limits
       SET request_count   = v_count,
           window_start    = v_window,
           window_minutes  = p_window_minutes,
           max_requests    = p_max_requests,
           is_blocked      = true,
           blocked_until   = v_now + make_interval(mins => p_lockout_minutes),
           block_reason    = 'rate_limit_exceeded',
           last_request_at = v_now
     WHERE id = r.id;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'RATE_LIMITED',
      'retry_after', p_lockout_minutes * 60
    );
  END IF;

  UPDATE public.commander_rate_limits
     SET request_count   = v_count,
         window_start    = v_window,
         window_minutes  = p_window_minutes,
         max_requests    = p_max_requests,
         is_blocked      = false,
         blocked_until   = NULL,
         block_reason    = NULL,
         last_request_at = v_now
   WHERE id = r.id;

  RETURN jsonb_build_object('allowed', true, 'reason', null, 'retry_after', 0);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_rate_limit_hit(text,text,integer,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_rate_limit_hit(text,text,integer,integer,integer,text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_rate_limit_hit(text,text,integer,integer,integer,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rate_limit_hit(text,text,integer,integer,integer,text) TO service_role;
