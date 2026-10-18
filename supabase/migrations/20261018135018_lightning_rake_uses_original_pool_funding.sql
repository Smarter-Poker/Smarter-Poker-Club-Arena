-- Lightning rake uses its retained original funding session.
-- October 17 discrepancy: 58.21 in 7,346 null-club attribution rows.
-- No balance, rate, credit amount, physical-table custody or sealed source changes.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $migration$
DECLARE source text;patched text;
BEGIN
 source:=pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure);
 IF md5(source)<>'0327409fe4751720376893776b124c60' THEN
  RAISE EXCEPTION 'Lightning earning-club preimage changed'; END IF;
 patched:=replace(source,$anchor$ IF p_union_id IS NULL THEN$anchor$,$replacement$ -- A pooled Lightning hand is funded by its original pool/cash session,
 -- not a physical chair at the synthetic host table. Anchor seats can be
 -- elsewhere or already gone by settlement; their session is retained.
 IF EXISTS(SELECT 1 FROM public.lightning_hand h
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id) THEN
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN
   RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
  SELECT array_agg(DISTINCT cs.club_id) INTO clubs
   FROM public.lightning_hand h
   JOIN public.lightning_hand_player hp ON hp.hand_id=h.hand_id
    AND hp.player_id=p_player_id AND hp.cluster_id=h.cluster_id AND hp.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_slot sl ON sl.id=hp.pool_slot_id AND sl.player_id=hp.player_id
    AND sl.cluster_id=h.cluster_id AND sl.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_session ps ON ps.id=sl.pool_session_id AND ps.player_id=hp.player_id
    AND ps.cluster_id=h.cluster_id AND ps.cluster_epoch=h.cluster_epoch
   JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id
    AND h.formed_at<=started AND ps.entered_at<=h.formed_at AND sl.opened_at<=h.formed_at
    AND cs.opened_at<=h.formed_at
    AND (ps.exited_at IS NULL OR ps.exited_at>h.formed_at)
    AND (sl.closed_at IS NULL OR sl.closed_at>h.formed_at)
    AND (cs.closed_at IS NULL OR cs.closed_at>h.formed_at);
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
  IF p_union_id IS NOT NULL THEN
   RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF p_union_id IS NULL THEN$replacement$);
 IF patched=source THEN RAISE EXCEPTION 'Lightning earning-club anchor missing';END IF;
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM patched
 THEN RAISE EXCEPTION 'Lightning earning-club readback mismatch';END IF;
END $migration$;
COMMIT;
