-- 20261015183650_an_informational_alert_is_recorded_informational.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AN INFORMATIONAL ALERT IS RECORDED INFORMATIONAL (2026-10-15)
--
-- WHAT HAPPENED, read from production (kuklfnapbkmacvwxktbh):
--
--   20260927143752 (recorded as 20260927214610) routes the owner account's
--   issuer-side accounting copies away from Dan's phone (his ruling: they
--   never reach his phone) and records ONE coalesced summary per UTC hour,
--   "Accounting Documents Issued (Owner Copy)", through
--   fn_record_operational_alert(source 'owner-accounting-notifications',
--   status 'info', severity 'info'). 20260928032225 addressed it to the fleet.
--   Its own header calls 'info' "the designed non-incident state".
--
--   The store has no non-incident state. investigation_status defaults to
--   'new' and its CHECK allows only new, investigating, blocked,
--   verified_fixed, historical and test. So every one of those hourly
--   summaries lands as 'new' (19 in the last 14 days, the latest at 16:37 UTC
--   today, row 254558, the 16:00 UTC hour), and a fleet lane has to close a row that
--   never described a defect, by hand, every hour a settlement runs. The same
--   is true of the per-release receipts a Post-Deploy E2E episode records
--   beside its firing row (kind failed-release / stale-success, status and
--   severity info; 170 in 14 days, 15 'new' at 18:30 UTC): the episode's
--   firing row is the alert, the receipts are its evidence. Those are the only
--   two sources writing status 'info' and severity 'info' (read 2026-10-15).
--
-- THE CAUSE, at the line: fn_record_operational_alert() inserts
--   (source,event_key,alertname,status,severity,payload) and lets
--   investigation_status default to 'new' for every row, whatever the writer
--   said the row is.
--
-- THE FIX, one transaction:
--   1. investigation_status admits 'informational'. The new CHECK is a strict
--      superset of the old one, so it is added NOT VALID: every existing row
--      already satisfies the old list, and NOT VALID avoids a full validating
--      scan of a 383 MB table under ACCESS EXCLUSIVE. New and updated rows are
--      checked as before.
--   2. fn_record_operational_alert() records a row whose writer says status
--      'info' AND severity 'info' as 'informational'; everything else still
--      lands 'new'. A repeat delivery (ON CONFLICT) leaves the state alone, as
--      it leaves the evidence alone. fn_record_operational_alerts() delegates
--      to it, so the batch writer follows. Nothing pages differently:
--      zz_a_real_alert_reaches_the_owner fires only for status 'firing', so
--      Dan's ruling that the owner copy never reaches his phone is untouched.
--   3. The rows already recorded that way and still 'new' are recorded
--      'informational' (16 at 18:30 UTC: 15 Post-Deploy receipts and the
--      16:00 UTC owner-copy summary, row 254558). Nothing else moves; evidence and
--      payload are not touched.
--
--   The fleet treats 'informational' as not open, like 'historical'.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (4bab2581...), the one anchor
-- must occur exactly once (measured read-only on production: 1), and the
-- result must hash to the postimage derived read-only on production with
-- replace() (42d7a1af...). Owner, SECURITY DEFINER, proconfig and grants must
-- not move.
--
-- Regression: scripts/ci/test-informational-alert-state.py (native
-- PostgreSQL), run by .github/workflows/informational-alert-state.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure)) = '42d7a1af30b4f8e83c40ad9dd21de11c' AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'operational_alert_events_investigation_status_check' AND conrelid = 'public.operational_alert_events'::regclass)) LIKE '%informational%')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_alert_store_subst(p_sig text, p_before text, p_after text,
                                             p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- 1. The store admits the informational state. The pinned old list must be
--    exactly what this replaces.
DO $c$
BEGIN
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
                            WHERE conname = 'operational_alert_events_investigation_status_check'
                              AND conrelid = 'public.operational_alert_events'::regclass))
     IS DISTINCT FROM $d$CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text])))$d$
  THEN
    RAISE EXCEPTION 'operational_alert_events_investigation_status_check is not the pinned list';
  END IF;
END $c$;

ALTER TABLE public.operational_alert_events
  DROP CONSTRAINT operational_alert_events_investigation_status_check,
  ADD CONSTRAINT operational_alert_events_investigation_status_check
    CHECK (investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text,
                                             'verified_fixed'::text, 'historical'::text, 'test'::text,
                                             'informational'::text])) NOT VALID;

-- 2. The writer records an informational event as informational.
SELECT pg_temp.ca_alert_store_subst(
  'public.fn_record_operational_alert(text,text,text,text,text,jsonb)',
  '4bab2581b3dff1e09b22d0df46c68df8', '42d7a1af30b4f8e83c40ad9dd21de11c',
  ARRAY[$ao1$  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
$ao1$],
  ARRAY[$an1$  --
  -- AN INFORMATIONAL EVENT IS RECORDED INFORMATIONAL (2026-10-15). A row
  -- whose writer says status 'info' AND severity 'info' is a record, not an
  -- incident: the hourly "Accounting Documents Issued (Owner Copy)" summary
  -- (20260927143752) and the per-release receipts of a Post-Deploy episode
  -- (the episode's own firing row is the alert). It lands as 'informational',
  -- which the fleet does not triage, instead of 'new', which it must close by
  -- hand every hour. Everything else still lands 'new'.
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload,investigation_status)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload,
         CASE WHEN p_status = 'info' AND p_severity = 'info' THEN 'informational' ELSE 'new' END)
$an1$]
);

-- 3. The informational rows already recorded as 'new'.
UPDATE public.operational_alert_events
   SET investigation_status = 'informational'
 WHERE status = 'info' AND severity = 'info' AND investigation_status = 'new';

COMMIT;
