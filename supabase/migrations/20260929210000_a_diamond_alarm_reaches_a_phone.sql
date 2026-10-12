-- ============================================================================
-- A DIAMOND ALARM REACHES A PHONE
-- ============================================================================
--
-- Phase 10 of the Diamond Arena programme, line 5 ("Integrate financial push
-- alerts and reconciliation without arena-wide automatic lockout"), item 2 of
-- the ordered build list in docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md.
--
-- Before this migration a critical Diamond incident paged nobody. The Diamond
-- incident store, ca_diamond_incidents, had no trigger, and none of the
-- functions that write it reached the chip estate's pipe (ca_drift_incidents,
-- the recipient registry, the notify ledger, the push). The one Diamond
-- finding that did use the pipe, the supply snapshot's unexplained movement,
-- was recorded and worded in chips, because fn_ca_raise_drift_incident knew
-- no currency.
--
-- What changes:
--
--   1. fn_ca_raise_drift_incident records a currency. A finding whose
--      metadata says asset = diamonds (the tag the engine's DiamondCustody
--      alerts already carry, and the two Diamond callers below) is recorded
--      in diamonds, and its alert and headline say Diamonds. Every other
--      finding is filed in chips, word for word as before. The signature does
--      not change, so no caller changes.
--   2. fn_ca_incident_notify prints Diamonds for a Diamond incident, and a
--      critical from a Diamond rule pages even when the row carries no
--      amount: the rule has already judged it critical, which is the reason a
--      liveness finding is let through. Dan's other gates of 2026-09-06 (a fix
--      is not a page; below critical is not a page) are unchanged.
--   3. fn_ca_diamond_snapshot tags its supply incident asset = diamonds.
--   4. fn_ca_incident_dashboard shows a Diamond incident to platform staff and
--      to the recipients a Diamond incident has, never to a club or union
--      owner as such.
--   5. A critical row in ca_diamond_incidents raises one drift incident per
--      rule (trigger ca_diamond_incident_critical_pages). Its dedupe key is
--      diamond-rule:<rule>:<episode>. While the incident is open every new
--      critical row of the rule folds into it, so a condition re-filed every
--      hour pages once. The episode is one more than the rule's incidents
--      already closed, so once a person closes it, or the rule has been silent
--      for 24 hours (the detector registry's aging floor), the next critical
--      row opens a new finding and pages again. A key stable for the life of
--      the rule would page once in its life: the notify ledger remembers every
--      finding it has paged and never learns that one was closed. Warnings and
--      info rows do not fire the trigger.
--   6. The eight supply incidents already on the board are recorded in
--      diamonds, which is what they always were.
--
-- Nothing here writes ca_arena_settings. Both switches stay false, and the
-- final block proves that no function in any schema writes them. Nothing is
-- priced. Applied once to kuklfnapbkmacvwxktbh.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_raise_drift_incident     a6df5f2eef07aa3f606db79d93944590
--   fn_ca_incident_notify          ad9a51b31ec9d8f52a416e5e77a033a2
--   fn_ca_diamond_snapshot         95b4c77768db15b19a088c5642ad47c8
--   fn_ca_incident_dashboard       bc12882b4aaa9c4a96e1192de6a92d48
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open; this migration expects both closed and never moves them';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. A FINDING RECORDS ITS CURRENCY
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_new text; v_back text; v_n integer; i integer;
  v_old text[]; v_rep text[];
BEGIN
  v_oid := 'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'a6df5f2eef07aa3f606db79d93944590' THEN
    RAISE EXCEPTION 'fn_ca_raise_drift_incident is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := ARRAY[
$o$  v_stable text;
$o$,
$o$    ledger_balanced, suspected_cause, metadata)
$o$,
$o$    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb))
$o$,
$o$      v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips',
$o$,
$o$      to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class,
$o$];
  v_rep := ARRAY[
$n$  v_stable text;
  /* A FINDING RECORDS ITS CURRENCY (2026-09-29, Diamond Phase 10). A finding
     whose metadata says asset = diamonds is recorded in diamonds, and its
     alert and headline say Diamonds: the engine's DiamondCustody alerts
     (their context already carries the tag), the Diamond supply snapshot and
     the Diamond rule trigger. Every other finding is filed in chips, word for
     word as before. The headline names the rule when there is one, else the
     detector, and the Diamonds in doubt when there are any. */
  v_currency text := CASE WHEN lower(COALESCE(p_metadata->>'asset', '')) = 'diamonds'
                          THEN 'diamonds' ELSE 'club_chips' END;
  v_diamond_headline text := COALESCE('Diamond rule ' || (p_metadata->>'rule'), p_source)
    || CASE WHEN COALESCE(p_discrepancy, 0) <> 0
            THEN ': ' || to_char(p_discrepancy, 'FM999999999990') || ' Diamonds in doubt'
            ELSE ' is ' || v_sev END;
$n$,
$n$    ledger_balanced, suspected_cause, metadata, currency)
$n$,
$n$    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb), v_currency)
$n$,
$n$      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           ELSE v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips' END,
$n$,
$n$      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           ELSE to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class END,
$n$];
  v_new := v_def;
  FOR i IN 1 .. array_length(v_old, 1) LOOP
    v_n := (length(v_def) - length(replace(v_def, v_old[i], ''))) / length(v_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_ca_raise_drift_incident: clause % occurs % times, expected 1', i, v_n;
    END IF;
    v_new := replace(v_new, v_old[i], v_rep[i]);
  END LOOP;
  EXECUTE v_new;
  v_back := pg_get_functiondef(v_oid);
  FOR i IN REVERSE array_length(v_old, 1) .. 1 LOOP
    v_back := replace(v_back, v_rep[i], v_old[i]);
  END LOOP;
  IF md5(v_back) <> 'a6df5f2eef07aa3f606db79d93944590' THEN
    RAISE EXCEPTION 'fn_ca_raise_drift_incident: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident', 'migration a_diamond_alarm_reaches_a_phone');

-- ---------------------------------------------------------------------------
-- 2. THE PAGE SAYS DIAMONDS, AND A DIAMOND RULE'S CRITICAL GETS THROUGH
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_new text; v_back text; v_n integer; i integer;
  v_old text[]; v_rep text[];
BEGIN
  v_oid := 'public.fn_ca_incident_notify(uuid,text,text,boolean)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'ad9a51b31ec9d8f52a416e5e77a033a2' THEN
    RAISE EXCEPTION 'fn_ca_incident_notify is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := ARRAY[
$o$  v_is_liveness boolean;
$o$,
$o$  v_is_liveness := COALESCE(inc.source, '') = ANY (v_liveness);
$o$,
$o$  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND NOT v_is_liveness THEN
$o$,
$o$  IF v_is_liveness AND COALESCE(inc.discrepancy_amount, 0) = 0 THEN
$o$,
$o$      '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
      upper(inc.severity), inc.classification,
      to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
$o$];
  v_rep := ARRAY[
$n$  v_is_liveness boolean;
  v_is_diamond_rule boolean;
$n$,
$n$  v_is_liveness := COALESCE(inc.source, '') = ANY (v_liveness);
  /* A DIAMOND RULE'S CRITICAL IS ITS OWN JUDGEMENT (2026-09-29, Diamond
     Phase 10). The Diamond rule trigger files one incident per rule under
     this source. A rule row often carries no amount (DR0:health_critical names
     an area, not a sum), and the money gate below would mute every one of
     them, so, like a liveness finding, the source is named here and let
     through. Dan's other gates are unchanged: a fix is not a page, and below
     critical is not a page. */
  v_is_diamond_rule := COALESCE(inc.source, '') = 'ca_diamond_incidents';
$n$,
$n$  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND NOT v_is_liveness AND NOT v_is_diamond_rule THEN
$n$,
$n$  IF v_is_diamond_rule THEN
    /* Say which rule, what it found and how many Diamonds are in doubt. */
    body := format(
      '%s | %s%s. Age %smin, reconcile target %s.',
      upper(inc.severity),
      CASE WHEN COALESCE(inc.discrepancy_amount, 0) <> 0
           THEN to_char(inc.discrepancy_amount, 'FM999999999990') || ' Diamonds in doubt. '
           ELSE '' END,
      rtrim(COALESCE(inc.suspected_cause, inc.source), '. '),
      age_min, to_char(inc.deadline_at, 'HH24:MI UTC'));
  ELSIF v_is_liveness AND COALESCE(inc.discrepancy_amount, 0) = 0 THEN
$n$,
$n$      '%s | %s drift %s %s (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
      upper(inc.severity), inc.classification,
      to_char(COALESCE(inc.discrepancy_amount,0), CASE WHEN inc.currency = 'diamonds' THEN 'FM999999999990' ELSE 'FM999999999990.00' END),
      CASE WHEN inc.currency = 'diamonds' THEN 'Diamonds' ELSE 'chips' END,
$n$];
  v_new := v_def;
  FOR i IN 1 .. array_length(v_old, 1) LOOP
    v_n := (length(v_def) - length(replace(v_def, v_old[i], ''))) / length(v_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_ca_incident_notify: clause % occurs % times, expected 1', i, v_n;
    END IF;
    v_new := replace(v_new, v_old[i], v_rep[i]);
  END LOOP;
  EXECUTE v_new;
  v_back := pg_get_functiondef(v_oid);
  FOR i IN REVERSE array_length(v_old, 1) .. 1 LOOP
    v_back := replace(v_back, v_rep[i], v_old[i]);
  END LOOP;
  IF md5(v_back) <> 'ad9a51b31ec9d8f52a416e5e77a033a2' THEN
    RAISE EXCEPTION 'fn_ca_incident_notify: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_incident_notify', 'migration a_diamond_alarm_reaches_a_phone');

-- ---------------------------------------------------------------------------
-- 3. THE SUPPLY SNAPSHOT'S INCIDENT IS A DIAMOND INCIDENT
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := 'public.fn_ca_diamond_snapshot()'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '95b4c77768db15b19a088c5642ad47c8' THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := $o$      false, jsonb_build_object('profile_diamonds', v_prof, 'fixture_diamonds', v_fix, 'register_supply', v_reg,
$o$;
  v_new := $n$      -- Diamond Phase 10: tagged, so it is recorded and worded in Diamonds.
      false, jsonb_build_object('asset', 'diamonds', 'profile_diamonds', v_prof, 'fixture_diamonds', v_fix, 'register_supply', v_reg,
$n$;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot: the incident metadata occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '95b4c77768db15b19a088c5642ad47c8' THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot', 'migration a_diamond_alarm_reaches_a_phone');

-- ---------------------------------------------------------------------------
-- 4. THE BOARD SHOWS A DIAMOND INCIDENT TO STAFF AND ITS RECIPIENTS ONLY
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_new text; v_back text; v_n integer; i integer;
  v_old text[]; v_rep text[];
BEGIN
  v_oid := 'public.fn_ca_incident_dashboard(text,integer)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'bc12882b4aaa9c4a96e1192de6a92d48' THEN
    RAISE EXCEPTION 'fn_ca_incident_dashboard is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := ARRAY[
$o$  v_mgmt boolean;
$o$,
$o$    IF NOT v_mgmt THEN RETURN; END IF;
$o$,
$o$  WHERE p_status IS NULL OR i.status = p_status
$o$];
  v_rep := ARRAY[
$n$  v_mgmt boolean;
  v_diamonds boolean := true;
$n$,
$n$    IF NOT v_mgmt THEN RETURN; END IF;
    /* A DIAMOND INCIDENT IS SHOWN TO PLATFORM STAFF AND ITS RECIPIENTS ONLY
       (2026-09-29, Diamond Phase 10). The gate above also admits every club
       owner and union owner, which is right for a chip incident and wrong for
       a Diamond one: the Diamond Arena has no club or union management. The
       recipients are the scopes fn_ca_incident_recipient_ids gives an
       incident with no club and no union, which every Diamond incident is. */
    v_diamonds := public.fn_is_platform_admin()
      OR EXISTS (SELECT 1 FROM public.ca_incident_recipients r
                  WHERE r.user_id = v_uid AND r.active
                    AND r.scope IN ('platform','financial_ops','technical'));
$n$,
$n$  WHERE (p_status IS NULL OR i.status = p_status)
    AND (v_diamonds OR i.currency IS DISTINCT FROM 'diamonds')
$n$];
  v_new := v_def;
  FOR i IN 1 .. array_length(v_old, 1) LOOP
    v_n := (length(v_def) - length(replace(v_def, v_old[i], ''))) / length(v_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fn_ca_incident_dashboard: clause % occurs % times, expected 1', i, v_n;
    END IF;
    v_new := replace(v_new, v_old[i], v_rep[i]);
  END LOOP;
  EXECUTE v_new;
  v_back := pg_get_functiondef(v_oid);
  FOR i IN REVERSE array_length(v_old, 1) .. 1 LOOP
    v_back := replace(v_back, v_rep[i], v_old[i]);
  END LOOP;
  IF md5(v_back) <> 'bc12882b4aaa9c4a96e1192de6a92d48' THEN
    RAISE EXCEPTION 'fn_ca_incident_dashboard: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 5. A CRITICAL DIAMOND ROW RAISES ONE DRIFT INCIDENT PER RULE
-- ---------------------------------------------------------------------------
-- One source for every Diamond rule, owned like the supply snapshot. The
-- aging window is the registry's floor (24 hours): a rule that has filed no
-- critical row for a day is closed as aged out, not verified, so its next
-- critical row pages again instead of folding into a finding nobody is
-- looking at.
INSERT INTO public.ca_detector_registry (source, owner, sla_hours, auto_resolve_hours, note)
VALUES ('ca_diamond_incidents', 'diamond programme', 24, 24,
        'Critical rows of ca_diamond_incidents, one drift incident per rule episode (trigger ca_diamond_incident_critical_pages, migration a_diamond_alarm_reaches_a_phone). The aging window is the registry floor: a rule silent for a day closes as aged out, not verified, and its next critical row pages again.')
ON CONFLICT (source) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_incident_pages()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_episode bigint;
  v_found   text;
  v_state   text;
  v_msg     text;
BEGIN
  /* A CRITICAL DIAMOND ROW REACHES A PHONE (2026-09-29, Diamond Phase 10).
     Fired only for a critical row (the trigger's WHEN clause), after the row
     is written and inside the writer's own transaction, so a writer that
     rolls back takes its page with it.

     One drift incident per rule and episode, filed through the estate's own
     door, so the recipient registry, the notify ledger, the escalation tick
     and the push carry it exactly as they carry a chip finding. The key is
     diamond-rule:<rule>:<episode>. While the rule's incident is open, every
     new critical row of the rule has the same key and folds into it
     (occurrences, last_seen_at, a recurred event), so a condition the health
     watch re-files every hour pages once. The episode is one more than the
     rule's incidents already closed: after a person closes it, or the
     escalation tick ages it out, the next critical row is a new finding and
     pages again. A key stable for the life of the rule would page once in
     its life, because the notify ledger remembers every finding it has paged
     and never learns that one was closed. Two writers filing a rule's first
     row at once compute the same key and meet at the open-incident unique
     index, so they page once between them.

     The amount in doubt is the row's amount. The incident names no club,
     union, table or event, so it is a platform finding and the Midway scope
     keeps it. The row's own detail is nested in the metadata, never merged,
     for the same reason.

     Paging must never cost the row it pages for: every failure is recorded
     in ca_incident_file_failures and swallowed. */
  SELECT count(*) + 1 INTO v_episode
    FROM public.ca_drift_incidents d
   WHERE d.source = 'ca_diamond_incidents'
     AND d.status = 'resolved'
     AND d.metadata->>'rule' = NEW.rule;

  v_found := COALESCE(
    (SELECT string_agg(COALESCE(a->>'area', '?') || ': ' || COALESCE(a->>'detail', a::text), '; ')
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.detail->'detail') = 'array'
                                      THEN NEW.detail->'detail' ELSE '[]'::jsonb END) a),
    NULLIF(NEW.detail->>'note', ''),
    NULLIF(NEW.detail::text, '{}'),
    'no detail recorded');

  PERFORM public.fn_ca_raise_drift_incident(
    p_source          => 'ca_diamond_incidents',
    p_classification  => 'unknown',
    p_severity        => NEW.severity,
    p_dedupe_key      => 'diamond-rule:' || NEW.rule || ':' || v_episode::text,
    p_discrepancy     => NEW.amount,
    p_layer           => 'ledger',
    p_entity_type     => 'ca_diamond_incidents',
    p_suspected_cause => left('Diamond rule ' || NEW.rule || ' ('
                              || COALESCE(NEW.writer, 'unknown writer') || '): ' || v_found, 300),
    p_metadata        => jsonb_build_object(
                           'asset', 'diamonds',
                           'rule', NEW.rule,
                           'diamond_incident_id', NEW.id,
                           'writer', NEW.writer,
                           'user_id', NEW.user_id,
                           'occurred_at', NEW.occurred_at,
                           'detail', NEW.detail));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('ca_diamond_incidents', 'diamond-rule:' || COALESCE(NEW.rule, '?'), 'unknown',
            NEW.severity, NEW.amount, v_state,
            'a critical Diamond incident (ca_diamond_incidents ' || NEW.id || ') was not paged: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RAISE WARNING 'fn_ca_diamond_incident_pages(%) failed: %', NEW.rule, v_msg;
  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_incident_pages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_incident_pages() TO service_role;

CREATE TRIGGER ca_diamond_incident_critical_pages
  AFTER INSERT ON public.ca_diamond_incidents
  FOR EACH ROW WHEN (NEW.severity = 'critical')
  EXECUTE FUNCTION public.fn_ca_diamond_incident_pages();

-- ---------------------------------------------------------------------------
-- 6. THE SUPPLY INCIDENTS ALREADY FILED WERE ALWAYS DIAMONDS
-- ---------------------------------------------------------------------------
UPDATE public.ca_drift_incidents
   SET currency = 'diamonds'
 WHERE source = 'fn_ca_diamond_snapshot'
   AND currency IS DISTINCT FROM 'diamonds';

-- ---------------------------------------------------------------------------
-- 7. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_txt text; v_bad text; r record;
BEGIN
  -- the raise records a currency and words a Diamond finding in Diamonds
  v_txt := pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure);
  IF position($q$v_currency text := CASE WHEN lower(COALESCE(p_metadata->>'asset', '')) = 'diamonds'$q$ IN v_txt) = 0
     OR position('ledger_balanced, suspected_cause, metadata, currency)' IN v_txt) = 0
     OR position($q$COALESCE(p_metadata,'{}'::jsonb), v_currency)$q$ IN v_txt) = 0
     OR (length(v_txt) - length(replace(v_txt, $q$CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline$q$, '')))
        / length($q$CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline$q$) <> 2 THEN
    RAISE EXCEPTION 'the raise does not record and word a Diamond finding as this migration states';
  END IF;
  -- the page says Diamonds, lets a Diamond rule's critical through, and keeps Dan's other gates
  v_txt := pg_get_functiondef('public.fn_ca_incident_notify(uuid,text,text,boolean)'::regprocedure);
  IF position($q$v_is_diamond_rule := COALESCE(inc.source, '') = 'ca_diamond_incidents';$q$ IN v_txt) = 0
     OR position('= 0 AND NOT v_is_liveness AND NOT v_is_diamond_rule THEN' IN v_txt) = 0
     OR position($q$' Diamonds in doubt. '$q$ IN v_txt) = 0
     OR position($q$CASE WHEN inc.currency = 'diamonds' THEN 'Diamonds' ELSE 'chips' END$q$ IN v_txt) = 0
     OR position($q$v_withheld := 'a fix is not a page';$q$ IN v_txt) = 0
     OR position($q$v_withheld := 'severity ' || COALESCE(inc.severity,'null') || ' is not critical';$q$ IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the page does not treat a Diamond incident as this migration states';
  END IF;
  -- the supply snapshot tags its incident
  IF position($q$jsonb_build_object('asset', 'diamonds', 'profile_diamonds', v_prof$q$
              IN pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the supply snapshot does not tag its incident as Diamonds';
  END IF;
  -- the board keeps a Diamond incident to staff and its recipients
  IF position($q$AND (v_diamonds OR i.currency IS DISTINCT FROM 'diamonds')$q$
              IN pg_get_functiondef('public.fn_ca_incident_dashboard(text,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the board does not keep a Diamond incident to staff and its recipients';
  END IF;
  -- the trigger: after insert, per row, critical only, enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.ca_diamond_incidents'::regclass
       AND t.tgname = 'ca_diamond_incident_critical_pages'
       AND t.tgfoid = 'public.fn_ca_diamond_incident_pages()'::regprocedure
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT ON public.ca_diamond_incidents FOR EACH ROW WHEN ((new.severity = ''critical''::text))%') THEN
    RAISE EXCEPTION 'the critical Diamond incident trigger is not installed as this migration states';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_detector_registry
                  WHERE source = 'ca_diamond_incidents' AND owner = 'diamond programme'
                    AND status = 'active' AND auto_resolve_hours = 24) THEN
    RAISE EXCEPTION 'the Diamond incident source is not registered to the diamond programme';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents
              WHERE source = 'fn_ca_diamond_snapshot' AND currency IS DISTINCT FROM 'diamonds') THEN
    RAISE EXCEPTION 'a supply snapshot incident is still recorded in chips';
  END IF;
  -- grants: none of these is reachable without an account; only the board is a browser door
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_diamond_snapshot',
                                'fn_ca_incident_dashboard','fn_ca_diamond_incident_pages')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF r.proname <> 'fn_ca_incident_dashboard' AND has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is a browser door', r.proname;
    END IF;
  END LOOP;
  -- only a person moves the switches: both are closed, and no function in any schema writes them
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosrc ~* '(update|insert\s+into|merge\s+into|delete\s+from)\s+(only\s+)?(public\.)?ca_arena_settings'
      OR p.prosrc ~* 'new\s*\.\s*(cash_games_enabled|tournaments_enabled)\s*:=';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a function writes the arena settings, which only a person may change: %', v_bad;
  END IF;
  -- the identity is whole, every watched guard is on its baseline
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond alarm reaches a phone: a critical Diamond row pages once per rule and episode, in Diamonds, to the registry; no switch moved';
END $m$;
