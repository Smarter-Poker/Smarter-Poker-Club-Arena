/* WHY THIS EXISTS. Every detector on this platform can raise an incident and
   none of them can close one. fn_ca_conservation_sweep has been folding the
   same two findings since 2026-09-02 - 92 and 89 occurrences - and would keep
   folding them for as long as the platform runs even after the thing they
   found was fixed, because the only way an incident closes is a human or a
   migration writing a root cause into it. So the board fills with work that
   is already done, and a board nobody can empty is a board nobody reads: that
   is how 3,402 open incidents happened.

   The measurement that raised a finding is the only thing qualified to say it
   is gone. A detector that runs on a schedule already says so, by not raising
   it again. This records when each detector completed, and closes what it has
   stopped reporting - but only after TWO clean runs, so one flaky pass, one
   statement timeout, one check that errored instead of running, can never
   close a real finding by accident. */

CREATE TABLE IF NOT EXISTS public.ca_detector_runs (
  id       bigserial PRIMARY KEY,
  detector text        NOT NULL,
  ran_at   timestamptz NOT NULL DEFAULT now(),
  detail   jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ix_ca_detector_runs_detector_ran_at
  ON public.ca_detector_runs (detector, ran_at DESC);
ALTER TABLE public.ca_detector_runs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_ca_resolve_cleared_incidents()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $fn$
DECLARE
  d          record;
  v_second   timestamptz;
  v_last     timestamptz;
  v_closed   int := 0;
  v_total    int := 0;
  v_out      jsonb := '[]'::jsonb;
  v_actor    uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
BEGIN
  FOR d IN SELECT unnest(ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch']) AS detector
  LOOP
    /* TWO CLEAN RUNS, NOT ONE. last_seen_at is bumped every time a finding is
       re-raised. If it is older than the run BEFORE last, the detector has
       completed twice without mentioning it. One run is not enough: a check
       that times out or errors raises a sweepfail incident under a different
       key, and that must never be mistaken for the finding having cleared. */
    SELECT ran_at INTO v_last
      FROM public.ca_detector_runs WHERE detector = d.detector
     ORDER BY ran_at DESC LIMIT 1;
    SELECT ran_at INTO v_second
      FROM public.ca_detector_runs WHERE detector = d.detector
     ORDER BY ran_at DESC OFFSET 1 LIMIT 1;

    IF v_second IS NULL THEN
      v_out := v_out || jsonb_build_object('detector', d.detector,
                 'closed', 0, 'why', 'fewer than two recorded runs so far');
      CONTINUE;
    END IF;

    -- A finding raised AFTER the earlier run is too young to judge.
    UPDATE public.ca_drift_incidents i
       SET status         = 'resolved',
           resolved_at    = now(),
           resolved_by    = v_actor,
           root_cause     = 'the measurement that raised this stopped reporting it: '
                         || d.detector || ' completed at ' || v_second::text
                         || ' and again at ' || v_last::text
                         || ' without raising it either time, so the condition it '
                         || 'found no longer holds. Closed by the same measurement '
                         || 'that opened it, never by assumption.',
           correction_ref = 'verified: ' || d.detector || ' ran twice without re-raising this, '
                         || 'most recently at ' || v_last::text,
           resolution     = 'no chips moved to close this. The detector re-measured and '
                         || 'found nothing; if the condition returns, the next run raises '
                         || 'it again with a fresh incident.'
     WHERE i.resolved_at IS NULL
       AND i.source LIKE d.detector || '%'
       AND i.created_at < v_second
       AND i.last_seen_at < v_second;
    GET DIAGNOSTICS v_closed = ROW_COUNT;
    v_total := v_total + v_closed;
    v_out := v_out || jsonb_build_object('detector', d.detector, 'closed', v_closed,
               'clean_since', v_second, 'last_run', v_last);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'closed', v_total, 'detectors', v_out);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_resolve_cleared_incidents() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_resolve_cleared_incidents() FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_resolve_cleared_incidents() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resolve_cleared_incidents() TO service_role;

DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  ------------------------------------------------------------------
  -- The sweep records that it finished.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep';
  IF position($chk$ca_detector_runs$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the sweep already records its runs';
  END IF;
  IF position($chk$  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the sweep return moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,$old$,
$new$  /* A COMPLETED RUN IS ITSELF EVIDENCE. Recorded here, at the end, so it
     is written only when every check actually ran.
     fn_ca_resolve_cleared_incidents reads this to close the findings this
     sweep has stopped reporting. */
  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_conservation_sweep',
          jsonb_build_object('checks_run', v_ran, 'with_findings', v_found, 'errored', v_failed));

  RETURN jsonb_build_object('ok', true, 'checks_run', v_ran,$new$);
  IF v_new = v_src THEN RAISE EXCEPTION 'the sweep did not learn to record its runs'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- The ratchet the same, and it stops holding a line it has passed.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_ratchet_watch';
  IF position($chk$ca_detector_runs$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the ratchet already records its runs';
  END IF;
  IF position($chk$  RETURN jsonb_build_object('checked_at', now(), 'ratchets', v_out);$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the ratchet return moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$  RETURN jsonb_build_object('checked_at', now(), 'ratchets', v_out);$old$,
$new$  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_ratchet_watch', jsonb_build_object('ratchets', v_out));

  RETURN jsonb_build_object('checked_at', now(), 'ratchets', v_out);$new$);
  IF v_new = v_src THEN RAISE EXCEPTION 'the ratchet did not learn to record its runs'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('fn_ca_conservation_sweep','fn_ca_ratchet_watch')
         AND position($chk$INSERT INTO public.ca_detector_runs$chk$ IN pg_get_functiondef(p.oid)) > 0) <> 2 THEN
    RAISE EXCEPTION 'a detector did not learn to record its runs';
  END IF;
END
$mig$;

SELECT cron.schedule('ca-resolve-cleared-incidents-hourly', '23 * * * *',
  $cron$SELECT public.fn_ca_resolve_cleared_incidents();$cron$);;
