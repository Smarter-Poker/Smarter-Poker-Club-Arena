DO $probe$
DECLARE ids uuid[]; clubs uuid[]; cnt integer; amt numeric; fingerprint text; hand uuid; changed integer; rows integer; before_rollup numeric; after_rollup numeric;
BEGIN
 PERFORM set_config('lock_timeout','3s',true);
 PERFORM set_config('statement_timeout','50s',true);
WITH cohort AS (SELECT a.id,a.hand_id,a.player_id,a.rake_record_id,a.rake_amount,a.table_id FROM public.rake_attributions a WHERE a.club_id IS NULL AND a.created_at>='2026-10-18 00:00Z' AND a.created_at<'2026-10-18 14:00Z'),
mapping AS (SELECT a.id,a.rake_record_id,a.rake_amount,min(cs.club_id::text)::uuid club_id,count(DISTINCT cs.club_id) clubs
FROM cohort a JOIN public.lightning_hand h ON h.hand_history_id=a.hand_id AND h.host_table_id=a.table_id
JOIN public.hand_history hh ON hh.id=a.hand_id
JOIN public.lightning_hand_player hp ON hp.hand_id=h.hand_id AND hp.player_id=a.player_id AND hp.cluster_id=h.cluster_id AND hp.cluster_epoch=h.cluster_epoch
JOIN public.lightning_pool_slot sl ON sl.id=hp.pool_slot_id AND sl.player_id=hp.player_id AND sl.cluster_id=h.cluster_id AND sl.cluster_epoch=h.cluster_epoch
JOIN public.lightning_pool_session ps ON ps.id=sl.pool_session_id AND ps.player_id=hp.player_id AND ps.cluster_id=h.cluster_id AND ps.cluster_epoch=h.cluster_epoch
JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
WHERE h.formed_at<=hh.started_at AND ps.entered_at<=hh.started_at AND sl.opened_at<=hh.started_at AND cs.opened_at<=hh.started_at
AND (ps.exited_at IS NULL OR ps.exited_at>hh.started_at) AND (sl.closed_at IS NULL OR sl.closed_at>hh.started_at) AND (cs.closed_at IS NULL OR cs.closed_at>hh.started_at)
GROUP BY a.id,a.rake_record_id,a.rake_amount)
 SELECT array_agg(id ORDER BY id),array_agg(DISTINCT club_id),count(*),sum(rake_amount),md5(string_agg(id::text||':'||club_id::text,',' order by id)) INTO ids,clubs,cnt,amt,fingerprint FROM mapping WHERE mapping.clubs=1;
 IF cnt<>303 OR amt<>2.42 OR fingerprint<>'b87ad9576a1cfe83d82759e3027e3304' OR cardinality(clubs)<>1 THEN RAISE EXCEPTION 'historical Lightning cohort moved';END IF;
 FOR hand IN SELECT DISTINCT a.hand_id FROM rake_attributions a WHERE a.id=ANY(ids) ORDER BY a.hand_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||hand::text,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM rake_attributions a JOIN accounting_cash_accrual_batches b ON b.rake_record_id=a.rake_record_id WHERE a.id=ANY(ids)) THEN RAISE EXCEPTION 'historical source already accrued'; END IF;
 SELECT sum(rake_amount) INTO before_rollup FROM club_rake_daily_user WHERE day='2026-10-17';
 UPDATE rake_attributions SET club_id=clubs[1] WHERE id=ANY(ids) AND club_id IS NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>cnt THEN RAISE EXCEPTION 'historical Lightning changed count mismatch';END IF;
 PERFORM set_config('TimeZone','UTC',true);
 rows:=0; -- Current UTC day is not yet eligible for the completed-day cache.
 SELECT sum(rake_amount) INTO after_rollup FROM club_rake_daily_user WHERE day='2026-10-17';
 IF after_rollup IS DISTINCT FROM before_rollup THEN RAISE EXCEPTION 'completed-day cache changed during current-day correction';END IF;
 RAISE EXCEPTION 'EXPECTED_ROLLBACK: % original unaccrued Lightning attributions, amount %, rollup % -> %, users %, no wallet or ledger changes',changed,amt,before_rollup,after_rollup,rows;
END $probe$;
