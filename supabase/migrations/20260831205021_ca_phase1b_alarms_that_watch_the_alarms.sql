-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:50:21 UTC on kuklfnapbkmacvwxktbh.

-- ═══════════════════════════════════════════════════════════════════════════
-- ROUND-2 BUILD-OUT, PHASE 1 - THE ALARMS THAT WATCH THE ALARMS
-- (retry: cron.job is not directly updatable - reschedule via cron.alter_job)
-- 1. RECIPIENT LOCKDOWN: financial pushes go to Dan's account (kingfish) and
--    NOBODY else, ever. Other seeded rows deactivated; the resolver becomes
--    registry-only (the dynamic club/union-owner fan-out is gone).
-- 2. PUSH DIGEST MODE: 3+ financial pushes to a person in 5 minutes collapse
--    into one digest notice per 5 minutes.
-- 3. CRON-HEALTH WATCHDOG: any active job with 5+ failures and zero
--    successes in 2h raises an incident (critical when it is a zero-drift
--    guard cron). The 4,017-failure silent zombie can never happen again.
-- 4. GUARD INTEGRITY GOES HOURLY (was daily 05:15).

UPDATE public.ca_incident_recipients
   SET active = false
 WHERE user_id <> '47965354-0e56-43ef-931c-ddaab82af765';

CREATE OR REPLACE FUNCTION public.fn_ca_incident_recipient_ids(p_incident ca_drift_incidents, p_senior_only boolean DEFAULT false)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
AS $function$
  -- REGISTRY-ONLY (2026-08-31, Dan's directive): financial incident pushes
  -- go to the active rows of ca_incident_recipients and to nobody else.
  -- The old dynamic fan-out to affected club/union owners is deliberately
  -- gone — an incident about a club must never page that club's owner.
  SELECT COALESCE(array_agg(DISTINCT r.user_id), '{}')
  FROM public.ca_incident_recipients r
  WHERE r.active
    AND (NOT p_senior_only OR r.senior)
    AND (r.scope IN ('platform','financial_ops','technical')
         OR (r.scope = 'union' AND r.scope_id = p_incident.union_id)
         OR (r.scope = 'club'  AND r.scope_id = p_incident.club_id))
$function$;

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
  v_recent int;
  v_digested boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT name INTO club_name  FROM public.clubs  WHERE id = inc.club_id;
  SELECT name INTO union_name FROM public.unions WHERE id = inc.union_id;
  age_min := GREATEST(0, floor(extract(epoch FROM now() - inc.detected_at) / 60))::int;

  body := format(
    '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
    upper(inc.severity),
    inc.classification,
    to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
    inc.layer,
    COALESCE(to_char(inc.expected_amount,'FM999999999990.00'),'?'),
    COALESCE(to_char(inc.actual_amount,'FM999999999990.00'),'?'),
    COALESCE('Club ' || club_name || '. ', ''),
    COALESCE('Union ' || union_name || '. ', ''),
    age_min,
    to_char(inc.deadline_at, 'HH24:MI UTC'),
    inc.auto_repair_status
  );

  FOR rec IN SELECT unnest(public.fn_ca_incident_recipient_ids(inc, p_senior_only))
  LOOP
    BEGIN
      -- DIGEST MODE (2026-08-31): 3+ financial pushes to this person in the
      -- last 5 minutes collapses everything further into one digest notice
      -- per 5 minutes. The dashboard has the detail; the phone gets peace.
      SELECT count(*) INTO v_recent FROM public.notifications nt
       WHERE nt.user_id = rec AND nt.type = 'financial_incident'
         AND nt.created_at > now() - interval '5 minutes';
      IF v_recent >= 3 THEN
        SELECT EXISTS (
          SELECT 1 FROM public.notifications nt
           WHERE nt.user_id = rec AND nt.type = 'financial_incident'
             AND nt.created_at > now() - interval '5 minutes'
             AND nt.data->>'digest' = 'true') INTO v_digested;
        IF NOT v_digested THEN
          PERFORM public.fn_raise_notification(
            rec, 'financial_incident',
            '🔕 More financial activity — see dashboard',
            'Several notifications in the last few minutes have been collapsed into this one. The incident dashboard has every detail.',
            '/hub/club-arena/financial-incidents',
            jsonb_build_object('digest', true));
          n := n + 1;
        END IF;
        INSERT INTO public.ca_incident_events (incident_id, kind, detail)
        VALUES (inc.id, 'notified', jsonb_build_object('digest_collapsed', true, 'recipient', rec));
        CONTINUE;
      END IF;

      PERFORM public.fn_raise_notification(
        rec,
        'financial_incident',
        left(p_headline, 110),
        left(body, 480),
        '/hub/club-arena/financial-incidents?id=' || inc.id::text,
        jsonb_build_object(
          'incident_id', inc.id,
          'classification', inc.classification,
          'severity', inc.severity,
          'discrepancy', inc.discrepancy_amount,
          'club_id', inc.club_id,
          'union_id', inc.union_id,
          'deadline_at', inc.deadline_at
        )
      );
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
                             'senior_only', p_senior_only, 'age_min', age_min));
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_notify failed for %: %', p_incident_id, SQLERRM;
  RETURN 0;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_cron_health()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0; v_is_guard boolean;
BEGIN
  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status = 'failed')    AS fails,
           count(*) FILTER (WHERE d.status = 'succeeded') AS successes,
           max(d.start_time) FILTER (WHERE d.status = 'succeeded') AS last_success,
           max(left(d.return_message, 200)) FILTER (WHERE d.status = 'failed') AS sample_error
    FROM cron.job j
    JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.active AND d.start_time > now() - interval '2 hours'
    GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status = 'failed') >= 5
       AND count(*) FILTER (WHERE d.status = 'succeeded') = 0
    LIMIT 20
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.ca_guard_inventory g
                    WHERE g.kind = 'cron' AND g.object_a = r.jobname AND g.active)
      INTO v_is_guard;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_cron_health', 'unknown',
      CASE WHEN v_is_guard THEN 'critical' ELSE 'warning' END,
      'cron-failing:' || r.jobname || ':' || CURRENT_DATE::text,
      0, NULL, NULL, 'reporting', 'cron.job_run_details',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'scheduled job ' || r.jobname || ' has failed ' || r.fails
        || ' times in 2h with zero successes. Last error: ' || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_2h', r.fails,
                               'last_success', r.last_success));
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_cron_health() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-cron-health-30m', '7,37 * * * *',
  $$SELECT public.fn_ca_cron_health();$$);

-- guard integrity hourly (upsert by name keeps the same command)
SELECT cron.schedule('ca-guard-integrity-daily', '15 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-guard-integrity'))
    THEN (SELECT count(*)::int FROM public.fn_ca_guard_integrity_check() WHERE NOT ok) ELSE -1 END; $$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES ('function', 'fn_ca_cron_health', NULL, 'phase 1b: cron-failure watchdog', true),
       ('cron', 'ca-cron-health-30m', NULL, 'phase 1b: cron health every 30 min', true)
ON CONFLICT DO NOTHING;
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_cron_health', 'phase 1b watchdog, read-only over cron schema')
ON CONFLICT DO NOTHING;;

-- Self-contained definer closure (prod ACL verified 2026-09-01):
REVOKE ALL ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean) TO service_role;
