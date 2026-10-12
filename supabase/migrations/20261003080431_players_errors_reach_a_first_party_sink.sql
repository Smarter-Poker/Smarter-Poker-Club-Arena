-- 20261003080431_players_errors_reach_a_first_party_sink
--
-- @live-proof: to_regprocedure('public.fn_report_client_errors(jsonb)') IS NOT NULL
-- @live-proof: EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'client-error-events-prune' AND schedule = '16 * * * *' AND active)
--
-- periodic-work: retention is the product. client_error_events is diagnostic
-- telemetry with a fourteen-day horizon by design; nothing upstream failed for
-- the prune to compensate. Remove the schedule and the table grows forever on
-- a database that is IO-sensitive (402 GB).
--
-- WHAT WAS WRONG. Club Arena had no record of what real players' browsers hit.
-- src/utils/errorReporter.ts wrote console.error and nothing else, Sentry was
-- removed for good on 2026-09-15/27 (owner's standing rule: never re-add it),
-- and horse_bug_reports has received no row since 2026-09-17. Before public
-- launch we could not see "Server error", "Reload the table",
-- ACTION_CONTEXT_REQUIRED, SEAT_OCCUPANCY_REQUIRED, a failed buy-in or leave,
-- or an uncaught exception unless a player sent a screenshot.
--
-- WHAT THIS ADDS. A first-party sink, nothing more:
--
--   client_error_events            one row per reported error (or per sampled
--                                  run of identical errors: `occurrences`).
--                                  RLS on, no policy: no browser role can read,
--                                  update or delete it, and it cannot be
--                                  inserted into directly either.
--   fn_report_client_errors(jsonb) the ONE door in. SECURITY DEFINER so a
--                                  browser can write without a table grant.
--                                  user_id is auth.uid(), never a client value.
--                                  Signed-in callers only: EXECUTE is granted to
--                                  authenticated, not anon, because the live
--                                  definer audit holds anon-executable DEFINER
--                                  writers at zero (audit-live-definer-
--                                  exposure.mjs, anon_writers). Every table,
--                                  buy-in and leave flow is signed in.
--                                  Every field is clamped, PII-scrubbed and
--                                  size-capped here, whatever the client sent.
--   client_error_rates_10m         errors per code per ten minutes, last 24h,
--                                  for SQL reads (service_role only).
--   fn_client_error_health()       the gauges collect-monitoring-health.sh
--                                  turns into poker_client_error_* (service_role).
--   fn_prune_client_error_events   batch-limited fourteen-day retention, on
--                                  pg_cron at :16 (quiet: no other job starts
--                                  at :16 except the every-minute ones, and it
--                                  is far from the :50-:03 break window).
--
-- ABUSE AND SIZE BOUNDS, all enforced in the function, not the client:
--   * per signed-in user: 60 rows a minute; the whole table accepts 300 a
--     minute. Excess is dropped quietly (the function returns how many it
--     kept; it never raises at a browser for bad input or over-limit).
--   * at most 20 events per call and 64 KiB of request JSON.
--   * message 500 chars, stack 2000, route 200, UA 256, code/name 64,
--     source 120, context 2 KiB of JSON (else {"truncated": true}).
--   Worst case 300/min x 14 days = ~6M rows; the hourly prune (20,000 rows a
--   run, 480,000 a day) outpaces the 432,000-a-day ceiling. Normal volume is
--   expected to be orders of magnitude below that.
--
-- NO FOREIGN KEY on user_id (CLAUDE.md DDL rule 7: a log table never carries
-- a foreign key to a hot table, and auth.users is one).
--
-- ONE TRANSACTION, short lock_timeout (DDL policy rules 1 and 7). Every object
-- is new, so nothing existing is locked except the pg_cron catalogue row.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.client_error_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  occurred_at  timestamptz NOT NULL,
  user_id      uuid NOT NULL,
  automated    boolean NOT NULL DEFAULT false,
  route        text CHECK (char_length(route) <= 200),
  app_version  text CHECK (char_length(app_version) <= 64),
  user_agent   text CHECK (char_length(user_agent) <= 256),
  code         text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 64),
  error_name   text CHECK (char_length(error_name) <= 64),
  message      text CHECK (char_length(message) <= 500),
  stack        text CHECK (char_length(stack) <= 2000),
  source       text CHECK (char_length(source) <= 120),
  context      jsonb CHECK (octet_length(context::text) <= 2048),
  dedupe_key   text CHECK (char_length(dedupe_key) <= 64),
  occurrences  integer NOT NULL DEFAULT 1 CHECK (occurrences BETWEEN 1 AND 10000)
);

COMMENT ON TABLE public.client_error_events IS
  'First-party client error telemetry from Club Arena browsers. Written only through fn_report_client_errors (auth.uid() server-side, scrubbed, size-capped, rate-limited). Kept 14 days by fn_prune_client_error_events. Sentry is retired and must not be re-added.';

-- received_at: the global cap, the summary and the prune all range on it.
CREATE INDEX client_error_events_received_at_idx
  ON public.client_error_events (received_at);
-- the per-user rate limit
CREATE INDEX client_error_events_user_received_idx
  ON public.client_error_events (user_id, received_at);

ALTER TABLE public.client_error_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_error_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.client_error_events TO service_role;

-- Scrubbing, in the database as well as the browser: a client that skipped
-- the browser-side scrub still cannot store an email address or a token.
-- Pre-truncated so a 64 KiB string costs no more than a short one.
--   emails -> [email]; JWTs -> [jwt]; "Bearer x" -> "Bearer [token]";
--   token=/password=/apikey=/secret=/key=... -> =[redacted];
--   any 32+ char run of token alphabet containing a digit -> [token]
--   (UUIDs survive: their hyphens split them into short runs).
CREATE FUNCTION public.fn_client_error_scrub(p_text text, p_max integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE WHEN p_text IS NULL THEN NULL ELSE left(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              left(p_text, greatest(p_max, 0) + 256),
              '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
            'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*)?', '[jwt]', 'g'),
          '(bearer)\s+[A-Za-z0-9._~+/=-]+', '\1 [token]', 'gi'),
        '((access_token|refresh_token|id_token|token|apikey|api_key|password|passwd|secret|authorization|key)=)[^&\s"''\\]+',
        '\1[redacted]', 'gi'),
      '(?=[A-Za-z_+/=]*[0-9])[A-Za-z0-9_+/=]{32,}', '[token]', 'g'),
    greatest(p_max, 0)) END
$function$;

REVOKE ALL ON FUNCTION public.fn_client_error_scrub(text, integer) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fn_report_client_errors(p_events jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_now      timestamptz := now();
  v_recent   integer;
  v_global   integer;
  v_budget   integer;
  v_headers  text;
  v_ua       text;
  v_accepted integer := 0;
BEGIN
  -- Best effort, never an error at the browser: a malformed call stores nothing.
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN 0;
  END IF;
  IF octet_length(p_events::text) > 65536 THEN
    RETURN 0;
  END IF;

  -- Signed-in callers only (EXECUTE is not granted to anon; this is the
  -- belt to that brace, e.g. a service_role call with no user).
  IF v_uid IS NULL THEN
    RETURN 0;
  END IF;

  -- One reporter at a time, so count-then-insert cannot be raced past its cap.
  PERFORM pg_advisory_xact_lock(hashtextextended('client_error_events:' || v_uid::text, 0));

  SELECT count(*) INTO v_recent FROM (
    SELECT 1 FROM public.client_error_events
     WHERE user_id = v_uid AND received_at > v_now - interval '1 minute'
     LIMIT 60) s;
  v_budget := 60 - v_recent;
  IF v_budget <= 0 THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO v_global FROM (
    SELECT 1 FROM public.client_error_events
     WHERE received_at > v_now - interval '1 minute'
     LIMIT 300) s;
  v_budget := least(v_budget, 300 - v_global, 20);
  IF v_budget <= 0 THEN
    RETURN 0;
  END IF;

  -- The request's own User-Agent, not a client-supplied one.
  v_headers := current_setting('request.headers', true);
  IF v_headers IS NOT NULL AND pg_input_is_valid(v_headers, 'jsonb') THEN
    v_ua := v_headers::jsonb ->> 'user-agent';
  END IF;

  INSERT INTO public.client_error_events (
    occurred_at, user_id, automated, route, app_version, user_agent, code,
    error_name, message, stack, source, context, dedupe_key, occurrences)
  SELECT
    CASE WHEN jsonb_typeof(e -> 'at') = 'number'
         THEN to_timestamp(least(greatest((e ->> 'at')::double precision / 1000.0,
                                          extract(epoch FROM v_now - interval '1 day')),
                                 extract(epoch FROM v_now)))
         ELSE v_now END,
    v_uid,
    coalesce((e -> 'automated') = 'true'::jsonb, false),
    CASE WHEN jsonb_typeof(e -> 'route') = 'string'
         THEN public.fn_client_error_scrub(split_part(split_part(e ->> 'route', '?', 1), '#', 1), 200) END,
    CASE WHEN jsonb_typeof(e -> 'app_version') = 'string'
         THEN left(regexp_replace(e ->> 'app_version', '[^A-Za-z0-9._+-]', '', 'g'), 64) END,
    left(coalesce(v_ua, CASE WHEN jsonb_typeof(e -> 'user_agent') = 'string' THEN e ->> 'user_agent' END), 256),
    coalesce(nullif(left(regexp_replace(
      CASE WHEN jsonb_typeof(e -> 'code') = 'string' THEN e ->> 'code' ELSE '' END,
      '[^A-Za-z0-9_.:-]', '_', 'g'), 64), ''), 'UNKNOWN'),
    CASE WHEN jsonb_typeof(e -> 'name') = 'string'
         THEN nullif(left(regexp_replace(e ->> 'name', '[^A-Za-z0-9_.:-]', '_', 'g'), 64), '') END,
    CASE WHEN jsonb_typeof(e -> 'message') = 'string'
         THEN public.fn_client_error_scrub(e ->> 'message', 500) END,
    CASE WHEN jsonb_typeof(e -> 'stack') = 'string'
         THEN public.fn_client_error_scrub(e ->> 'stack', 2000) END,
    CASE WHEN jsonb_typeof(e -> 'source') = 'string'
         THEN nullif(left(regexp_replace(e ->> 'source', '[^A-Za-z0-9_.:/-]', '_', 'g'), 120), '') END,
    CASE
      WHEN jsonb_typeof(e -> 'context') <> 'object' OR e -> 'context' IS NULL THEN NULL
      WHEN octet_length((e -> 'context')::text) > 2048 THEN jsonb_build_object('truncated', true)
      ELSE (SELECT CASE WHEN pg_input_is_valid(s.t, 'jsonb') AND octet_length(s.t) <= 2048
                        THEN s.t::jsonb ELSE jsonb_build_object('truncated', true) END
              FROM (SELECT public.fn_client_error_scrub((e -> 'context')::text, 2048) AS t) s)
    END,
    CASE WHEN jsonb_typeof(e -> 'dedupe_key') = 'string'
         THEN nullif(left(regexp_replace(e ->> 'dedupe_key', '[^A-Za-z0-9_.:|-]', '', 'g'), 64), '') END,
    CASE WHEN jsonb_typeof(e -> 'occurrences') = 'number'
         THEN least(10000, greatest(1, floor((e ->> 'occurrences')::numeric)))::integer
         ELSE 1 END
  FROM (
    SELECT x.e
      FROM jsonb_array_elements(p_events) WITH ORDINALITY AS x(e, n)
     WHERE jsonb_typeof(x.e) = 'object'
     ORDER BY x.n
     LIMIT v_budget
  ) ev(e);

  GET DIAGNOSTICS v_accepted = ROW_COUNT;
  RETURN v_accepted;
END;
$function$;

COMMENT ON FUNCTION public.fn_report_client_errors(jsonb) IS
  'Best-effort client error sink for signed-in players. user_id = auth.uid(); 60/min per user, 300/min total, 20 per call; scrubbed and size-capped. Returns rows kept; never raises at the caller for bad input or over-limit.';

REVOKE ALL ON FUNCTION public.fn_report_client_errors(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_report_client_errors(jsonb) TO authenticated, service_role;

-- Errors per code per ten minutes, last 24 hours, automated sessions excluded.
CREATE VIEW public.client_error_rates_10m WITH (security_invoker = true) AS
SELECT date_bin(interval '10 minutes', received_at, timestamptz '2000-01-01 00:00:00+00') AS bucket_start,
       code,
       count(*)::integer                                  AS reports,
       sum(occurrences)::integer                          AS occurrences,
       count(DISTINCT user_id)::integer                   AS users
  FROM public.client_error_events
 WHERE received_at > now() - interval '24 hours'
   AND NOT automated
 GROUP BY 1, 2;

REVOKE ALL ON public.client_error_rates_10m FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_error_rates_10m TO service_role;

-- The gauges for Prometheus (server/scripts/collect-monitoring-health.sh).
-- Last ten minutes, automated sessions excluded. top_code_users is the spike
-- signal: how many distinct players hit the single worst code.
CREATE FUNCTION public.fn_client_error_health()
RETURNS TABLE (
  client_errors_10m          integer,
  client_error_users_10m     integer,
  client_error_top_code_users_10m integer,
  client_error_top_code      text
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH recent AS (
    SELECT code, user_id, occurrences
      FROM public.client_error_events
     WHERE received_at > now() - interval '10 minutes'
       AND NOT automated
  ), per_code AS (
    SELECT code, count(DISTINCT user_id)::integer AS users
      FROM recent GROUP BY code
  )
  SELECT coalesce((SELECT sum(occurrences) FROM recent), 0)::integer,
         (SELECT count(DISTINCT user_id) FROM recent)::integer,
         coalesce((SELECT max(users) FROM per_code), 0)::integer,
         (SELECT code FROM per_code ORDER BY users DESC, code LIMIT 1)
$function$;

REVOKE ALL ON FUNCTION public.fn_client_error_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_client_error_health() TO service_role;

CREATE FUNCTION public.fn_prune_client_error_events(
  p_keep  interval DEFAULT interval '14 days',
  p_batch integer  DEFAULT 20000)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.client_error_events
   WHERE id IN (
     SELECT id FROM public.client_error_events
      WHERE received_at < now() - greatest(coalesce(p_keep, interval '14 days'), interval '1 day')
      ORDER BY received_at
      LIMIT least(greatest(coalesce(p_batch, 20000), 1), 50000));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_prune_client_error_events(interval, integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'client-error-events-prune',
  '16 * * * *',
  $job$SET statement_timeout = '60s'; SELECT public.fn_prune_client_error_events(interval '14 days', 20000);$job$
);

COMMIT;
