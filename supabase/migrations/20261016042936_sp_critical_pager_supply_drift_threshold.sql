-- Critical pager: chip supply drift pages the owner's phone only from 100
-- chips (2026-10-16). Over the 3 days before, 6 of 72 hourly supply snapshots
-- carried 3.60 to 6.20 unexplained chips; paging a phone for that twice a day
-- would bury real pages. Any non-zero drift still appears in the morning
-- digest and goes to the alert fleet.
BEGIN;

INSERT INTO public.sp_digest_settings(key, value, note) VALUES
 ('supply_page_threshold_chips', 100, 'Unexplained chip supply at or above this pages the owner immediately; smaller drift is reported in the morning digest')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_sp_critical_scan()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  lb timestamptz := now() - make_interval(mins => public.fn_sp_setting('critical_lookback_minutes',30)::int);
  r record; v_id bigint; v_new int := 0;
BEGIN
  FOR r IN
    WITH pages(dedupe_key, rule, title, detail) AS (
      SELECT 'ledger:' || txid::text || ':' || account_key, 'ledger_findings',
             'Ledger invariant broken on ' || account_key,
             jsonb_build_object('delta', balance_delta, 'ledger_net', ledger_net, 'actor', actor_service, 'found_at', found_at)
        FROM public.ca_ledger_invariant_findings WHERE found_at >= lb
      UNION ALL
      SELECT 'supply:' || id, 'money_not_reconciling', 'Chip supply has ' || round(unexplained,2) || ' unexplained chips',
             jsonb_build_object('snapshot_id', id, 'taken_at', taken_at, 'unexplained', unexplained)
        FROM public.ca_supply_snapshots WHERE taken_at >= lb
         AND abs(COALESCE(unexplained,0)) >= public.fn_sp_setting('supply_page_threshold_chips', 100)
      UNION ALL
      SELECT 'stuck:' || id, 'stuck_tournament',
             tournament_type || ' "' || name || '" is stuck RUNNING since ' || to_char(started_at AT TIME ZONE 'America/Chicago','Mon DD HH12:MI AM'),
             jsonb_build_object('tournament_id', id, 'players', current_players)
        FROM public.tournaments
       WHERE status = 'RUNNING' AND started_at < now() - make_interval(hours => public.fn_sp_setting('stuck_tournament_hours',12)::int)
      UNION ALL
      SELECT 'stripe:' || event_id, 'payment_problem',
             'Stripe webhook ' || COALESCE(event_type,'event') || ' did not complete (' || COALESCE(processing_status,'unknown') || ')',
             jsonb_build_object('event_id', event_id)
        FROM public.stripe_webhook_events
       WHERE processed_at >= lb AND processing_status IN ('failed','error','dead_letter')
      UNION ALL
      SELECT 'dispute:' || id, 'payment_problem', 'Lifetime VIP payment disputed (' || COALESCE(dispute_status,'open') || ')',
             jsonb_build_object('purchase_id', id, 'usd', price_usd)
        FROM public.vip_lifetime_purchases WHERE dispute_id IS NOT NULL AND updated_at >= lb
      UNION ALL
      SELECT 'spins:' || (now() AT TIME ZONE 'America/Chicago')::date, 'spins_underfunded',
             count(*) || ' Diamond Spins or Diamond game hosts are funded below 2,500 diamonds',
             jsonb_build_object('hosts', count(*), 'floor_chips', public.fn_diamond_spins_allowance_floor())
        FROM (SELECT host_id FROM public.wheel_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor()
              UNION ALL
              SELECT host_id FROM public.diamond_game_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor()) u
      HAVING count(*) > 0)
    SELECT p.* FROM pages p WHERE NOT EXISTS (SELECT 1 FROM public.sp_critical_pages c WHERE c.dedupe_key = p.dedupe_key)
  LOOP
    v_id := public.fn_record_operational_alert('sp-critical-pager', r.dedupe_key, 'CriticalPage.' || r.rule, 'firing', 'critical',
              jsonb_build_object('target_task_id', '01a09b86-5ba8-7290-8657-1041f13dd3ca', 'summary', r.title, 'detail', r.detail));
    INSERT INTO public.sp_critical_pages(dedupe_key, rule, title, detail, alert_event_id)
    VALUES (r.dedupe_key, r.rule, r.title, r.detail, v_id) ON CONFLICT (dedupe_key) DO NOTHING;
    v_new := v_new + 1;
  END LOOP;

  RETURN jsonb_build_object('new', v_new,
    'pending', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'rule', rule, 'title', title, 'detail', detail,
                                   'detected_at', detected_at, 'attempts', attempts, 'need_email', emailed_at IS NULL, 'need_sms', sms_at IS NULL) ORDER BY id)
                          FROM public.sp_critical_pages WHERE (emailed_at IS NULL OR sms_at IS NULL) AND attempts < 5
                           AND detected_at > now() - interval '1 day'), '[]'::jsonb));
END $fn$;

COMMIT;
