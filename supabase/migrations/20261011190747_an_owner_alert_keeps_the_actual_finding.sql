-- Preserve the factual finding in the existing owner page. No new sender/job.
-- @live-proof: (SELECT position('original_notification''->>''message' IN pg_get_functiondef('public.fn_ca_a_real_alert_reaches_the_owner()'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $patch$
DECLARE v_src text; v_old text; v_new text;
BEGIN
  v_src := pg_get_functiondef('public.fn_ca_a_real_alert_reaches_the_owner()'::regprocedure);
  IF md5(v_src) <> '279c02581cb2d16436f528710046fe3b' THEN
    RAISE EXCEPTION 'OWNER_FINDING_PREIMAGE_CHANGED';
  END IF;
  v_old := $old$      NULLIF(NEW.payload->'original_notification'->>'title', ''),$old$;
  v_new := $new$      NULLIF(btrim(NEW.payload->'original_notification'->>'message'), ''),
      NULLIF(NEW.payload->'original_notification'->>'title', ''),$new$;
  IF position(v_old IN v_src) = 0 THEN RAISE EXCEPTION 'OWNER_FINDING_PATCH_MISSING'; END IF;
  EXECUTE replace(v_src,v_old,v_new);
END;
$patch$;
COMMIT;
