-- Digest timeout: replace repeated correlated inbox scans with one grouped seven-day history scan. Thresholds and NULL/update/informational semantics retained.
-- Functions only; no schedules, money or player state changes.
-- @live-proof: (SELECT md5(prosrc) = '8af7731ee44487167c47fbfe14edea9c' FROM pg_proc WHERE oid = 'public.fn_sp_digest_attention(date,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $pre$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_sp_digest_attention(date,jsonb)'::regprocedure)
 IS DISTINCT FROM '6cc126afcdd96793517942045a5fc45b' THEN RAISE EXCEPTION 'DIGEST_SPIN_PREIMAGE_DRIFT'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.fn_sp_digest_attention(p_day date, p_metrics jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  a jsonb := '[]'::jsonb;
  v numeric; v2 numeric; avg7 numeric; t text; r record; v_elig numeric;
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
  -- One bounded history pass. A correlated NOT EXISTS below an OR can
  -- rescan the large inbox once per current alert inside this PL/pgSQL call.
  WITH history AS MATERIALIZED (
    SELECT alertname,
           count(*) FILTER (WHERE received_at >= s - interval '1 day'
                            AND investigation_status IS DISTINCT FROM 'informational') AS prior
      FROM public.operational_alert_events
     WHERE received_at >= s - interval '7 days' AND received_at < s
       AND severity = 'critical'
       AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'
     GROUP BY alertname
  ), prior_day AS (
    -- Keep the prior query's NULL-name-to-unknown counting semantics.
    SELECT COALESCE(alertname,'unknown') alertname, sum(prior) prior
      FROM history GROUP BY COALESCE(alertname,'unknown')
  )
  SELECT count(*), string_agg(format('%s (%s, %s the day before)', z.alertname, z.n, z.prior), '; ' ORDER BY z.n DESC)
    INTO v, t
    FROM (
      SELECT cur.key AS alertname, cur.value::numeric AS n, COALESCE(pd.prior,0) AS prior
        FROM jsonb_each_text(COALESCE(p_metrics#>'{health,alert_names}','{}'::jsonb)) cur
        LEFT JOIN history seen ON seen.alertname = cur.key
        LEFT JOIN prior_day pd ON pd.alertname = cur.key
       WHERE seen.alertname IS NULL
          OR (cur.value::numeric >= 10 AND cur.value::numeric >= 2 * COALESCE(pd.prior,0))
    ) z;
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
      'title', format('Payments: %s USD refunded, %s disputes or failed Stripe events', to_char(v,'FM999,990.00'), v2), 'detail', jsonb_build_object('refunds_usd', v, 'issues', v2));
  END IF;

  -- Signups vs 7 day average (only once there is history)
  SELECT avg((metrics#>>'{growth,signups}')::numeric), count(*) INTO avg7, v2 FROM public.sp_daily_metrics WHERE day BETWEEN p_day - 7 AND p_day - 1;
  v := (p_metrics#>>'{growth,signups}')::numeric;
  IF v2 >= 3 AND avg7 >= 1 AND v < avg7 * public.fn_sp_setting('signup_drop_ratio',0.5) THEN
    a := a || jsonb_build_object('rule','signups_dropped','severity','warning',
      'title', format('%s real signups vs a 7 day average of %s', v, round(avg7,1)), 'detail', jsonb_build_object('signups', v, 'avg7', round(avg7,1)));
  END IF;
  v2 := (p_metrics#>>'{growth,signups_phone_verified}')::numeric;
  -- Measured against players who can still earn the package by phone
  -- (US, not already paid by hand); older metrics without the figure fall
  -- back to every signup.
  v_elig := COALESCE((p_metrics#>>'{growth,signups_phone_eligible}')::numeric, v);
  IF v_elig >= 2 AND v2 < v_elig * public.fn_sp_setting('phone_verify_min_rate',0.5) THEN
    a := a || jsonb_build_object('rule','phone_verification_low','severity','warning',
      'title', format('Only %s of %s eligible new players verified their phone (%s skipped the offer)', v2, v_elig,
                      COALESCE((p_metrics#>>'{growth,signups_phone_skipped}')::numeric, 0)),
      'detail', jsonb_build_object('signups', v, 'eligible', v_elig, 'verified', v2,
                                   'skipped', (p_metrics#>>'{growth,signups_phone_skipped}')::numeric,
                                   'otp_codes_sent', (p_metrics#>>'{growth,otp_codes_sent}')::numeric));
  END IF;
  IF COALESCE((p_metrics#>>'{growth,otp_send_failures}')::numeric, 0) > 0 THEN
    a := a || jsonb_build_object('rule','phone_otp_send_failed','severity','warning',
      'title', format('%s phone verification codes failed to send', (p_metrics#>>'{growth,otp_send_failures}')::numeric),
      'detail', jsonb_build_object('failed', (p_metrics#>>'{growth,otp_send_failures}')::numeric,
                                   'sent', (p_metrics#>>'{growth,otp_codes_sent}')::numeric));
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
  -- Only once the digest was already running the day before; the first digest
  -- after launch has no previous morning to miss.
  IF NOT EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day = p_day - 1 AND status = 'sent')
     AND EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day <= p_day - 1) THEN
    a := a || jsonb_build_object('rule','digest_failed','severity','warning','title', format('The digest for %s was not delivered', to_char(p_day - 1,'Mon DD')), 'detail', '{}'::jsonb);
  END IF;

  RETURN a;
END $function$
;
;

DO $post$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_sp_digest_attention(date,jsonb)'::regprocedure)
 IS DISTINCT FROM '8af7731ee44487167c47fbfe14edea9c' THEN RAISE EXCEPTION 'DIGEST_SPIN_POSTIMAGE_DRIFT'; END IF;
END $post$;
COMMIT;
