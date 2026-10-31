-- Explicit owner-requested Diamond history removal, 2026-10-30.
-- At most two finite pages, one transaction. No scheduler, refunds, wallet writes or
-- changes to settlement receipts. Unsettled evidence is deliberately retained.
-- Caller supplies ca.diamond_purge_table and ca.diamond_purge_dry_run locally.
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $remove$
DECLARE
 v_table uuid;
 v_tables uuid[]:=coalesce(nullif(current_setting('ca.diamond_purge_tables',true),''),'{'||current_setting('ca.diamond_purge_table',true)||'}')::uuid[];
 v_results jsonb:='[]'::jsonb;
 v_total integer:=0;
 v_recovered integer:=0;
 v_ids uuid[];
 v_count integer;
 v_recovery_ids uuid[];
BEGIN
 IF coalesce(cardinality(v_tables),0) NOT BETWEEN 1 AND 2 OR array_position(v_tables,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'DIAMOND_REMOVAL_PAGE_BOUND'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false
 OR NOT pg_try_advisory_xact_lock_shared(530090,2)
 OR NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'DIAMOND_REMOVAL_LANE_UNAVAILABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure
  WHERE club_id='002c2d27-9584-4e52-835a-bb2be148fc81'
   AND operation_id='01a18fed-2211-7a62-9416-611dd6e4d96d' AND closed)
 OR NOT EXISTS(SELECT 1 FROM public.ca_arena_settings WHERE id=1
  AND club_id='002c2d27-9584-4e52-835a-bb2be148fc81'
  AND NOT cash_games_enabled AND NOT tournaments_enabled) THEN
  RAISE EXCEPTION 'DIAMOND_NOT_PARKED'; END IF;
 FOREACH v_table IN ARRAY v_tables LOOP
 -- This first removal operation is only for terminal tournament tables.
 -- Keep live and cash accounting authorities intact for separate qualification.
 PERFORM 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=v_table AND tb.club_id='002c2d27-9584-4e52-835a-bb2be148fc81'
  AND t.club_id=tb.club_id AND tb.status='closed'
  AND upper(t.status::text)='COMPLETED'
  AND (lower(coalesce(t.variant::text,''))<>'spin' AND upper(coalesce(t.tournament_type::text,''))<>'SPIN'
   OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements terminal WHERE terminal.tournament_id=t.id))
  AND coalesce(t.bounty_pool,0)<=coalesce(t.bounty_pool_paid,0)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=t.id AND e.closed_at IS NULL)
 FOR SHARE OF tb,t NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'DIAMOND_TERMINAL_TABLE_REQUIRED'; END IF;
 -- Recover a missing witness from earlier history-only removal using its
 -- preserved exact financial facts and immutable original submission identity.
 -- Never invent original timestamps or reconstruct deleted gameplay payloads.
 SELECT array_agg(submission_id) INTO v_recovery_ids FROM (
  SELECT s.submission_id FROM smarter_private.hand_submissions s
  JOIN public.ca_hand_financial_facts f ON f.hand_id=s.submission_id
   AND f.table_id=s.table_id AND f.hand_number=s.hand_number
  JOIN public.tables tb ON tb.id=f.table_id AND tb.tournament_id=f.tournament_id
  JOIN public.hand_atomic_commits a ON a.hand_id=s.submission_id
   AND a.table_id=s.table_id AND a.hand_number=s.hand_number
  WHERE s.table_id=v_table AND isfinite(f.hand_created_at)
   AND isfinite(a.post_commit_completed_at) AND a.post_commit_result->>'ok'='true'
   AND NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=s.submission_id)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals d WHERE d.table_id=s.table_id AND d.hand_number=s.hand_number)
  ORDER BY s.hand_number LIMIT 250
 ) recovery;
 INSERT INTO smarter_private.hand_submission_disposals
  (table_id,hand_number,submission_id,receipt_id,witness_hand_number,reason,expected)
 SELECT s.table_id,s.hand_number,s.submission_id,
  md5('hand:disposal:retention:'||s.submission_id::text)::uuid,s.hand_number,
  'Owner-directed Diamond closure 01a18fed: disposal witness recovered from preserved original identity, financial facts and completed receipt.',
  jsonb_build_object('kind','retention_pruned_settled_hand',
   'table_id',s.table_id,'hand_number',s.hand_number,'submission_id',s.submission_id,
   'retained_at',s.retained_at,'dealer_generation',s.lease_generation,'request_hash',s.request_hash,
   'pruned_hand_id',f.hand_id,'hand_created_at',f.hand_created_at,'settled',true,
   'settlement_completed_at',a.post_commit_completed_at,'settlement_completed',true,
   'disposed_at',clock_timestamp(),'witness_source','preserved_financial_facts')
 FROM smarter_private.hand_submissions s JOIN public.ca_hand_financial_facts f
  ON f.hand_id=s.submission_id AND f.table_id=s.table_id AND f.hand_number=s.hand_number
 JOIN public.hand_atomic_commits a ON a.hand_id=s.submission_id AND a.table_id=s.table_id AND a.hand_number=s.hand_number
 WHERE s.submission_id=ANY(v_recovery_ids) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 v_recovered:=v_recovered+v_count;
 WITH page AS MATERIALIZED (
  SELECT h.id FROM public.hand_history h WHERE h.table_id=v_table
  ORDER BY h.hand_number LIMIT 250
 ), eligible AS (
  SELECT h.id FROM page p JOIN public.hand_history h ON h.id=p.id
  JOIN public.tables tb ON tb.id=h.table_id AND tb.tournament_id=h.tournament_id
  WHERE h.table_id=v_table AND h.reported IS NOT TRUE
   AND EXISTS(SELECT 1 FROM public.hand_atomic_commits a
    WHERE a.hand_id=h.id AND a.table_id=h.table_id AND a.hand_number=h.hand_number
     AND isfinite(a.post_commit_completed_at) AND a.post_commit_result->>'ok'='true')
   AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_jackpot_hits j WHERE j.table_id=h.table_id AND j.hand_number=h.hand_number AND j.paid)
   AND NOT EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=h.table_id AND b.hand_number=h.hand_number)
   AND NOT EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=h.id)
   AND NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k WHERE k.hand_id=h.id AND k.state='pending')
   AND NOT EXISTS(SELECT 1 FROM smarter_private.original_inventory_restoration_cases r,
    jsonb_array_elements(r.source_refs) s WHERE s->>'kind' IN ('atomic_economics','signed_economics') AND s->>'id'=h.id::text)
   AND NOT smarter_private.f06_hand_cards_unresolved(h.table_id,h.hand_number::bigint)
   AND NOT smarter_private.f06_movement_boundary_retained(h.table_id,h.hand_number::bigint)
  FOR UPDATE OF h SKIP LOCKED
 ) SELECT array_agg(id ORDER BY id) INTO v_ids FROM eligible;
 IF coalesce(cardinality(v_ids),0)=0 THEN
  v_results:=v_results||jsonb_build_array(jsonb_build_object('table_id',v_table,'deleted',0)); CONTINUE; END IF;
 -- Preserve the exact minimal financial facts explicitly. The legacy DELETE
 -- trigger swallows errors, so its best-effort insert is not sufficient proof.
 INSERT INTO public.ca_hand_financial_facts
  (hand_id,table_id,tournament_id,hand_number,big_blind,pot_size,rake_amount,bbj_amount,winners,hand_created_at)
 SELECT id,table_id,tournament_id,hand_number,big_blind,pot_size,rake_amount,bbj_amount,winners,created_at
 FROM public.hand_history WHERE id=ANY(v_ids) ON CONFLICT(hand_id) DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.hand_history h LEFT JOIN public.ca_hand_financial_facts f ON f.hand_id=h.id
  WHERE h.id=ANY(v_ids) AND (f.hand_id IS NULL OR
   ROW(f.table_id,f.tournament_id,f.hand_number,f.big_blind,f.pot_size,f.rake_amount,f.bbj_amount,f.winners,f.hand_created_at)
   IS DISTINCT FROM ROW(h.table_id,h.tournament_id,h.hand_number,h.big_blind,h.pot_size,h.rake_amount,h.bbj_amount,h.winners,h.created_at)))
 THEN RAISE EXCEPTION 'DIAMOND_FINANCIAL_FACTS_MISMATCH'; END IF;
 -- Preserve the original disposal witness before removing its history source.
 -- This does not compact raw requests or relax their independent safeguards.
 INSERT INTO smarter_private.hand_submission_disposals
  (table_id,hand_number,submission_id,receipt_id,witness_hand_number,reason,expected)
 SELECT s.table_id,s.hand_number,s.submission_id,
  md5('hand:disposal:retention:'||s.submission_id::text)::uuid,s.hand_number,
  'Owner-directed Diamond closure 01a18fed: settled history removed without refunds; original financial receipts preserved.',
  jsonb_build_object('kind','retention_pruned_settled_hand',
   'table_id',s.table_id,'hand_number',s.hand_number,'submission_id',s.submission_id,
   'retained_at',s.retained_at,'dealer_generation',s.lease_generation,'request_hash',s.request_hash,
   'pruned_hand_id',h.id,'hand_created_at',h.created_at,'settled',true,
   'settlement_completed_at',a.post_commit_completed_at,'settlement_completed',true,
   'disposed_at',clock_timestamp())
 FROM public.hand_history h JOIN smarter_private.hand_submissions s
  ON s.table_id=h.table_id AND s.hand_number=h.hand_number AND s.submission_id=h.id
 JOIN public.hand_atomic_commits a ON a.hand_id=h.id AND a.table_id=h.table_id AND a.hand_number=h.hand_number
 WHERE h.id=ANY(v_ids) AND isfinite(a.post_commit_completed_at) AND a.post_commit_result->>'ok'='true'
 ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM public.hand_history h JOIN smarter_private.hand_submissions s
  ON s.table_id=h.table_id AND s.hand_number=h.hand_number
  WHERE h.id=ANY(v_ids) AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals d
   WHERE d.table_id=s.table_id AND d.hand_number=s.hand_number AND d.submission_id=s.submission_id
    AND d.expected->>'request_hash'=s.request_hash AND d.expected->>'pruned_hand_id'=h.id::text
    AND (d.expected->>'hand_created_at')::timestamptz=h.created_at
    AND d.expected->>'settlement_completed'='true'))
 THEN RAISE EXCEPTION 'DIAMOND_DISPOSAL_WITNESS_MISSING'; END IF;
 DELETE FROM public.hand_history WHERE id=ANY(v_ids) AND table_id=v_table;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>cardinality(v_ids) THEN RAISE EXCEPTION 'DIAMOND_REMOVAL_COUNT_CHANGED'; END IF;
 v_total:=v_total+v_count;
 v_results:=v_results||jsonb_build_array(jsonb_build_object('deleted',v_count,'table_id',v_table,'ids_md5',md5(v_ids::text),'receipt_preserved',true));
 END LOOP;
 PERFORM set_config('ca.diamond_purge_result',jsonb_build_object('deleted',v_total,'recovered_witnesses',v_recovered,'tables',v_results)::text,true);
 IF current_setting('ca.diamond_purge_dry_run')='true' THEN
  RAISE EXCEPTION 'DIAMOND_REMOVAL_ROLLED_BACK: %',current_setting('ca.diamond_purge_result'); END IF;
END $remove$;
SELECT current_setting('ca.diamond_purge_result')::jsonb result;
