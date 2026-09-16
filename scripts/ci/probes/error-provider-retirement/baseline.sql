-- Isolated schema derived from the names-only live catalog, 2026-09-16.

CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;

CREATE TABLE public.sentry_error_log (
  id bigserial NOT NULL,
  sentry_issue_id text NOT NULL,
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  title text NOT NULL,
  culprit text,
  level text DEFAULT 'error'::text,
  first_seen timestamp with time zone,
  last_seen timestamp with time zone,
  user_count integer DEFAULT 0,
  event_count integer DEFAULT 0,
  page_url text,
  category text,
  is_new boolean DEFAULT false,
  sentry_link text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (sentry_issue_id, snapshot_date)
);

CREATE TABLE public.sentry_event_budget (
  day date NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day),
  CHECK ((sent >= 0))
);

CREATE TABLE public.sentry_event_fingerprints (
  day date NOT NULL,
  fingerprint text NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fingerprint),
  CHECK ((sent >= 0))
);

CREATE TABLE public.signup_errors (
  id bigserial NOT NULL,
  user_id uuid,
  email text,
  trigger_name text NOT NULL,
  error_code text,
  error_msg text,
  raw_meta jsonb,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  forwarded_to_sentry timestamp with time zone,
  PRIMARY KEY (id)
);

CREATE INDEX signup_errors_occurred_at_idx ON public.signup_errors USING btree (occurred_at DESC);

CREATE INDEX signup_errors_pending_forward_idx ON public.signup_errors USING btree (occurred_at) WHERE (forwarded_to_sentry IS NULL);

CREATE TABLE public.signup_errors_archive (
  id bigserial NOT NULL,
  original_id bigint NOT NULL,
  user_id uuid,
  email text,
  trigger_name text NOT NULL,
  error_code text,
  error_msg text,
  raw_meta jsonb,
  occurred_at timestamp with time zone NOT NULL,
  forwarded_to_sentry timestamp with time zone,
  archived_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE OR REPLACE FUNCTION public.archive_signup_errors(older_than_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    moved_count int := 0;
    cutoff timestamptz := now() - (older_than_days || ' days')::interval;
BEGIN
    -- Idempotent: skip rows we've already archived
    WITH moved AS (
        INSERT INTO public.signup_errors_archive
            (original_id, user_id, email, trigger_name, error_code, error_msg,
             raw_meta, occurred_at, forwarded_to_sentry)
        SELECT id, user_id, email, trigger_name, error_code, error_msg,
               raw_meta, occurred_at, forwarded_to_sentry
        FROM public.signup_errors
        WHERE occurred_at < cutoff
          AND NOT EXISTS (
              SELECT 1 FROM public.signup_errors_archive a
              WHERE a.original_id = signup_errors.id
          )
        RETURNING original_id
    )
    DELETE FROM public.signup_errors WHERE id IN (SELECT original_id FROM moved);

    GET DIAGNOSTICS moved_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'moved', moved_count,
        'cutoff', cutoff,
        'older_than_days', older_than_days
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sentry_budget_take(p_fingerprint text, p_daily_limit integer DEFAULT 60, p_fingerprint_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_day      date := (now() AT TIME ZONE 'utc')::date;
    v_fp       text := COALESCE(NULLIF(left(p_fingerprint, 200), ''), 'unknown');
    v_fp_sent  integer;
    v_sent     integer;
BEGIN
    DELETE FROM public.sentry_event_budget       WHERE day < v_day - 14;
    DELETE FROM public.sentry_event_fingerprints WHERE day < v_day - 14;

    INSERT INTO public.sentry_event_budget (day, sent)
        VALUES (v_day, 0) ON CONFLICT (day) DO NOTHING;
    INSERT INTO public.sentry_event_fingerprints (day, fingerprint, sent)
        VALUES (v_day, v_fp, 0) ON CONFLICT (day, fingerprint) DO NOTHING;

    UPDATE public.sentry_event_fingerprints
       SET sent = sent + 1
     WHERE day = v_day AND fingerprint = v_fp AND sent < p_fingerprint_limit
    RETURNING sent INTO v_fp_sent;

    IF v_fp_sent IS NULL THEN
        SELECT sent INTO v_fp_sent FROM public.sentry_event_fingerprints
         WHERE day = v_day AND fingerprint = v_fp;
        SELECT sent INTO v_sent FROM public.sentry_event_budget WHERE day = v_day;
        RETURN jsonb_build_object(
            'allowed', false, 'reason', 'fingerprint_cap',
            'sent', COALESCE(v_sent, 0), 'fingerprint_sent', COALESCE(v_fp_sent, 0));
    END IF;

    UPDATE public.sentry_event_budget
       SET sent = sent + 1
     WHERE day = v_day AND sent < p_daily_limit
    RETURNING sent INTO v_sent;

    IF v_sent IS NULL THEN
        UPDATE public.sentry_event_fingerprints
           SET sent = GREATEST(sent - 1, 0)
         WHERE day = v_day AND fingerprint = v_fp;
        SELECT sent INTO v_sent FROM public.sentry_event_budget WHERE day = v_day;
        RETURN jsonb_build_object(
            'allowed', false, 'reason', 'daily_budget',
            'sent', COALESCE(v_sent, 0), 'fingerprint_sent', GREATEST(v_fp_sent - 1, 0));
    END IF;

    RETURN jsonb_build_object(
        'allowed', true, 'reason', 'ok',
        'sent', v_sent, 'fingerprint_sent', v_fp_sent);
END;
$function$;

CREATE VIEW public.signup_health_view AS SELECT trigger_name, count(*) AS failures FROM public.signup_errors GROUP BY trigger_name;

REVOKE ALL ON FUNCTION public.archive_signup_errors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_signup_errors(integer) TO service_role;
ALTER TABLE public.signup_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_errors_archive ENABLE ROW LEVEL SECURITY;
CREATE POLICY signup_errors_service_only ON public.signup_errors TO service_role USING (true) WITH CHECK (true);
CREATE POLICY signup_errors_archive_service_only ON public.signup_errors_archive TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.signup_errors, public.signup_errors_archive TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
