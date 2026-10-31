ALTER TABLE smarter_private.ca_table_stall_watch_state
  ADD COLUMN IF NOT EXISTS last_uptime_s numeric,
  ADD COLUMN IF NOT EXISTS last_instance text,
  ADD COLUMN IF NOT EXISTS first_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS blind_alert_id bigint,
  ADD COLUMN IF NOT EXISTS stop_alert_id bigint,
  ADD COLUMN IF NOT EXISTS last_note text;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_facts(p_table_id uuid, p_silent uuid[], p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_t public.tables%ROWTYPE; v_tr public.tournaments%ROWTYPE; v_tid uuid;
  v_siblings int := 0; v_siblings_silent int := 0; v_people boolean; v_stop timestamptz;
BEGIN
  SELECT * INTO v_t FROM public.tables WHERE id = p_table_id;
  v_tid := v_t.tournament_id;
  IF v_tid IS NULL THEN
    SELECT tp.tournament_id INTO v_tid FROM public.tournament_players tp
     WHERE tp.table_id = p_table_id ORDER BY (tp.status = 'playing') DESC LIMIT 1;
  END IF;
  IF v_tid IS NOT NULL THEN
    SELECT * INTO v_tr FROM public.tournaments WHERE id = v_tid;
    SELECT count(DISTINCT tp.table_id), count(DISTINCT tp.table_id) FILTER (WHERE tp.table_id = ANY (p_silent))
      INTO v_siblings, v_siblings_silent
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_tid AND tp.status = 'playing' AND tp.table_id IS NOT NULL AND tp.table_id <> p_table_id;
    SELECT min(a.requested_at) INTO v_stop FROM smarter_private.tournament_abort_targets a
     WHERE a.tournament_id = v_tid AND a.settled_at IS NULL;
    v_people := EXISTS (SELECT 1 FROM public.tournament_players tp LEFT JOIN public.profiles p ON p.id = tp.user_id
       WHERE tp.tournament_id = v_tid AND tp.status = 'playing' AND NOT COALESCE(p.is_horse, false));
  ELSE
    v_people := EXISTS (SELECT 1 FROM public.table_seats s JOIN public.profiles p ON p.id = s.user_id
       WHERE s.table_id = p_table_id AND s.left_at IS NULL AND s.terminal_closed_at IS NULL
         AND s.horse_id IS NULL AND NOT COALESCE(p.is_horse, false));
  END IF;
  RETURN jsonb_build_object(
    'known_table', v_t.id IS NOT NULL OR v_tid IS NOT NULL, 'tournament_id', v_tid, 'name', COALESCE(v_tr.name, v_t.name),
    'people_waiting', COALESCE(v_people, false),
    'closed_arena', EXISTS (SELECT 1 FROM public.ca_diamond_arena_owner_closure c WHERE c.closed AND c.club_id IN (v_t.club_id, v_tr.club_id)),
    'operator_halt', v_t.dealing_halted_at IS NOT NULL,
    'floor_park', v_tid IS NULL AND v_t.id IS NOT NULL AND COALESCE(public.fn_ca_operator_floor_park_holds(v_t.club_id, v_t.union_id), false),
    'cash_break_started_at', v_t.break_started_at, 'tournament_status', v_tr.status,
    'started_at', COALESCE(v_tr.started_at, v_tr.start_time), 'on_break', COALESCE(v_tr.on_break, false),
    'break_started_at', v_tr.break_started_at, 'break_ends_at', v_tr.break_ends_at,
    'addon_period_ends_at', v_tr.addon_period_ends_at, 'stop_requested_at', v_stop,
    'final_table_deal_open', v_tid IS NOT NULL AND EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b
         WHERE b.tournament_id = v_tid AND b.settled_at IS NULL AND b.prepared_at > p_now - interval '15 minutes'),
    'sibling_tables', v_siblings, 'sibling_tables_silent', v_siblings_silent);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_decide(p_facts jsonb, p_ms bigint, p_now timestamptz, p_maintenance boolean, p_engine_paused boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'pg_catalog'
AS $function$
DECLARE c_pause_bound CONSTANT bigint := 600000; v_week_boundary timestamptz;
BEGIN
  IF p_maintenance THEN RETURN 'maintenance_break'; END IF;
  IF COALESCE(p_engine_paused, false) AND p_ms < c_pause_bound THEN RETURN 'engine_paused'; END IF;
  IF (p_facts->>'closed_arena')::boolean THEN RETURN 'diamond_arena_closed'; END IF;
  IF (p_facts->>'operator_halt')::boolean THEN RETURN 'operator_halt'; END IF;
  IF (p_facts->>'floor_park')::boolean THEN RETURN 'floor_park'; END IF;
  IF (p_facts->>'cash_break_started_at')::timestamptz > p_now - interval '15 minutes' THEN RETURN 'cash_break'; END IF;
  v_week_boundary := date_trunc('week', (p_now + interval '5 minutes') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '8 hours';
  IF v_week_boundary > p_now + interval '5 minutes' THEN v_week_boundary := v_week_boundary - interval '7 days'; END IF;
  IF p_now BETWEEN v_week_boundary - interval '5 minutes' AND v_week_boundary + interval '30 minutes' THEN RETURN 'weekly_payout_window'; END IF;
  IF p_facts->>'tournament_id' IS NOT NULL THEN
    IF p_facts->>'stop_requested_at' IS NOT NULL THEN RETURN 'stop_requested'; END IF;
    IF p_facts->>'tournament_status' IS DISTINCT FROM 'RUNNING' THEN RETURN 'tournament_not_running'; END IF;
    IF (p_facts->>'started_at')::timestamptz > p_now - interval '1 minute' THEN RETURN 'before_start'; END IF;
    IF (p_facts->>'on_break')::boolean AND COALESCE((p_facts->>'break_ends_at')::timestamptz + interval '1 minute',
                    (p_facts->>'break_started_at')::timestamptz + interval '10 minutes') > p_now THEN RETURN 'tournament_break'; END IF;
    IF (p_facts->>'addon_period_ends_at')::timestamptz + interval '1 minute' > p_now THEN RETURN 'add_on'; END IF;
    IF (p_facts->>'final_table_deal_open')::boolean THEN RETURN 'final_table_deal'; END IF;
    IF COALESCE((p_facts->>'sibling_tables')::int, 0) > COALESCE((p_facts->>'sibling_tables_silent')::int, 0)
       AND p_ms < c_pause_bound THEN RETURN 'waiting_on_other_tables'; END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_watch_failed(p_now timestamptz, p_error text, p_status integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_state smarter_private.ca_table_stall_watch_state%ROWTYPE; v_id bigint;
BEGIN
  SELECT * INTO v_state FROM smarter_private.ca_table_stall_watch_state WHERE singleton FOR UPDATE;
  v_state.first_failure_at := COALESCE(v_state.first_failure_at, p_now);
  IF v_state.blind_alert_id IS NULL AND COALESCE(v_state.last_ok_at, v_state.first_failure_at) < p_now - interval '2 minutes' THEN
    INSERT INTO public.operational_alert_events (source, event_key, alertname, status, severity, payload)
    VALUES ('ca-stall-watch', format('blind:%s', floor(extract(epoch FROM v_state.first_failure_at))), 'StallWatchBlind', 'firing', 'warning',
            jsonb_build_object('since', v_state.first_failure_at, 'last_ok_at', v_state.last_ok_at, 'error', left(p_error, 500), 'detected_at', p_now,
              'alert', jsonb_build_object('annotations', jsonb_build_object('summary', 'The 60-second table stall watch cannot read the engine: ' || left(p_error, 200)))))
    ON CONFLICT (source, event_key) DO NOTHING RETURNING id INTO v_id;
    v_state.blind_alert_id := v_id;
  END IF;
  UPDATE smarter_private.ca_table_stall_watch_state
     SET last_run_at = p_now, last_http_status = p_status, last_error = left(p_error, 500),
         first_failure_at = v_state.first_failure_at, blind_alert_id = v_state.blind_alert_id WHERE singleton;
  RETURN jsonb_build_object('error', p_error, 'status', p_status, 'blind_alert_id', v_state.blind_alert_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_watch_ingest(p_body text, p_now timestamptz DEFAULT clock_timestamp(), p_threshold_ms bigint DEFAULT 60000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_state smarter_private.ca_table_stall_watch_state%ROWTYPE; v_uptime numeric; v_instance text; v_active int;
  v_stalled_total int; v_samples int; v_maint boolean; v_can_resolve boolean := true; v_note text := NULL;
  v_silent uuid[]; r record; v_facts jsonb; v_reason text; v_alert_id bigint; v_people boolean; v_summary text; v_stop record;
BEGIN
  SELECT * INTO v_state FROM smarter_private.ca_table_stall_watch_state WHERE singleton FOR UPDATE;
  IF p_body IS NULL OR position('poker_fleet_tables_stalled' IN p_body) = 0 THEN
    RETURN public.fn_ca_table_stall_watch_failed(p_now, 'metrics body missing the fleet gauges', NULL);
  END IF;
  v_uptime := (regexp_match(p_body, E'\npoker_uptime_seconds ([0-9.]+)'))[1]::numeric;
  v_instance := (regexp_match(p_body, E'\npoker_engine_info\\{instance_id="([^"]+)"'))[1];
  v_active := COALESCE((regexp_match(p_body, E'\npoker_active_tables ([0-9]+)'))[1]::int, 0);
  v_stalled_total := COALESCE((regexp_match(p_body, E'\npoker_fleet_tables_stalled ([0-9]+)'))[1]::int, 0);
  v_maint := COALESCE((regexp_match(p_body, E'\npoker_maintenance_break_active (\\d)'))[1] = '1', false);
  IF v_uptime IS NOT NULL AND v_state.last_uptime_s IS NOT NULL AND v_instance IS NOT DISTINCT FROM v_state.last_instance
     AND v_uptime <= v_state.last_uptime_s THEN
    RETURN public.fn_ca_table_stall_watch_failed(p_now, 'stale metrics: engine uptime did not advance', NULL);
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS stall_sample (table_id uuid PRIMARY KEY, ms bigint, paused boolean) ON COMMIT DROP;
  TRUNCATE stall_sample;
  INSERT INTO stall_sample (table_id, ms, paused)
  SELECT DISTINCT ON (tid) tid, ms, paused FROM (
    SELECT (regexp_match(m[1], 'table_id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"'))[1]::uuid AS tid,
           m[2]::bigint AS ms, CASE WHEN m[1] ~ 'paused="1"' THEN true WHEN m[1] ~ 'paused="0"' THEN false END AS paused
      FROM regexp_matches(p_body, E'\npoker_table_ms_since_progress\\{([^}]*)\\} ([0-9]+)', 'g') m) x WHERE tid IS NOT NULL;
  SELECT count(*) INTO v_samples FROM stall_sample;
  DELETE FROM stall_sample WHERE ms < p_threshold_ms;
  SELECT COALESCE(array_agg(table_id), '{}') INTO v_silent FROM stall_sample;
  IF v_stalled_total > v_samples THEN v_can_resolve := false; v_note := format('sample truncated (%s of %s)', v_samples, v_stalled_total);
  ELSIF v_active = 0 THEN v_can_resolve := false; v_note := 'engine reports no tables (standby or booting)';
  ELSIF v_uptime IS NOT NULL AND v_uptime < 120 THEN v_can_resolve := false; v_note := 'engine restarted under two minutes ago';
  END IF;
  IF v_can_resolve THEN
    FOR r IN SELECT w.* FROM smarter_private.ca_table_stall_watch w WHERE NOT (w.table_id = ANY (v_silent)) LOOP
      IF r.alert_id IS NOT NULL THEN
        UPDATE public.operational_alert_events SET status = 'resolved', last_received_at = p_now,
               payload = payload || jsonb_build_object('resolved_at', p_now, 'resolution', 'table progressed',
                           'stopped_for_seconds', round(extract(epoch FROM (p_now - r.first_seen_at))))
         WHERE id = r.alert_id AND status = 'firing';
      END IF;
      DELETE FROM smarter_private.ca_table_stall_watch WHERE table_id = r.table_id;
    END LOOP;
  END IF;
  FOR r IN SELECT s.table_id, s.ms, s.paused FROM stall_sample s LOOP
    v_facts := public.fn_ca_table_stall_facts(r.table_id, v_silent, p_now);
    v_reason := public.fn_ca_table_stall_decide(v_facts, r.ms, p_now, v_maint, r.paused);
    v_people := (v_facts->>'people_waiting')::boolean;
    INSERT INTO smarter_private.ca_table_stall_watch AS w (table_id, first_seen_at, last_seen_at, ms_since_progress, intended_reason, people_waiting, tournament_id)
    VALUES (r.table_id, p_now - make_interval(secs => r.ms / 1000.0), p_now, r.ms, v_reason, v_people, (v_facts->>'tournament_id')::uuid)
    ON CONFLICT (table_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, ms_since_progress = EXCLUDED.ms_since_progress,
          intended_reason = EXCLUDED.intended_reason, people_waiting = EXCLUDED.people_waiting, tournament_id = EXCLUDED.tournament_id
    RETURNING w.alert_id INTO v_alert_id;
    IF v_reason IS NULL AND v_alert_id IS NULL THEN
      v_summary := format('%s has made no progress for %s seconds%s.', COALESCE(NULLIF(v_facts->>'name', ''), 'A table'), r.ms / 1000,
                          CASE WHEN v_people THEN ' with a player waiting' ELSE '' END);
      INSERT INTO public.operational_alert_events (source, event_key, alertname, status, severity, payload)
      VALUES ('ca-stall-watch', format('table:%s:%s', r.table_id, floor(extract(epoch FROM p_now - make_interval(secs => r.ms / 1000.0)) / 10) * 10),
              'TableStoppedDealing', 'firing', CASE WHEN v_people THEN 'critical' ELSE 'warning' END,
              jsonb_build_object('table_id', r.table_id, 'tournament_id', v_facts->'tournament_id', 'name', v_facts->'name',
                'ms_since_progress', r.ms, 'people_waiting', v_people, 'threshold_ms', p_threshold_ms, 'detected_at', p_now, 'facts', v_facts,
                'alert', jsonb_build_object('annotations', jsonb_build_object('summary', v_summary))))
      ON CONFLICT (source, event_key) DO NOTHING RETURNING id INTO v_alert_id;
      UPDATE smarter_private.ca_table_stall_watch SET alert_id = v_alert_id, alerted_at = p_now WHERE table_id = r.table_id;
    ELSIF v_reason IS NOT NULL AND v_alert_id IS NOT NULL THEN
      UPDATE public.operational_alert_events SET status = 'resolved', last_received_at = p_now,
             payload = payload || jsonb_build_object('resolved_at', p_now, 'resolution', 'became ' || v_reason)
       WHERE id = v_alert_id AND status = 'firing';
      UPDATE smarter_private.ca_table_stall_watch SET alert_id = NULL, alerted_at = NULL WHERE table_id = r.table_id;
    END IF;
  END LOOP;
  SELECT count(DISTINCT a.tournament_id) AS events, min(a.requested_at) AS oldest, min(a.operation_id::text) AS op,
         count(DISTINCT tp.user_id) FILTER (WHERE tp.status IN ('playing','registered') AND NOT COALESCE(p.is_horse, false)) AS people
    INTO v_stop
    FROM smarter_private.tournament_abort_targets a
    LEFT JOIN public.tournament_players tp ON tp.tournament_id = a.tournament_id
    LEFT JOIN public.profiles p ON p.id = tp.user_id
   WHERE a.settled_at IS NULL AND a.requested_at < p_now - interval '30 minutes';
  IF v_stop.events > 0 THEN
    IF v_state.stop_alert_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.operational_alert_events e WHERE e.id = v_state.stop_alert_id AND e.status = 'firing') THEN
      INSERT INTO public.operational_alert_events (source, event_key, alertname, status, severity, payload)
      VALUES ('ca-stall-watch', format('stop:%s:%s', v_stop.op, floor(extract(epoch FROM v_stop.oldest))), 'TournamentStopNotSettled', 'firing',
              CASE WHEN v_stop.people > 0 THEN 'critical' ELSE 'warning' END,
              jsonb_build_object('events', v_stop.events, 'real_players_held', v_stop.people, 'oldest_requested_at', v_stop.oldest,
                'operation_id', v_stop.op, 'detected_at', p_now,
                'alert', jsonb_build_object('annotations', jsonb_build_object('summary',
                  format('%s stopped tournaments have not been settled or refunded for %s; %s real players are still held in them.',
                         v_stop.events,
                         CASE WHEN p_now - v_stop.oldest >= interval '1 hour' THEN floor(extract(epoch FROM p_now - v_stop.oldest) / 3600) || ' hours'
                              ELSE floor(extract(epoch FROM p_now - v_stop.oldest) / 60) || ' minutes' END, v_stop.people)))))
      ON CONFLICT (source, event_key) DO NOTHING RETURNING id INTO v_state.stop_alert_id;
      IF v_state.stop_alert_id IS NULL THEN
        SELECT e.id INTO v_state.stop_alert_id FROM public.operational_alert_events e
         WHERE e.source = 'ca-stall-watch' AND e.event_key = format('stop:%s:%s', v_stop.op, floor(extract(epoch FROM v_stop.oldest)));
      END IF;
    END IF;
  ELSIF v_state.stop_alert_id IS NOT NULL THEN
    UPDATE public.operational_alert_events SET status = 'resolved', last_received_at = p_now,
           payload = payload || jsonb_build_object('resolved_at', p_now, 'resolution', 'every stop target settled')
     WHERE id = v_state.stop_alert_id AND status = 'firing';
    v_state.stop_alert_id := NULL;
  END IF;
  IF v_state.blind_alert_id IS NOT NULL THEN
    UPDATE public.operational_alert_events SET status = 'resolved', last_received_at = p_now,
           payload = payload || jsonb_build_object('resolved_at', p_now)
     WHERE id = v_state.blind_alert_id AND status = 'firing';
  END IF;
  UPDATE smarter_private.ca_table_stall_watch_state
     SET last_run_at = p_now, last_ok_at = p_now, last_http_status = 200, last_error = NULL, first_failure_at = NULL, blind_alert_id = NULL,
         stop_alert_id = v_state.stop_alert_id, last_uptime_s = v_uptime, last_instance = v_instance, last_note = v_note,
         tables_silent = (SELECT count(*) FROM smarter_private.ca_table_stall_watch),
         tables_stopped = (SELECT count(*) FROM smarter_private.ca_table_stall_watch WHERE intended_reason IS NULL),
         tables_with_people = (SELECT count(*) FROM smarter_private.ca_table_stall_watch WHERE intended_reason IS NULL AND people_waiting)
   WHERE singleton;
  RETURN (SELECT to_jsonb(s) FROM smarter_private.ca_table_stall_watch_state s);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_table_stall_watch_tick(p_threshold_ms bigint DEFAULT 60000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_now timestamptz := clock_timestamp(); v_status integer; v_body text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca-table-stall-watch')) THEN RETURN jsonb_build_object('skipped', 'overlap'); END IF;
  BEGIN
    PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '5000');
    SELECT h.status, h.content INTO v_status, v_body FROM extensions.http_get('https://engine.smarter.poker/metrics') h;
  EXCEPTION WHEN OTHERS THEN
    RETURN public.fn_ca_table_stall_watch_failed(v_now, SQLERRM, NULL);
  END;
  IF v_status IS DISTINCT FROM 200 THEN
    RETURN public.fn_ca_table_stall_watch_failed(v_now, 'metrics returned HTTP ' || COALESCE(v_status::text, 'none'), v_status);
  END IF;
  RETURN public.fn_ca_table_stall_watch_ingest(v_body, v_now, p_threshold_ms);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_stall_watch_confirms_people_stuck()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE((SELECT s.last_ok_at IS NULL OR s.last_ok_at < statement_timestamp() - interval '2 minutes' OR s.blind_alert_id IS NOT NULL
       FROM smarter_private.ca_table_stall_watch_state s), true)
    OR EXISTS (SELECT 1 FROM smarter_private.ca_table_stall_watch w WHERE w.intended_reason IS NULL AND w.people_waiting);
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_owner_page_kind(p_source text, p_alertname text, p_severity text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_source = 'ca-stall-watch' AND p_alertname = 'TableStoppedDealing' AND p_severity = 'critical' THEN 'dealing'
    WHEN p_source = 'ca-stall-watch' AND p_alertname = 'TournamentStopNotSettled' AND p_severity = 'critical' THEN 'money'
    WHEN p_source = 'alertmanager' AND p_alertname IN ('SLOTableHasStalled', 'SLOHandsAreNotBeingDealt', 'EngineHandsStopped',
           'EngineLivenessDead', 'EngineDown', 'EngineScrapeDown', 'EngineDiscoveryStalled', 'EngineFleetThroughputCollapsed', 'MttPlayStopped',
           'MttFleetNotDealing', 'TournamentNeverStarted', 'TournamentFleetUnserved', 'PokerTournamentTableNeverStarted') THEN 'dealing'
    WHEN (p_source = 'engine-alerts-backfill' AND p_alertname = 'ClubArenaEngineKillStorm' AND p_severity = 'critical')
      OR (p_source = 'alertmanager' AND p_alertname IN ('EngineRestartedOutsideTheBreak', 'TablesAreReloadingThemselves')) THEN 'restarts'
    WHEN (p_source = 'owner-operational-notifications' AND p_severity = 'critical'
          AND (p_alertname LIKE 'financial\_incident:%' OR p_alertname LIKE 'guarantee\_bank\_short:%'))
      OR (p_source = 'alertmanager' AND p_alertname IN ('UndeclaredTriggerOnAMoneyTable', 'TournamentCompletedUnpaid', 'SpinPrizeUnpaid')) THEN 'money'
  END;
$function$;

DROP FUNCTION IF EXISTS public.fn_ca_table_stall_classify(uuid, boolean);

REVOKE ALL ON FUNCTION public.fn_ca_table_stall_facts(uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_table_stall_decide(jsonb, bigint, timestamptz, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_table_stall_watch_ingest(text, timestamptz, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_table_stall_watch_failed(timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_table_stall_watch_tick(bigint) FROM PUBLIC, anon, authenticated;