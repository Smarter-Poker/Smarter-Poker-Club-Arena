CREATE TABLE IF NOT EXISTS smarter_private.ca_table_stall_watch (
  table_id uuid PRIMARY KEY,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ms_since_progress bigint NOT NULL,
  intended_reason text,
  people_waiting boolean NOT NULL DEFAULT false,
  tournament_id uuid,
  alert_id bigint,
  alerted_at timestamptz
);

CREATE TABLE IF NOT EXISTS smarter_private.ca_table_stall_watch_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_http_status integer,
  last_error text,
  tables_silent integer NOT NULL DEFAULT 0,
  tables_stopped integer NOT NULL DEFAULT 0,
  tables_with_people integer NOT NULL DEFAULT 0
);
INSERT INTO smarter_private.ca_table_stall_watch_state (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON smarter_private.ca_table_stall_watch, smarter_private.ca_table_stall_watch_state
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_classify(p_table_id uuid, p_maintenance boolean)
RETURNS TABLE(intended_reason text, people_waiting boolean, tournament_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_t public.tables%ROWTYPE;
  v_tr public.tournaments%ROWTYPE;
  v_tid uuid;
  v_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO v_t FROM public.tables WHERE id = p_table_id;
  v_tid := v_t.tournament_id;
  IF v_tid IS NULL THEN
    SELECT tp.tournament_id INTO v_tid FROM public.tournament_players tp
     WHERE tp.table_id = p_table_id ORDER BY (tp.status = 'playing') DESC LIMIT 1;
  END IF;
  IF v_tid IS NOT NULL THEN
    SELECT * INTO v_tr FROM public.tournaments WHERE id = v_tid;
  END IF;
  tournament_id := v_tid;

  IF v_tid IS NOT NULL THEN
    people_waiting := EXISTS (
      SELECT 1 FROM public.tournament_players tp LEFT JOIN public.profiles p ON p.id = tp.user_id
       WHERE tp.tournament_id = v_tid AND tp.status = 'playing' AND NOT COALESCE(p.is_horse, false));
  ELSE
    people_waiting := EXISTS (
      SELECT 1 FROM public.table_seats s JOIN public.profiles p ON p.id = s.user_id
       WHERE s.table_id = p_table_id AND s.left_at IS NULL AND s.terminal_closed_at IS NULL
         AND s.horse_id IS NULL AND NOT COALESCE(p.is_horse, false));
  END IF;

  intended_reason := CASE
    WHEN p_maintenance THEN 'maintenance_break'
    WHEN EXISTS (SELECT 1 FROM public.ca_diamond_arena_owner_closure c
                  WHERE c.closed AND c.club_id IN (v_t.club_id, v_tr.club_id)) THEN 'diamond_arena_closed'
    WHEN v_t.dealing_halted_at IS NOT NULL THEN 'operator_halt'
    WHEN v_t.break_started_at IS NOT NULL AND v_t.break_started_at > v_now - interval '15 minutes' THEN 'cash_break'
    WHEN v_tid IS NOT NULL AND EXISTS (SELECT 1 FROM smarter_private.tournament_abort_targets a
                                        WHERE a.tournament_id = v_tid AND a.settled_at IS NULL) THEN 'stop_requested'
    WHEN v_tid IS NOT NULL AND v_tr.status IS DISTINCT FROM 'RUNNING' THEN 'tournament_not_running'
    WHEN v_tid IS NOT NULL AND COALESCE(v_tr.on_break, false)
         AND COALESCE(v_tr.break_ends_at + interval '1 minute',
                      v_tr.break_started_at + interval '10 minutes') > v_now THEN 'tournament_break'
    WHEN v_tid IS NOT NULL AND v_tr.addon_period_ends_at IS NOT NULL
         AND v_tr.addon_period_ends_at + interval '1 minute' > v_now THEN 'add_on'
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_watch_tick(p_threshold_ms bigint DEFAULT 60000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status integer;
  v_body text;
  v_maint boolean;
  r record;
  c record;
  v_alert_id bigint;
  v_summary text;
  v_name text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca-table-stall-watch')) THEN
    RETURN jsonb_build_object('skipped', 'overlap');
  END IF;

  BEGIN
    PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '5000');
    SELECT h.status, h.content INTO v_status, v_body
      FROM extensions.http_get('https://engine.smarter.poker/metrics') h;
  EXCEPTION WHEN OTHERS THEN
    UPDATE smarter_private.ca_table_stall_watch_state
       SET last_run_at = v_now, last_http_status = NULL, last_error = left(SQLERRM, 500);
    RETURN jsonb_build_object('error', SQLERRM);
  END;

  IF v_status IS DISTINCT FROM 200 OR v_body IS NULL
     OR position('poker_fleet_tables_stalled' IN v_body) = 0 THEN
    UPDATE smarter_private.ca_table_stall_watch_state
       SET last_run_at = v_now, last_http_status = v_status, last_error = 'metrics unavailable';
    RETURN jsonb_build_object('error', 'metrics unavailable', 'status', v_status);
  END IF;

  v_maint := COALESCE((regexp_match(v_body, E'\npoker_maintenance_break_active (\\d)'))[1] = '1', false);

  CREATE TEMP TABLE IF NOT EXISTS stall_sample (table_id uuid PRIMARY KEY, ms bigint) ON COMMIT DROP;
  TRUNCATE stall_sample;
  INSERT INTO stall_sample (table_id, ms)
  SELECT DISTINCT ON (m[1]) m[1]::uuid, m[2]::bigint
    FROM regexp_matches(v_body,
           E'\npoker_table_ms_since_progress\\{table_id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\\} ([0-9]+)',
           'g') m
   WHERE m[2]::bigint >= p_threshold_ms;

  FOR r IN
    SELECT w.* FROM smarter_private.ca_table_stall_watch w
     WHERE NOT EXISTS (SELECT 1 FROM stall_sample s WHERE s.table_id = w.table_id)
  LOOP
    IF r.alert_id IS NOT NULL THEN
      UPDATE public.operational_alert_events
         SET status = 'resolved', last_received_at = v_now,
             payload = payload || jsonb_build_object('resolved_at', v_now,
                         'stopped_for_seconds', round(extract(epoch FROM (v_now - r.first_seen_at))))
       WHERE id = r.alert_id AND status = 'firing';
    END IF;
    DELETE FROM smarter_private.ca_table_stall_watch WHERE table_id = r.table_id;
  END LOOP;

  FOR r IN SELECT s.table_id, s.ms FROM stall_sample s LOOP
    SELECT * INTO c FROM public.fn_ca_table_stall_classify(r.table_id, v_maint);
    INSERT INTO smarter_private.ca_table_stall_watch AS w
      (table_id, first_seen_at, last_seen_at, ms_since_progress, intended_reason, people_waiting, tournament_id)
    VALUES (r.table_id, v_now - make_interval(secs => r.ms / 1000.0), v_now, r.ms,
            c.intended_reason, c.people_waiting, c.tournament_id)
    ON CONFLICT (table_id) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at, ms_since_progress = EXCLUDED.ms_since_progress,
          intended_reason = EXCLUDED.intended_reason, people_waiting = EXCLUDED.people_waiting,
          tournament_id = EXCLUDED.tournament_id;

    IF c.intended_reason IS NULL THEN
      SELECT w.alert_id INTO v_alert_id FROM smarter_private.ca_table_stall_watch w WHERE w.table_id = r.table_id;
      IF v_alert_id IS NULL THEN
        v_name := COALESCE((SELECT tr.name FROM public.tournaments tr WHERE tr.id = c.tournament_id),
                           (SELECT t.name FROM public.tables t WHERE t.id = r.table_id));
        v_summary := format('%s has made no progress for %s seconds%s.',
                            COALESCE(NULLIF(v_name, ''), 'A table'), r.ms / 1000,
                            CASE WHEN c.people_waiting THEN ' with a player waiting' ELSE '' END);
        INSERT INTO public.operational_alert_events (source, event_key, alertname, status, severity, payload)
        VALUES ('ca-stall-watch',
                format('table:%s:%s', r.table_id, floor(extract(epoch FROM v_now - make_interval(secs => r.ms / 1000.0)))),
                'TableStoppedDealing', 'firing',
                CASE WHEN c.people_waiting THEN 'critical' ELSE 'warning' END,
                jsonb_build_object(
                  'table_id', r.table_id, 'tournament_id', c.tournament_id, 'name', v_name,
                  'ms_since_progress', r.ms, 'people_waiting', c.people_waiting,
                  'threshold_ms', p_threshold_ms, 'detected_at', v_now,
                  'alert', jsonb_build_object('annotations', jsonb_build_object('summary', v_summary))))
        ON CONFLICT (source, event_key) DO NOTHING
        RETURNING id INTO v_alert_id;
        UPDATE smarter_private.ca_table_stall_watch
           SET alert_id = v_alert_id, alerted_at = v_now WHERE table_id = r.table_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE smarter_private.ca_table_stall_watch_state
     SET last_run_at = v_now, last_ok_at = v_now, last_http_status = v_status, last_error = NULL,
         tables_silent = (SELECT count(*) FROM smarter_private.ca_table_stall_watch),
         tables_stopped = (SELECT count(*) FROM smarter_private.ca_table_stall_watch WHERE intended_reason IS NULL),
         tables_with_people = (SELECT count(*) FROM smarter_private.ca_table_stall_watch
                                WHERE intended_reason IS NULL AND people_waiting);
  RETURN (SELECT to_jsonb(s) FROM smarter_private.ca_table_stall_watch_state s);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_table_stall_classify(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_table_stall_watch_tick(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_stall_watch_confirms_people_stuck()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    (SELECT s.last_ok_at IS NULL OR s.last_ok_at < statement_timestamp() - interval '2 minutes'
       FROM smarter_private.ca_table_stall_watch_state s), true)
    OR EXISTS (SELECT 1 FROM smarter_private.ca_table_stall_watch w
                WHERE w.intended_reason IS NULL AND w.people_waiting);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_stall_watch_confirms_people_stuck() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_owner_page_kind(p_source text, p_alertname text, p_severity text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_source = 'ca-stall-watch' AND p_alertname = 'TableStoppedDealing' AND p_severity = 'critical'
      THEN 'dealing'
    WHEN p_source = 'alertmanager' AND p_alertname IN (
           'SLOTableHasStalled', 'SLOHandsAreNotBeingDealt', 'EngineHandsStopped',
           'EngineLivenessDead', 'EngineDown', 'EngineScrapeDown', 'EngineDiscoveryStalled',
           'EngineFleetThroughputCollapsed', 'MttPlayStopped', 'MttFleetNotDealing',
           'TournamentNeverStarted', 'TournamentFleetUnserved', 'PokerTournamentTableNeverStarted')
      THEN 'dealing'
    WHEN (p_source = 'engine-alerts-backfill' AND p_alertname = 'ClubArenaEngineKillStorm'
          AND p_severity = 'critical')
      OR (p_source = 'alertmanager' AND p_alertname IN ('EngineRestartedOutsideTheBreak',
          'TablesAreReloadingThemselves'))
      THEN 'restarts'
    WHEN (p_source = 'owner-operational-notifications' AND p_severity = 'critical'
          AND (p_alertname LIKE 'financial\_incident:%' OR p_alertname LIKE 'guarantee\_bank\_short:%'))
      OR (p_source = 'alertmanager' AND p_alertname IN ('UndeclaredTriggerOnAMoneyTable',
          'TournamentCompletedUnpaid', 'SpinPrizeUnpaid'))
      THEN 'money'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_a_real_alert_reaches_the_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_new_episode CONSTANT interval := interval '3 hours';
  c_reminder CONSTANT interval := interval '12 hours';
  v_kind text;
  v_state public.ca_owner_page_state%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_page boolean;
  v_title text;
  v_summary text;
  v_rec uuid;
BEGIN
  v_kind := public.fn_ca_owner_page_kind(NEW.source, NEW.alertname, NEW.severity);
  IF v_kind IS NULL THEN RETURN NULL; END IF;

  IF v_kind = 'dealing' AND NEW.source = 'alertmanager'
     AND NEW.alertname IN ('SLOTableHasStalled', 'MttPlayStopped', 'MttFleetNotDealing')
     AND NOT public.fn_ca_stall_watch_confirms_people_stuck() THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_state FROM public.ca_owner_page_state WHERE kind = v_kind FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_page := v_state.last_firing_at IS NULL
         OR v_now - v_state.last_firing_at >= c_new_episode
         OR v_state.last_paged_at IS NULL
         OR v_now - v_state.last_paged_at >= c_reminder;

  IF NOT v_page THEN
    UPDATE public.ca_owner_page_state
       SET last_firing_at = v_now, held_since_page = held_since_page + 1
     WHERE kind = v_kind;
    RETURN NULL;
  END IF;

  v_title := CASE v_kind
               WHEN 'dealing' THEN 'Tables Have Stopped Dealing'
               WHEN 'restarts' THEN 'Engine Restart Storm'
               ELSE 'Money Check Failed'
             END;
  v_summary := left(btrim(COALESCE(
      NULLIF(NEW.payload->'alert'->'annotations'->>'summary', ''),
      NULLIF(NEW.payload->'original_event'->>'summary', ''),
      NULLIF(btrim(NEW.payload->'original_notification'->>'message'), ''),
      NULLIF(NEW.payload->'original_notification'->>'title', ''),
      NEW.alertname)), 300);

  FOR v_rec IN
    SELECT DISTINCT r.user_id FROM public.ca_incident_recipients r
     WHERE r.scope = 'platform' AND r.active AND r.senior AND r.user_id IS NOT NULL
  LOOP
    PERFORM public.fn_raise_notification(
      v_rec, 'system', v_title,
      v_summary || CASE WHEN v_state.held_since_page > 0
                        THEN format(' %s more of this kind since the last alert.', v_state.held_since_page)
                        ELSE '' END,
      CASE WHEN v_kind = 'money' THEN '/hub/club-arena/financial-incidents' ELSE '/hub/club-arena' END,
      jsonb_build_object('source', 'owner-real-alert', 'kind', v_kind, 'alert', NEW.alertname,
                         'inbox_id', NEW.id, 'held_since_last_page', v_state.held_since_page));
  END LOOP;

  UPDATE public.ca_owner_page_state
     SET last_firing_at = v_now, last_paged_at = v_now, held_since_page = 0,
         pages_sent = pages_sent + 1
   WHERE kind = v_kind;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_a_real_alert_reaches_the_owner failed for %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;