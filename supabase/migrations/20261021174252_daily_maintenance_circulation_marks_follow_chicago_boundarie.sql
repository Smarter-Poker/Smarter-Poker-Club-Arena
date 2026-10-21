-- Align existing observation-only circulation marks with daily Chicago maintenance.
-- @live-proof: (SELECT position('America/Chicago' in pg_get_functiondef('public.fn_ca_capture_freeze_mark(text)'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_capture_freeze_mark(text)'::regprocedure) <> '8baabcd126e931b7274843d5b8658c9f' THEN
    RAISE EXCEPTION 'circulation mark preimage changed; requalify';
  END IF;
END;
$guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_capture_freeze_mark(p_kind text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_at timestamptz := clock_timestamp();
  v_local timestamp := v_at AT TIME ZONE 'America/Chicago';
  v_end timestamptz;
  m numeric; f numeric; t numeric; i integer := 0;
BEGIN
  IF p_kind NOT IN ('pre','post') OR p_kind IS NULL THEN
    RAISE EXCEPTION 'p_kind must be pre or post';
  END IF;
  -- UTC twins are observation opportunities, not two breaks. Refuse every
  -- other local instant, including the unused DST twin and old hourly calls.
  IF extract(hour FROM v_local) <> 4
     OR extract(minute FROM v_local) <> (CASE WHEN p_kind='pre' THEN 0 ELSE 5 END) THEN
    RETURN NULL;
  END IF;
  v_end := (date_trunc('day',v_local) + interval '4 hours 5 minutes') AT TIME ZONE 'America/Chicago';
  IF p_kind='pre' THEN
    -- Existing bounded observation wait. Missing freeze means missing evidence,
    -- never a snapshot of ordinary play disguised as a conserved freeze.
    WHILE NOT public.fn_platform_frozen() AND i < 25 LOOP
      PERFORM pg_sleep(1); i := i + 1;
    END LOOP;
    IF NOT public.fn_platform_frozen() THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.ca_freeze_circulation_marks
    WHERE window_hour=v_end AND kind='pre'
  ) THEN
    RETURN NULL;
  END IF;
  SELECT member_wallets,on_the_felt,total INTO m,f,t FROM public.fn_ca_circulation_total();
  INSERT INTO public.ca_freeze_circulation_marks(window_hour,kind,member_wallets,on_the_felt,total,mark_at)
  VALUES(v_end,p_kind,m,f,t,clock_timestamp())
  -- Repeated delivery must not replace the actual edge with later play.
  ON CONFLICT(window_hour,kind) DO NOTHING;
  RETURN v_end;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_capture_freeze_mark(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_capture_freeze_mark(text) TO service_role;
-- Reuse the same two read-only observers; no release or repair authority.
SELECT cron.schedule('ca-freeze-mark-pre','0 9,10 * * *', $$SELECT public.fn_ca_capture_freeze_mark('pre')$$);
SELECT cron.schedule('ca-freeze-mark-post','5 9,10 * * *', $$SELECT public.fn_ca_capture_freeze_mark('post')$$);
COMMIT;
