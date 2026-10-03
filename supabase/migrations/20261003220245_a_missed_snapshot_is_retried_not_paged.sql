-- ===========================================================================
--  A MISSED SNAPSHOT IS RETRIED, NOT PAGED
-- ===========================================================================
--
-- Incident f991dee1-6c53-4311-bfb7-3f91964b06b7 (critical, 'unknown', opened
-- 2026-10-03 19:35:02 UTC): DR0:health_critical from fn_ca_diamond_health_watch,
-- "Trial balance is incomplete: require one known comparison for each of the
-- five reconciling accounts" (ca_diamond_incidents 874553).
--
-- WHAT HAPPENED, read on production 2026-10-03 21:59 UTC:
--   * ca-diamond-snapshot-hourly (job 201, minute 10) has no run at all at
--     19:10: the database restarted 19:07-19:12. Snapshots exist at 18:10:01
--     and 20:10:00, each with unexplained = 0.
--   * fn_ca_diamond_trial_balance() measures from the first snapshot at or
--     after now() - 75 minutes. At 19:35 that was 18:20 and the newest
--     snapshot was 18:10, so s0 was NULL and player_diamonds,
--     fixture_accounts, diamond_house and total all returned difference NULL.
--     fn_ca_diamond_health read that as 'unknown', the watch counts unknown as
--     bad and filed DR0 at 'critical', and fn_ca_diamond_incident_pages turned
--     it into a critical drift incident.
--   * Not a timeout, not stats, not an unlogged table, not a ledger gap.
--     fn_ca_diamond_trial_balance('2026-10-03 18:09') - one comparison from the
--     18:10 snapshot across the whole gap to 21:59 - reads difference 0.00 on
--     player_diamonds (moved 4260, register 4260), fixture_accounts (4315 /
--     4315), diamond_house (0 / 0), register (0.00) and total (0.00). The 21:35
--     health reading: trial balance ok, money identity ok, deploy gate 0
--     unexplained; the watch auto-resolved its DR0 row at 21:35.
--
-- WHAT CHANGES:
--   1. fn_ca_diamond_health: the trial balance reaches back to the newest
--      stored snapshot when that is older than 75 minutes (LEAST of the old
--      default and max(taken_at)); with a fresh snapshot the argument equals
--      the old default. A missed hourly snapshot now yields a known
--      comparison over a longer window, a real break still reads critical,
--      and no snapshot at all still reads unknown.
--   2. fn_ca_diamond_health_watch: an area that reads 'critical' files
--      critical at once, as before. An area that reads 'unknown' on this tick
--      but not on the previous reading (at most three hours old) files at
--      'warning' - recorded, auto-resolved when the area clears, not paged.
--      The next hourly tick is the retry: still unknown there files critical,
--      so a persistent inability to tell still pages.
--
-- HOW. Exact substitution through a pg_temp helper (as in 20261003025434):
-- pinned preimages, each anchor exactly once, derived postimages computed
-- read-only on production, owner/security/settings/grants unmoved. Neither
-- function is on fn_ca_guard_watchlist(). No schedule, grant, index or
-- table changes.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_diamond_health()'::regprocedure)) = '64b94d13476dd74cf8573de193cc14e2' AND md5(pg_get_functiondef('public.fn_ca_diamond_health_watch()'::regprocedure)) = 'e5101ef5acb368d1ff88bbf7a0b67cf1')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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


SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_health()',
  '3ed2ac4e441befea2072b3c3e941b37e', '64b94d13476dd74cf8573de193cc14e2',
  ARRAY[$o$      FROM public.fn_ca_diamond_trial_balance() x;
$o$],
  ARRAY[$n$      /* A MISSED SNAPSHOT IS NOT AN UNKNOWN BALANCE (2026-10-03). The trial
         balance measures every account from the first stored snapshot inside
         its 75-minute window. When the hourly snapshot did not run (the
         database restarted 19:07-19:12 UTC on 2026-10-03, so the 19:10
         snapshot never fired), there was no snapshot in the window and all
         four movement comparisons came back NULL: "incomplete", which the
         watch filed as a critical DR0. A comparison WAS available - from the
         newest stored snapshot (18:10) - and read 0 on every account. So the
         window now reaches back to the newest stored snapshot when that is
         older than 75 minutes; with a fresh snapshot the argument is the old
         default exactly. A real break still reads critical; no snapshot at
         all still reads unknown; a stale series is the deploy gate's
         'attention' above. */
      FROM public.fn_ca_diamond_trial_balance(
             LEAST(now() - interval '75 minutes',
                   COALESCE((SELECT max(s.taken_at) FROM public.ca_diamond_snapshots s),
                            now() - interval '75 minutes'))) x;
$n$]);

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_health_watch()',
  '382513c497c4b8d1defe2581d5840bd5', 'e5101ef5acb368d1ff88bbf7a0b67cf1',
  ARRAY[$o$DECLARE v_bad integer; v_detail jsonb; v_read integer; v_bad_areas text[]; v_statuses jsonb; v_resolved integer; v_areas jsonb;
$o$, $o$  -- DIAMOND PHASE 10: the whole reading is kept for the staff desk, which may
$o$, $o$    PERFORM public.fn_ca_diamond_incident(
      'DR0:health_critical', 'critical', NULL, NULL, 'fn_ca_diamond_health_watch',
      jsonb_build_object('areas', v_bad, 'detail', v_detail));
$o$],
  ARRAY[$n$DECLARE v_bad integer; v_detail jsonb; v_read integer; v_bad_areas text[]; v_statuses jsonb; v_resolved integer; v_areas jsonb;
        v_prev jsonb; v_persistent integer;
$n$, $n$  /* A FIRST 'COULD NOT TELL' IS RETRIED, NOT PAGED (2026-10-03). The previous
     reading (kept below, at most three hours old) is read before it is
     replaced. An area that reads 'critical' is a finding and files critical
     at once, exactly as before. An area that reads 'unknown' this tick but
     did not read unknown or critical on the previous reading is a first
     inability to tell - a restart, a missed snapshot, a read that failed -
     and files at warning: recorded, visible, auto-resolved when the area
     clears, and not paged. The next hourly tick is the retry: the same area
     still unknown then files critical, so an inability that persists still
     pages. Incident f991dee1 (2026-10-03 19:35) was a single unknown tick
     after the 19:07-19:12 restart; the books read 0 on every account. */
  SELECT r.areas INTO v_prev
    FROM public.ca_diamond_health_reading r
   WHERE r.id = 1 AND r.read_at > now() - interval '3 hours';
  SELECT count(*) INTO v_persistent
    FROM jsonb_array_elements(v_detail) d
   WHERE d->>'status' = 'critical'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_prev, '[]'::jsonb)) p
                  WHERE p->>'area' = d->>'area' AND p->>'status' IN ('unknown', 'critical'));

  -- DIAMOND PHASE 10: the whole reading is kept for the staff desk, which may
$n$, $n$    PERFORM public.fn_ca_diamond_incident(
      'DR0:health_critical', CASE WHEN v_persistent > 0 THEN 'critical' ELSE 'warning' END,
      NULL, NULL, 'fn_ca_diamond_health_watch',
      jsonb_build_object('areas', v_bad, 'detail', v_detail,
                         'first_unknown_retried_next_tick', v_persistent = 0));
$n$]);

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
