DO $historical$
DECLARE v_i public.ca_drift_incidents%ROWTYPE;v_n bigint;v_hash text;v_bad bigint;
BEGIN
 SELECT * INTO v_i FROM public.ca_drift_incidents
 WHERE id='d205bf24-b6ef-4969-9ec7-5e3c03b8b1ec' FOR UPDATE;
 IF NOT FOUND OR v_i.status<>'open' OR v_i.resolved_at IS NOT NULL
    OR v_i.source IS DISTINCT FROM 'financial_alerts:Tournament.atomic_finish_refused'
    OR v_i.dedupe_key IS DISTINCT FROM 'storm:financial_alerts:Tournament.atomic_finish_refused'
    OR v_i.occurrences<>966 OR v_i.last_seen_at IS DISTINCT FROM '2026-10-19T21:03:59.928348Z'::timestamptz
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_STATE_CHANGED';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_alerts
   WHERE source='Tournament.atomic_finish_refused' AND NOT COALESCE(resolved,false))
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_HAS_UNRESOLVED_ALERT';END IF;
 IF (SELECT count(*) FROM public.ca_incident_events WHERE incident_id=v_i.id AND kind='recurred')<>966
 OR EXISTS(SELECT 1 FROM public.ca_incident_events WHERE incident_id=v_i.id AND kind='recurred'
   AND COALESCE(detail->>'capped_dedupe_key','')!~'^fa:Tournament[.]atomic_finish_refused:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}$')
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_MEMBERSHIP_CHANGED';END IF;
 WITH ids AS MATERIALIZED(
  SELECT DISTINCT split_part(detail->>'capped_dedupe_key',':',3)::uuid id
  FROM public.ca_incident_events WHERE incident_id=v_i.id AND kind='recurred'
 ) SELECT count(*),md5(string_agg(ids.id::text,',' ORDER BY ids.id)),
 count(*) FILTER(WHERE t.id IS NULL OR t.status IS DISTINCT FROM 'COMPLETED'
   OR ts.tournament_id IS NULL OR es.tournament_id IS NULL
   OR es.prize_balance IS DISTINCT FROM 0 OR es.bounty_balance IS DISTINCT FROM 0
   OR es.fee_balance IS DISTINCT FROM 0 OR ts.completed_at IS NULL
   OR es.terminal_closed_at IS NULL)
 INTO v_n,v_hash,v_bad FROM ids LEFT JOIN public.tournaments t USING(id)
 LEFT JOIN public.tournament_terminal_settlements ts ON ts.tournament_id=ids.id
 LEFT JOIN public.tournament_escrow es ON es.tournament_id=ids.id;
 IF v_n<>966 OR v_hash IS DISTINCT FROM 'b5a9452de4d603aee51225842c389b7f' OR v_bad<>0
 THEN RAISE EXCEPTION 'HISTORICAL_STORM_TERMINAL_PROOF_CHANGED: % % %',v_n,v_hash,v_bad;END IF;
 UPDATE public.ca_drift_incidents SET status='resolved',closure_basis='verified_remeasured',
 resolved_at=GREATEST(now(),detected_at),resolved_by='2d1cd6c3-5700-4af9-a271-d4863fdab20d',
 root_cause='Direct-owner tournament earning terms caused original fee capture and terminal refusals. Their capped incident dropped member alert IDs, so resolved source alerts could not close the aggregate. The earning and original close source fixes are installed and all 966 exact tournament witnesses are completed.',
 correction_ref='verified: migration 20261020145408; all 966 exact original terminal receipts and zero escrow; no unresolved source alerts',
 resolution='All 966 original referenced tournaments have durable completed terminal receipts and zero prize, bounty and fee escrow. Every original source financial alert is resolved. Exact aggregate membership is now retained and closed by the last member resolution transition. No chips moved for this incident closure.'
 WHERE id=v_i.id AND status='open' AND resolved_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'HISTORICAL_STORM_CLOSURE_LOST';END IF;
END $historical$;
