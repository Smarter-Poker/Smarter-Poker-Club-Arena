-- 20260921171311_a_platform_that_is_not_dealing_is_worth_waking_someone
--
-- Applied to production as version 20260912110448 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- RECORDED AFTER THE FACT. Applied straight to production on 2026-09-12 and
-- never written into the repository. The definition below was read back out of
-- the live catalog with pg_get_functiondef on 2026-09-21 and is reproduced
-- byte for byte. This file changes the REPOSITORY, not the database.
--
-- ===========================================================================
-- WHAT DRIFTED, AND WHAT A REBUILD WOULD HAVE DONE
--
-- The repository's newest fn_ca_incident_notify is 20260906132947, and it has
-- no v_liveness array. The live one does:
--
--   v_liveness CONSTANT text[] := ARRAY[
--     'fn_ca_conservation_sweep:fn_ca_orphaned_running_tournaments',
--     'fn_ca_conservation_sweep:fn_ca_tables_that_cannot_deal',
--     'fn_ca_conservation_sweep:fn_ca_knockout_door_stalled',
--     'fn_ca_conservation_sweep:fn_ca_stranded_completing_tournaments',
--     'fn_ca_conservation_sweep:fn_ca_rake_rollup_writer_silent',
--     'fn_ca_conservation_sweep:fn_ca_absent_tournament_players'
--   ];
--
-- That array is what allows a liveness finding past the notification gates
-- Dan set on 2026-09-06. Rebuilt from main, the detectors recorded in
-- a_silence_is_a_failure_the_board_can_see would still run, still find, and
-- still file - and the page would be withheld. A platform that is not dealing
-- would once again fail quietly, which is the exact condition both of these
-- migrations were written on the day of.
--
-- ===========================================================================
-- WHAT THIS CHANGES IN PRODUCTION
--
-- Nothing. One CREATE OR REPLACE whose text equals the live text, one COMMENT
-- ON whose text equals the live comment, and grants that restate the ACL
-- production already has. The pre-image guard refuses the file if the live
-- body differs; the post-image assertion proves the result.
--
-- @live-proof: (SELECT position('v_liveness' in pg_get_functiondef(to_regprocedure('public.fn_ca_incident_notify(uuid,text,text,boolean)'))) > 0)
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';


DO $preimage$
/* ---------------------------------------------------------------------------
   PRE-IMAGE GUARD.

   This file DECLARES a definition that production already holds. There are
   exactly two trees it may legitimately meet:

     1. PRODUCTION, where the function exists and its body is byte-for-byte the
        one recorded below. Re-declaring it is then a no-op.
     2. A FRESH REBUILD, where the function does not exist yet and this file is
        the thing that creates it.

   Any third tree - the function exists with a DIFFERENT body - means somebody
   changed it after this record was read, and replaying the older text would
   silently revert their change. That is the one outcome a reconciliation must
   never produce, so it refuses instead.
   --------------------------------------------------------------------------- */
DECLARE
  e record;
  v_oid oid;
  v_live text;
BEGIN
  FOR e IN
    SELECT * FROM (VALUES
      ('public.fn_ca_incident_notify(uuid,text,text,boolean)', '2d30af7396a481741f4067202de48658', 'v', 'search_path=public')
    ) v(sig, want_md5, want_vol, want_cfg)
  LOOP
    v_oid := to_regprocedure(e.sig);

    IF v_oid IS NULL THEN
      RAISE NOTICE 'pre-image: % is absent - this tree is a fresh build and this file creates it', e.sig;
      CONTINUE;
    END IF;

    SELECT md5(p.prosrc) INTO v_live FROM pg_proc p WHERE p.oid = v_oid;

    IF v_live IS DISTINCT FROM e.want_md5 THEN
      RAISE EXCEPTION
        'PRE-IMAGE REFUSED: % has body md5 % in this database, but this file records %. '
        'It was changed after this record was read. Re-read the live definition and '
        'record that instead - do not let a reconciliation overwrite a real change.',
        e.sig, v_live, e.want_md5;
    END IF;
  END LOOP;

  RAISE NOTICE 'pre-image: every function this file records is absent or already byte-identical';
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_ca_incident_notify(p_incident_id uuid, p_kind text, p_headline text, p_senior_only boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inc  public.ca_drift_incidents;
  rec  uuid;
  n    int := 0;
  club_name  text;
  union_name text;
  body text;
  age_min int;
  v_finding text;
  v_state   text;
  v_kind    text;
  v_fresh   boolean;
  v_withheld text := NULL;
  v_findings numeric;
  /* A LIVENESS FINDING CARRIES NO CHIP AMOUNT AND STILL MATTERS (2026-09-12).
     These detectors answer "is the platform dealing", not "do the chips add
     up", so their discrepancy is always 0.00 and the money gate below would
     mute every one of them. On 2026-09-12 the engine dealt zero tournament
     hands for five hours and every detector that could have said so would have
     been filed and muted here. Measured before changing it: 1,041 pushes were
     withheld on that gate in seven days and exactly 10 were liveness findings,
     so relaxing it generally would have sent a thousand pages a week. Named
     explicitly so a future detector has to ask to be on this list, and so the
     rule that decides who gets woken is readable in one glance. */
  v_liveness CONSTANT text[] := ARRAY[
    'fn_ca_conservation_sweep:fn_ca_orphaned_running_tournaments',
    'fn_ca_conservation_sweep:fn_ca_tables_that_cannot_deal',
    'fn_ca_conservation_sweep:fn_ca_knockout_door_stalled',
    'fn_ca_conservation_sweep:fn_ca_stranded_completing_tournaments',
    'fn_ca_conservation_sweep:fn_ca_rake_rollup_writer_silent',
    'fn_ca_conservation_sweep:fn_ca_absent_tournament_players'
  ];
  v_is_liveness boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_kind := CASE
              WHEN p_kind = 'escalated'    THEN 'escalated'
              WHEN inc.status = 'resolved' THEN 'resolved'
              ELSE 'raised'
            END;

  v_is_liveness := COALESCE(inc.source, '') = ANY (v_liveness);
  v_findings := COALESCE(
      NULLIF(inc.metadata->>'row_count','')::numeric,
      jsonb_array_length(COALESCE(inc.metadata->'rows','[]'::jsonb))::numeric,
      0);

  /* DAN'S RULE, 2026-09-06. Three gates, on the PUSH only. The incident is
     still filed, the event row is still written, the board still shows
     everything - what changes is whose night it interrupts.

     Order matters: 'resolved' is checked first because a fix is the case he
     named explicitly, and it would otherwise slip through on a critical. */
  IF v_kind = 'resolved' THEN
    v_withheld := 'a fix is not a page';
  ELSIF lower(COALESCE(inc.severity,'')) <> 'critical' THEN
    v_withheld := 'severity ' || COALESCE(inc.severity,'null') || ' is not critical';
  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND NOT v_is_liveness THEN
    v_withheld := 'nothing is unaccounted for (0.00)';
  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND v_is_liveness AND v_findings = 0 THEN
    /* A liveness detector that found nothing is the healthy case and is not a
       page either. Only a detector that actually found something gets through. */
    v_withheld := 'the check is live and found nothing';
  END IF;

  IF v_withheld IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (inc.id, 'notify_withheld',
            jsonb_build_object('reason', v_withheld, 'kind', v_kind,
                               'severity', inc.severity,
                               'discrepancy', inc.discrepancy_amount,
                               'headline', left(p_headline, 110),
                               'rule', 'Dan 2026-09-06: only critical errors that need my attention'));
    RETURN 0;
  END IF;

  SELECT name INTO club_name  FROM public.clubs  WHERE id = inc.club_id;
  SELECT name INTO union_name FROM public.unions WHERE id = inc.union_id;
  age_min := GREATEST(0, floor(extract(epoch FROM now() - inc.detected_at) / 60))::int;

  IF v_is_liveness AND COALESCE(inc.discrepancy_amount, 0) = 0 THEN
    /* Say what was actually found. "drift 0.00 chips" reads as a rounding
       error, and an alert that reads like a rounding error gets ignored. */
    body := format(
      '%s | %s: %s finding(s) on the %s layer. %s%sAge %smin, reconcile target %s.',
      upper(inc.severity), inc.entity_type,
      to_char(v_findings, 'FM999999999990'),
      inc.layer,
      COALESCE('Club ' || club_name || '. ', ''),
      COALESCE('Union ' || union_name || '. ', ''),
      age_min, to_char(inc.deadline_at, 'HH24:MI UTC'));
  ELSE
    body := format(
      '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
      upper(inc.severity), inc.classification,
      to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
      inc.layer,
      COALESCE(to_char(inc.expected_amount,'FM999999999990.00'),'?'),
      COALESCE(to_char(inc.actual_amount,'FM999999999990.00'),'?'),
      COALESCE('Club ' || club_name || '. ', ''),
      COALESCE('Union ' || union_name || '. ', ''),
      age_min, to_char(inc.deadline_at, 'HH24:MI UTC'), inc.auto_repair_status);
  END IF;

  v_finding := public.fn_ca_finding_key(inc.dedupe_key, inc.classification, inc.layer,
                                        inc.club_id, inc.union_id);
  v_state := md5(
      v_kind
      || '|' || COALESCE(inc.severity,'?')
      || '|' || COALESCE(inc.classification,'?')
      || '|' || COALESCE(inc.layer,'?')
      || '|' || COALESCE(inc.club_id::text,'-')
      || '|' || COALESCE(inc.union_id::text,'-')
      || '|' || CASE WHEN v_kind = 'escalated'
                     THEN COALESCE(inc.escalation_level, 0)::text ELSE '' END);

  FOR rec IN SELECT unnest(public.fn_ca_incident_recipient_ids(inc, p_senior_only))
  LOOP
    BEGIN
      v_fresh := NULL;
      INSERT INTO public.ca_incident_notify_ledger AS l
        (recipient_id, finding_key, state_hash, last_kind, last_incident_id)
      VALUES (rec, v_finding, v_state, v_kind, inc.id)
      ON CONFLICT (recipient_id, finding_key) DO UPDATE
        SET state_hash = EXCLUDED.state_hash, last_kind = EXCLUDED.last_kind,
            last_incident_id = EXCLUDED.last_incident_id, last_sent_at = now(),
            send_count = l.send_count + 1
        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash
      RETURNING true INTO v_fresh;

      IF NOT COALESCE(v_fresh, false) THEN
        INSERT INTO public.ca_incident_events (incident_id, kind, detail)
        VALUES (inc.id, 'notified',
                jsonb_build_object('already_reported', true, 'finding_key', v_finding,
                                   'state', v_kind, 'recipient', rec));
        CONTINUE;
      END IF;

      PERFORM public.fn_raise_notification(
        rec, 'financial_incident', left(p_headline, 110), left(body, 480),
        '/hub/club-arena/financial-incidents?id=' || inc.id::text,
        jsonb_build_object('incident_id', inc.id, 'finding_key', v_finding,
                           'classification', inc.classification, 'severity', inc.severity,
                           'discrepancy', inc.discrepancy_amount, 'club_id', inc.club_id,
                           'union_id', inc.union_id, 'deadline_at', inc.deadline_at));
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'notify_failed',
              jsonb_build_object('recipient', rec, 'error', SQLERRM));
    END;
  END LOOP;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (inc.id, p_kind,
          jsonb_build_object('headline', p_headline, 'recipients', n,
                             'senior_only', p_senior_only, 'age_min', age_min,
                             'finding_key', v_finding, 'state', v_kind));
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_notify failed for %: %', p_incident_id, SQLERRM;
  RETURN 0;
END $function$;

COMMENT ON FUNCTION public.fn_ca_incident_notify(uuid,text,text,boolean) IS
  'The only path from a drift incident to a human. Sends once per (recipient, finding, state) via ca_incident_notify_ledger. Do not add a time window here - two have been tried (10-in-2-minutes, 3-in-5-minutes) and both let every double through by construction.';

REVOKE ALL ON FUNCTION public.fn_ca_incident_notify(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_notify(uuid,text,text,boolean) TO service_role;


-- ===========================================================================
-- THE DECLARATION THE GUARD REGISTRY REQUIRES
--
-- fn_ca_incident_notify is on fn_ca_guard_watchlist(). The law
-- 20260910143032_a_declared_guard_change_is_recorded_not_raised binds every
-- migration that redefines a watched guard to declare it in the SAME
-- transaction, so fn_ca_guard_defs_watch has nothing to open an INFO notice
-- about. The bound installedOmissions pardon in the law's test covers files
-- that are already installed and immutable; a NEW file is a prospective
-- redefinition and declares itself, which is what the law says in terms.
--
-- THIS DECLARATION CANNOT MOVE THE BASELINE, and the assertion below is what
-- makes that a fact rather than a hope. The definition this file installs is
-- byte-identical to the one production already holds, so the hash the
-- declaration records is the hash already stored. Production's baseline today
-- is ad9a51b31ec9d8f52a416e5e77a033a2, declared by
-- 20260921022420_declare_three_installed_guard_redefinitions against this very
-- migration's installed version. The only columns that move are declared_ref
-- and the timestamps, and the reference below carries the whole chain forward
-- rather than overwriting the provenance that was there.
-- ===========================================================================
DO $declare_guard$
DECLARE
  v_before text;
  v_live   text;
  v_after  text;
BEGIN
  IF to_regprocedure('public.fn_ca_declare_guard_redefinition(text,text)') IS NULL
     OR to_regprocedure('public.fn_ca_guard_watchlist()') IS NULL THEN
    -- A fresh rebuild reaches this file before the guard registry exists.
    -- There is no baseline to keep, so there is nothing to declare.
    RAISE NOTICE 'guard registry not present in this tree; nothing to declare';
  ELSIF NOT ('fn_ca_incident_notify' = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE NOTICE 'fn_ca_incident_notify is not on the watchlist in this tree; nothing to declare';
  ELSE
    SELECT g.def_hash INTO v_before
      FROM public.ca_guard_defs g WHERE g.proname = 'fn_ca_incident_notify';

    SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) INTO v_live
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_incident_notify';

    v_after := public.fn_ca_declare_guard_redefinition(
      'fn_ca_incident_notify',
      'migration 20260921171311_a_platform_that_is_not_dealing_is_worth_waking_someone '
        || '(repository record of installed 20260912110448; definition unchanged, '
        || 'omitted declaration previously recorded by '
        || 'migration 20260921022420_declare_three_installed_guard_redefinitions)');

    IF v_after IS DISTINCT FROM v_live THEN
      RAISE EXCEPTION
        'DECLARATION REFUSED: the baseline recorded (%) is not the definition this '
        'file installs (%)', v_after, v_live;
    END IF;

    -- THE WHOLE POINT. A recording migration may not move a guard baseline.
    IF v_before IS NOT NULL AND v_before IS DISTINCT FROM v_after THEN
      RAISE EXCEPTION
        'DECLARATION REFUSED: this file moved the fn_ca_incident_notify baseline from % to %. '
        'A record of what production already holds cannot change what the watcher compares '
        'against; something in this tree is not the definition that was read.',
        v_before, v_after;
    END IF;

    RAISE NOTICE 'guard baseline for fn_ca_incident_notify re-declared unchanged at %', v_after;
  END IF;
END
$declare_guard$;


DO $postimage$
/* ---------------------------------------------------------------------------
   POST-IMAGE ASSERTION.

   Body, owner, SECURITY DEFINER, volatility, search_path and the full ACL -
   asserted per object. The ACL is checked as a SET of grantee:privilege pairs
   rather than a string compare, so entry order cannot make a correct database
   look wrong.

   service_role is stated EXPLICITLY. This database grants it EXECUTE on new
   functions by DEFAULT PRIVILEGE, so a file that revokes only PUBLIC, anon and
   authenticated ends up with a grant it never declared, and an assertion that
   did not expect it would refuse a correct tree.
   --------------------------------------------------------------------------- */
DECLARE
  e record;
  v_oid oid;
  v_md5 text; v_owner text; v_secdef boolean; v_vol "char"; v_cfg text; v_acl text;
BEGIN
  FOR e IN
    SELECT * FROM (VALUES
      ('public.fn_ca_incident_notify(uuid,text,text,boolean)', '2d30af7396a481741f4067202de48658', 'v', 'search_path=public')
    ) v(sig, want_md5, want_vol, want_cfg)
  LOOP
    v_oid := to_regprocedure(e.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POST-IMAGE: % does not exist after this migration ran', e.sig;
    END IF;

    SELECT md5(p.prosrc), pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile,
           COALESCE(array_to_string(p.proconfig, ', '), '')
      INTO v_md5, v_owner, v_secdef, v_vol, v_cfg
      FROM pg_proc p WHERE p.oid = v_oid;

    IF v_md5 IS DISTINCT FROM e.want_md5 THEN
      RAISE EXCEPTION 'POST-IMAGE: % body md5 is %, expected %', e.sig, v_md5, e.want_md5;
    END IF;
    IF v_owner IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'POST-IMAGE: % is owned by %, expected postgres', e.sig, v_owner;
    END IF;
    IF v_secdef IS NOT TRUE THEN
      RAISE EXCEPTION 'POST-IMAGE: % is not SECURITY DEFINER', e.sig;
    END IF;
    IF v_vol IS DISTINCT FROM e.want_vol THEN
      RAISE EXCEPTION 'POST-IMAGE: % volatility is %, expected %', e.sig, v_vol, e.want_vol;
    END IF;
    IF v_cfg IS DISTINCT FROM e.want_cfg THEN
      RAISE EXCEPTION 'POST-IMAGE: % search_path is [%], expected [%]', e.sig, v_cfg, e.want_cfg;
    END IF;

    SELECT COALESCE(string_agg(g, ',' ORDER BY g), '(no acl)') INTO v_acl
      FROM (
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                    ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS g
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = v_oid
      ) s;
    IF v_acl IS DISTINCT FROM 'postgres:EXECUTE,service_role:EXECUTE' THEN
      RAISE EXCEPTION 'POST-IMAGE: % ACL is [%], expected [%]', e.sig, v_acl, 'postgres:EXECUTE,service_role:EXECUTE';
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-IMAGE: % is reachable by a browser role', e.sig;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- THE ALLOW-LIST IS THE POINT OF THIS FILE.
  ---------------------------------------------------------------------------
  DECLARE v_def text;
  BEGIN
    SELECT pg_get_functiondef(to_regprocedure('public.fn_ca_incident_notify(uuid,text,text,boolean)')) INTO v_def;
    IF position('v_liveness' in v_def) = 0 THEN
      RAISE EXCEPTION 'POST-IMAGE: fn_ca_incident_notify has no v_liveness allow-list';
    END IF;
    FOREACH v_cfg IN ARRAY ARRAY[
      'fn_ca_conservation_sweep:fn_ca_orphaned_running_tournaments',
      'fn_ca_conservation_sweep:fn_ca_tables_that_cannot_deal',
      'fn_ca_conservation_sweep:fn_ca_knockout_door_stalled',
      'fn_ca_conservation_sweep:fn_ca_stranded_completing_tournaments',
      'fn_ca_conservation_sweep:fn_ca_rake_rollup_writer_silent',
      'fn_ca_conservation_sweep:fn_ca_absent_tournament_players'
    ] LOOP
      IF position(v_cfg in v_def) = 0 THEN
        RAISE EXCEPTION 'POST-IMAGE: the liveness allow-list no longer names %', v_cfg;
      END IF;
    END LOOP;
  END;

  RAISE NOTICE 'post-image: every recorded definition matches production byte for byte';
END
$postimage$;

COMMIT;
