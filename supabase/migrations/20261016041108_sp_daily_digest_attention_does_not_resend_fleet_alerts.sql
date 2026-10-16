-- Daily Digest attention rules stop re-sending alerts the fleet already has
-- (2026-10-16). The first snapshot (2026-10-14) turned every critical alert
-- name into its own DailyDigest inbox row (29 rows) because no prior-day
-- snapshot existed. Now: one grouped item for critical alert types that are
-- brand new this week or at least doubled and firing 10+ times, compared
-- against the alert inbox itself (works from day one); it and the
-- drift-past-deadline item are marked dispatch=false and shown as already in
-- the fleet queue. The 30 duplicate rows from the first run are reclassified
-- informational so the fleet does not triage them.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_sp_digest_attention(p_day date, p_metrics jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  a jsonb := '[]'::jsonb;
  v numeric; v2 numeric; avg7 numeric; t text; r record;
  prev jsonb;
  s timestamptz := (p_day::timestamp AT TIME ZONE 'America/Chicago');
  e timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Chicago');
BEGIN
  SELECT metrics INTO prev FROM public.sp_daily_metrics WHERE day = p_day - 1;

  -- Money not reconciling
  v := (p_metrics#>>'{money,supply_unexplained}')::numeric;
  IF COALESCE(v,0) <> 0 THEN
    a := a || jsonb_build_object('rule','money_not_reconciling','severity','critical',
      'title', format('Chip supply has %s unexplained chips', to_char(v,'FM999,999,999,990.00')), 'detail', jsonb_build_object('unexplained', v));
  END IF;
  v := (p_metrics#>>'{health,ledger_findings}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','ledger_findings','severity','critical',
      'title', format('%s new ledger invariant findings', v), 'detail', jsonb_build_object('count', v));
  END IF;
  v := (p_metrics#>>'{money,ledger_rake_utc_day}')::numeric; v2 := (p_metrics#>>'{money,rollup_rake_utc_day}')::numeric;
  IF v IS NOT NULL AND v2 IS NOT NULL AND abs(v - v2) > 1 THEN
    a := a || jsonb_build_object('rule','rake_rollup_mismatch','severity','warning',
      'title', format('Rake rollup (%s) does not match the ledger (%s)', v2, v), 'detail', jsonb_build_object('ledger', v, 'rollup', v2));
  END IF;

  -- Critical alert types that are brand new this week, or at least doubled and
  -- firing 10+ times. One grouped item; every one of these alerts is already
  -- in the fleet's inbox, so this item is not dispatched again.
  SELECT count(*), string_agg(format('%s (%s, %s the day before)', z.alertname, z.n, z.prior), '; ' ORDER BY z.n DESC)
    INTO v, t
    FROM (
      SELECT cur.key AS alertname, cur.value::numeric AS n, COALESCE(pd.n, 0) AS prior
        FROM jsonb_each_text(COALESCE(p_metrics#>'{health,alert_names}','{}'::jsonb)) cur
        LEFT JOIN (SELECT COALESCE(alertname,'unknown') alertname, count(*) n FROM public.operational_alert_events
                    WHERE received_at >= s - interval '1 day' AND received_at < s
                      AND investigation_status IS DISTINCT FROM 'informational' AND severity = 'critical'
                    GROUP BY 1) pd ON pd.alertname = cur.key
       WHERE NOT EXISTS (SELECT 1 FROM public.operational_alert_events o
                          WHERE o.alertname = cur.key AND o.severity = 'critical'
                            AND o.received_at >= s - interval '7 days' AND o.received_at < s)
          OR (cur.value::numeric >= 10 AND cur.value::numeric >= 2 * COALESCE(pd.n, 0))) z;
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','critical_alert_rising','severity','critical','dispatch',false,
      'title', format('%s critical alert type%s new this week or doubled: %s', v, CASE WHEN v = 1 THEN ' is' ELSE 's are' END, left(t, 400)),
      'detail', jsonb_build_object('count', v, 'alerts', t));
  END IF;

  v := (SELECT count(*) FROM public.ca_drift_incidents WHERE resolved_at IS NULL AND deadline_at < now());
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','drift_past_deadline','severity','warning','dispatch',false,
      'title', format('%s drift incidents are open past their deadline', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Stuck tournaments (live)
  FOR r IN SELECT id, name, tournament_type, started_at FROM public.tournaments
            WHERE status = 'RUNNING' AND started_at < now() - make_interval(hours => public.fn_sp_setting('stuck_tournament_hours',12)::int)
            ORDER BY started_at LIMIT 10 LOOP
    a := a || jsonb_build_object('rule','stuck_tournament','severity','critical',
      'title', format('%s "%s" has been running since %s', r.tournament_type, r.name, to_char(r.started_at AT TIME ZONE 'America/Chicago','Mon DD HH12:MI AM')),
      'detail', jsonb_build_object('tournament_id', r.id), 'key', r.id::text);
  END LOOP;

  -- Engine breaks and deploys
  v := (p_metrics#>>'{health,breaks,total}')::numeric - (p_metrics#>>'{health,breaks,passed}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','break_failed','severity','warning','title', format('%s engine maintenance breaks did not pass', v), 'detail', p_metrics#>'{health,breaks}');
  END IF;
  v := (p_metrics#>>'{health,deploys,attempted}')::numeric - (p_metrics#>>'{health,deploys,shipped}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','deploy_failed','severity','warning','title', format('%s engine deploy attempts did not ship', v), 'detail', p_metrics#>'{health,deploys}');
  END IF;

  -- Cashouts waiting (live)
  v := (SELECT count(*) FROM public.cashout_requests WHERE completed_at IS NULL AND cancelled_at IS NULL
          AND status NOT IN ('completed','cancelled','canceled','rejected','denied')
          AND created_at < now() - make_interval(hours => public.fn_sp_setting('cashout_wait_hours',24)::int));
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','cashout_waiting','severity','warning','title', format('%s cashout requests waiting over 24 hours', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Weekly invoices late (Mondays, after 9 AM Central)
  IF extract(isodow FROM (now() AT TIME ZONE 'America/Chicago')) = 1 AND (now() AT TIME ZONE 'America/Chicago')::time >= time '09:00' THEN
    v := (SELECT count(*) FROM public.settlement_invoices
           WHERE invoice_type IN ('agent_to_player','agent_to_subagent','club_to_agent','union_to_club','club_weekly_accounting')
             AND created_at > now() - interval '3 days' AND NOT COALESCE(message_sent,false));
    IF v > 0 THEN
      a := a || jsonb_build_object('rule','invoices_late','severity','warning','title', format('%s weekly invoices have not been delivered', v), 'detail', jsonb_build_object('count', v));
    END IF;
  END IF;

  v := (p_metrics#>>'{agents,agent_credit_invoices}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','agent_on_credit','severity','warning','title', format('%s agent credit invoices were created (agents are prepaid only)', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Diamond Spins and Diamond games underfunded (live)
  v := (SELECT count(*) FROM public.wheel_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor())
     + (SELECT count(*) FROM public.diamond_game_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor());
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','spins_underfunded','severity','critical','title', format('%s Diamond Spins or Diamond game hosts are funded below 2,500 diamonds', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Big diamond movements
  IF jsonb_array_length(COALESCE(p_metrics#>'{diamonds,big_movements}','[]'::jsonb)) > 0 THEN
    a := a || jsonb_build_object('rule','big_diamond_move','severity','warning',
      'title', format('%s diamond movements over %s', jsonb_array_length(p_metrics#>'{diamonds,big_movements}'), to_char(public.fn_sp_setting('big_diamond_move',10000),'FM999,999,999')),
      'detail', p_metrics#>'{diamonds,big_movements}');
  END IF;

  -- Payments
  v := COALESCE((p_metrics#>>'{sales,refunds_usd}')::numeric,0);
  v2 := COALESCE((p_metrics#>>'{sales,disputes}')::numeric,0) + COALESCE((p_metrics#>>'{sales,stripe_events,not_completed}')::numeric,0);
  IF v > 0 OR v2 > 0 THEN
    a := a || jsonb_build_object('rule','payment_problem','severity','critical',
      'title', format('Payments: $%s refunded, %s disputes or failed Stripe events', to_char(v,'FM999,990.00'), v2), 'detail', jsonb_build_object('refunds_usd', v, 'issues', v2));
  END IF;

  -- Signups vs 7 day average (only once there is history)
  SELECT avg((metrics#>>'{growth,signups}')::numeric), count(*) INTO avg7, v2 FROM public.sp_daily_metrics WHERE day BETWEEN p_day - 7 AND p_day - 1;
  v := (p_metrics#>>'{growth,signups}')::numeric;
  IF v2 >= 3 AND avg7 >= 1 AND v < avg7 * public.fn_sp_setting('signup_drop_ratio',0.5) THEN
    a := a || jsonb_build_object('rule','signups_dropped','severity','warning',
      'title', format('%s real signups vs a 7 day average of %s', v, round(avg7,1)), 'detail', jsonb_build_object('signups', v, 'avg7', round(avg7,1)));
  END IF;
  v2 := (p_metrics#>>'{growth,signups_phone_verified}')::numeric;
  IF v >= 2 AND v2 < v * public.fn_sp_setting('phone_verify_min_rate',0.5) THEN
    a := a || jsonb_build_object('rule','phone_verification_low','severity','warning',
      'title', format('Only %s of %s new players verified their phone', v2, v), 'detail', jsonb_build_object('signups', v, 'verified', v2));
  END IF;
  v := (p_metrics#>>'{health,signup_errors}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','signup_errors','severity','warning','title', format('%s signup errors', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Error spike
  SELECT avg((metrics#>>'{health,client_errors}')::numeric), count(*) INTO avg7, v2 FROM public.sp_daily_metrics WHERE day BETWEEN p_day - 7 AND p_day - 1;
  v := (p_metrics#>>'{health,client_errors}')::numeric;
  IF v2 >= 3 AND avg7 > 0 AND v > avg7 * public.fn_sp_setting('client_error_spike_ratio',2) THEN
    a := a || jsonb_build_object('rule','error_spike','severity','warning',
      'title', format('%s client errors vs a 7 day average of %s', v, round(avg7)), 'detail', jsonb_build_object('errors', v, 'avg7', round(avg7)));
  END IF;
  v := (p_metrics#>>'{health,crashes}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','client_crash','severity','warning','title', format('%s app crashes', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Beta accounts flagged
  IF jsonb_array_length(COALESCE(p_metrics#>'{health,beta_accounts_flagged}','[]'::jsonb)) > 0 THEN
    a := a || jsonb_build_object('rule','beta_accounts_flagged','severity','warning','title','KingFish or Danimal appeared in an anti-cheat signal', 'detail', p_metrics#>'{health,beta_accounts_flagged}');
  END IF;

  -- Horse fleet
  v := (p_metrics#>>'{play,horse_fleet,degraded_beats}')::numeric;
  v2 := (p_metrics#>>'{play,horse_fleet,max_stuck}')::numeric;
  IF COALESCE(v,0) > 0 OR COALESCE(v2,0) > COALESCE((p_metrics#>>'{play,horse_fleet,max_seated}')::numeric,0) * public.fn_sp_setting('horse_stuck_ratio',0.05) THEN
    a := a || jsonb_build_object('rule','horse_fleet_degraded','severity','warning',
      'title', format('Horse fleet degraded on %s heartbeats, up to %s horses stuck', COALESCE(v,0), COALESCE(v2,0)), 'detail', p_metrics#>'{play,horse_fleet}');
  END IF;

  -- New admins vs the prior day
  IF prev IS NOT NULL THEN
    FOR t IN SELECT j.x FROM jsonb_array_elements_text(COALESCE(p_metrics#>'{security,admin_ids}','[]'::jsonb)) AS j(x)
              WHERE NOT (COALESCE(prev#>'{security,admin_ids}','[]'::jsonb) ? x) LOOP
      a := a || jsonb_build_object('rule','new_admin','severity','critical',
        'title', format('New admin account: %s', COALESCE(p_metrics#>>ARRAY['security','admins',t], t)), 'detail', jsonb_build_object('user_id', t), 'key', t);
    END LOOP;
  END IF;

  -- Stale sources (only meaningful near the end of the day)
  FOR r IN SELECT key, value::timestamptz ts FROM jsonb_each_text(COALESCE(p_metrics->'freshness','{}'::jsonb))
            WHERE key IN ('chip_ledger','hand_history','horse_heartbeat','alert_inbox') LOOP
    IF r.ts IS NULL OR r.ts < LEAST(e, now()) - interval '2 hours' THEN
      a := a || jsonb_build_object('rule','stale_source','severity','warning',
        'title', format('%s has had no new rows since %s', replace(r.key,'_',' '), COALESCE(to_char(r.ts AT TIME ZONE 'America/Chicago','Mon DD HH12:MI AM'),'never')),
        'detail', jsonb_build_object('source', r.key, 'newest', r.ts), 'key', r.key);
    END IF;
  END LOOP;

  -- Previous morning's email
  IF NOT EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day = p_day - 1 AND status = 'sent')
     AND EXISTS (SELECT 1 FROM public.sp_daily_digest_runs) THEN
    a := a || jsonb_build_object('rule','digest_failed','severity','warning','title', format('The digest for %s was not delivered', to_char(p_day - 1,'Mon DD')), 'detail', '{}'::jsonb);
  END IF;

  RETURN a;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_sp_dispatch_attention(p_day date, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE it jsonb; out jsonb := '[]'::jsonb; v_id bigint;
BEGIN
  FOR it IN SELECT j.x FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) AS j(x) LOOP
    -- items about alerts the fleet already has in its inbox are not sent twice
    IF (it->>'dispatch') = 'false' THEN
      out := out || it;
      CONTINUE;
    END IF;
    v_id := public.fn_record_operational_alert(
      'sp-daily-digest',
      'sp-digest:' || p_day || ':' || (it->>'rule') || ':' || COALESCE(it->>'key',''),
      'DailyDigest.' || (it->>'rule'),
      'firing',
      it->>'severity',
      jsonb_build_object('target_task_id', '01a09b86-5ba8-7290-8657-1041f13dd3ca',
                         'summary', it->>'title', 'day', p_day, 'detail', it->'detail',
                         'origin', 'Smarter.Poker Daily Digest attention rule'));
    out := out || (it || jsonb_build_object('alert_event_id', v_id));
  END LOOP;
  RETURN out;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_sp_daily_digest(p_day date DEFAULT NULL, p_dispatch boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_day date := COALESCE(p_day, (now() AT TIME ZONE 'America/Chicago')::date - 1);
  v_row public.sp_daily_metrics%ROWTYPE;
  v_prev jsonb; v_series jsonb; v_mtd jsonb; v_week jsonb; v_att jsonb; v_live jsonb; v_status jsonb;
  v_days_in_month int; v_days_so_far int;
BEGIN
  SELECT * INTO v_row FROM public.sp_daily_metrics WHERE day = v_day;
  IF NOT FOUND THEN
    PERFORM public.fn_sp_daily_metrics_snapshot(v_day);
    SELECT * INTO v_row FROM public.sp_daily_metrics WHERE day = v_day;
  END IF;
  SELECT metrics INTO v_prev FROM public.sp_daily_metrics WHERE day = v_day - 1;

  -- 7 day series of the headline numbers, oldest first
  SELECT jsonb_object_agg(k, vals) INTO v_series FROM (
    SELECT k, jsonb_agg(jsonb_build_object('day', day, 'v', val) ORDER BY day) vals FROM (
      SELECT dm.day, x.k, (dm.metrics #>> x.path)::numeric val
        FROM public.sp_daily_metrics dm
        CROSS JOIN (VALUES
          ('signups', '{growth,signups}'::text[]), ('active_humans', '{growth,active_humans}'::text[]),
          ('cash_rake', '{money,cash_rake}'::text[]), ('tournament_rake', '{money,tournament_rake}'::text[]),
          ('revenue_usd', '{sales,revenue_usd}'::text[]), ('diamonds_given', '{diamonds,given_out}'::text[]),
          ('diamonds_taken', '{diamonds,taken_in}'::text[]), ('hands', '{play,hands}'::text[]),
          ('critical_alerts', '{health,alerts_new,critical}'::text[]), ('client_errors', '{health,client_errors}'::text[])) x(k, path)
       WHERE dm.day BETWEEN v_day - 6 AND v_day) z GROUP BY k) y;

  v_days_in_month := extract(day FROM (date_trunc('month', v_day) + interval '1 month - 1 day'))::int;
  v_days_so_far := extract(day FROM v_day)::int;
  SELECT jsonb_build_object(
    'days', count(*),
    'revenue_usd', COALESCE(sum((metrics#>>'{sales,revenue_usd}')::numeric),0),
    'cash_rake', COALESCE(sum((metrics#>>'{money,cash_rake}')::numeric),0),
    'tournament_rake', COALESCE(sum((metrics#>>'{money,tournament_rake}')::numeric),0),
    'signups', COALESCE(sum((metrics#>>'{growth,signups}')::numeric),0),
    'horse_net_bb', COALESCE(sum((metrics#>>'{play,horse_net_bb}')::numeric),0))
    INTO v_mtd FROM public.sp_daily_metrics WHERE day >= date_trunc('month', v_day)::date AND day <= v_day;
  v_mtd := v_mtd || jsonb_build_object(
    'projected_revenue_usd', round((v_mtd->>'revenue_usd')::numeric / GREATEST(v_days_so_far,1) * v_days_in_month, 2),
    'projected_rake', round(((v_mtd->>'cash_rake')::numeric + (v_mtd->>'tournament_rake')::numeric) / GREATEST(v_days_so_far,1) * v_days_in_month, 2),
    'days_in_month', v_days_in_month, 'day_of_month', v_days_so_far);

  -- Monday: the full previous Monday-Sunday week
  IF extract(isodow FROM v_day) = 7 THEN
    SELECT jsonb_build_object('from', min(day), 'to', max(day), 'days', count(*),
      'revenue_usd', COALESCE(sum((metrics#>>'{sales,revenue_usd}')::numeric),0),
      'cash_rake', COALESCE(sum((metrics#>>'{money,cash_rake}')::numeric),0),
      'tournament_rake', COALESCE(sum((metrics#>>'{money,tournament_rake}')::numeric),0),
      'rakeback_paid', COALESCE(sum((metrics#>>'{money,rakeback_paid}')::numeric),0),
      'signups', COALESCE(sum((metrics#>>'{growth,signups}')::numeric),0),
      'hands', COALESCE(sum((metrics#>>'{play,hands}')::numeric),0),
      'diamonds_given', COALESCE(sum((metrics#>>'{diamonds,given_out}')::numeric),0),
      'diamonds_taken', COALESCE(sum((metrics#>>'{diamonds,taken_in}')::numeric),0),
      'minted', COALESCE(sum((metrics#>>'{money,minted}')::numeric),0),
      'burned', COALESCE(sum((metrics#>>'{money,burned}')::numeric),0))
      INTO v_week FROM public.sp_daily_metrics WHERE day BETWEEN v_day - 6 AND v_day;
  END IF;

  -- Live rules re-read now (cashouts, stuck tournaments, funding, invoices);
  -- anything new is dispatched, then everything is read back with its status.
  v_live := public.fn_sp_digest_attention(v_day, v_row.metrics);
  IF p_dispatch THEN
    v_live := public.fn_sp_dispatch_attention(v_day, v_live);
  ELSE
    -- read-only callers (the online view) only see items already dispatched
    v_live := '[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) INTO v_att FROM (
    SELECT it || jsonb_build_object(
        'status', CASE WHEN NOT (it ? 'alert_event_id') THEN 'tracked'
                       WHEN o.investigation_status IN ('verified_fixed','historical') THEN 'fixed'
                       WHEN o.investigation_status = 'investigating' THEN 'in_progress'
                       ELSE 'not_picked_up' END,
        'resolution', o.investigation->>'resolution') x
      FROM jsonb_array_elements(COALESCE(v_row.attention,'[]'::jsonb) || v_live) AS j(it)
      LEFT JOIN public.operational_alert_events o ON o.id = (it->>'alert_event_id')::bigint) z;
  -- one entry per alert event
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'severity') = 'critical' DESC, x->>'rule'), '[]'::jsonb) INTO v_att FROM (
    SELECT DISTINCT ON (COALESCE(j.x->>'alert_event_id', j.x->>'title')) j.x FROM jsonb_array_elements(v_att) AS j(x)
     ORDER BY COALESCE(x->>'alert_event_id', x->>'title')) q;

  SELECT jsonb_build_object('fixed', count(*) FILTER (WHERE x->>'status' = 'fixed'),
                            'tracked', count(*) FILTER (WHERE x->>'status' = 'tracked'),
                            'in_progress', count(*) FILTER (WHERE x->>'status' = 'in_progress'),
                            'not_picked_up', count(*) FILTER (WHERE x->>'status' = 'not_picked_up'))
    INTO v_status FROM jsonb_array_elements(v_att) AS j(x);

  RETURN jsonb_build_object(
    'day', v_day,
    'day_label', to_char(v_day, 'FMDay, Mon FMDD'),
    'metrics', v_row.metrics,
    'prev', v_prev,
    'series', COALESCE(v_series, '{}'::jsonb),
    'mtd', v_mtd,
    'week', v_week,
    'attention', v_att,
    'attention_status', v_status,
    'previous_run', (SELECT jsonb_build_object('day', day, 'status', status, 'sent_at', sent_at) FROM public.sp_daily_digest_runs WHERE day = v_day - 1),
    'snapshot_computed_at', v_row.computed_at,
    'snapshot_compute_ms', v_row.compute_ms,
    'generated_at', clock_timestamp());
END $fn$;

UPDATE public.operational_alert_events
   SET investigation_status = 'informational',
       investigation = COALESCE(investigation,'{}'::jsonb) || jsonb_build_object(
         'resolution', 'Duplicate of alerts already in the inbox, written by the first Daily Digest snapshot before grouping existed (2026-10-16).')
 WHERE source = 'sp-daily-digest'
   AND alertname IN ('DailyDigest.critical_alert_rising','DailyDigest.drift_past_deadline')
   AND investigation_status = 'new';

COMMIT;
