-- READ-ONLY DRY RUN for Midway Union (fade0000-...0001), book 2026-09-21 07:00 .. 2026-09-28 07:00 UTC (SELECT/DO only): runs the proof core of
-- fn_union_pnl_prove_late_seat_credit, byte-for-byte, over every outcome of the
-- book that the close would count as blocked, and reports what it would clear.
SET default_transaction_read_only=on;
SET statement_timeout='600s';
BEGIN READ ONLY;
DO $dry$
DECLARE
 p_table_id uuid; p_hand_number bigint; b record; v_out jsonb; v_proven int:=0; v_refused int:=0; v_total int:=0; v_late_sum numeric:=0;
 v_reasons jsonb:='{}';
 o public.union_pnl_cash_outcomes%ROWTYPE; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; x jsonb; hp jsonb; r record;
 v_issue_users uuid[]; v_user uuid; v_occ uuid; v_seat uuid; v_join timestamptz; v_before numeric; v_after numeric;
 prev_hn bigint; prev_at timestamptz; prev_after numeric; nxt_hn bigint; nxt_at timestamptz; nxt_before numeric;
 v_ids uuid[]; v_amts numeric[]; v_kinds text[]; v_split integer; v_prefix numeric; v_late numeric; v_late_total numeric;
 v_extra numeric; v_matched boolean; v_people jsonb; v_result jsonb;
BEGIN
 FOR b IN SELECT c.table_id,c.hand_number FROM public.union_pnl_cash_outcomes c
  WHERE c.game_scope->>'game_union_id'='fade0000-0000-0000-0000-000000000001' AND c.recognized_at>='2026-09-21 07:00:00+00'::timestamptz AND c.recognized_at<'2026-09-28 07:00:00+00'::timestamptz
   AND (c.evidence->>'status' IS DISTINCT FROM 'ready' OR c.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
    OR c.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR c.evidence->'game_scope' IS DISTINCT FROM c.game_scope)
  ORDER BY c.hand_number LOOP
  v_total:=v_total+1; p_table_id:=b.table_id; p_hand_number:=b.hand_number;
  BEGIN
 -- CORE BEGIN (the dry run executes exactly this text)
 v_result:=NULL; v_people:='[]'; v_issue_users:=ARRAY[]::uuid[]; v_late_total:=0;
 SELECT * INTO o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RAISE EXCEPTION 'late_credit_refused:outcome_missing'; END IF;
 IF o.evidence->>'status' IS DISTINCT FROM 'blocked' OR o.evidence ? 'reason'
  OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb
  OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope
  OR o.evidence->>'hand_id' IS DISTINCT FROM o.hand_id::text
  OR jsonb_typeof(o.evidence->'issues') IS DISTINCT FROM 'array'
  OR jsonb_typeof(o.evidence->'participants') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'late_credit_refused:outcome_not_a_blocked_complete_population'; END IF;
 -- Every other defect keeps the hand blocked: only the unproven starting stack is resolvable.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(o.evidence->'issues') e(v)
   WHERE NOT (e.v='"original_cash_funding_incomplete"'::jsonb
    OR (jsonb_typeof(e.v)='object' AND e.v->>'reason'='original_seat_or_starting_stack_unproven' AND (e.v->>'user_id') IS NOT NULL)))
  OR (SELECT count(*) FROM jsonb_array_elements(o.evidence->'issues') e(v) WHERE e.v='"original_cash_funding_incomplete"'::jsonb)<>1 THEN
  RAISE EXCEPTION 'late_credit_refused:outcome_has_other_evidence_defects'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(o.evidence->'participants') e(v)
   WHERE e.v->'ownership_certified' IS DISTINCT FROM 'true'::jsonb OR (e.v->>'earning_club_id') IS NULL) THEN
  RAISE EXCEPTION 'late_credit_refused:earning_ownership_not_certified'; END IF;
 SELECT array_agg(DISTINCT (e.v->>'user_id')::uuid) INTO v_issue_users FROM jsonb_array_elements(o.evidence->'issues') e(v) WHERE jsonb_typeof(e.v)='object';
 IF COALESCE(cardinality(v_issue_users),0)=0 THEN RAISE EXCEPTION 'late_credit_refused:no_unproven_stack'; END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND OR p.hand_id IS DISTINCT FROM o.hand_id OR p.payload_hash IS DISTINCT FROM o.payload_hash
  OR p.status IS DISTINCT FROM 'uncertified' OR p.funding_provenance_complete IS DISTINCT FROM false
  OR p.all_players_included IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'late_credit_refused:provenance_identity_mismatch'; END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR m.issues IS DISTINCT FROM p.issues OR jsonb_typeof(m.issues) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'late_credit_refused:manifest_identity_mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(m.issues) e(v) WHERE e.v->>'reason' IS DISTINCT FROM 'original_seat_or_starting_stack_unproven')
  OR (SELECT array_agg(DISTINCT (e.v->>'user_id')::uuid ORDER BY (e.v->>'user_id')::uuid) FROM jsonb_array_elements(m.issues) e(v))
     IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(v_issue_users) u) THEN
  RAISE EXCEPTION 'late_credit_refused:manifest_defects_are_not_only_the_starting_stack'; END IF;
 FOREACH v_user IN ARRAY v_issue_users LOOP
  SELECT e.v INTO x FROM jsonb_array_elements(m.participants) e(v) WHERE e.v->>'user_id'=v_user::text;
  SELECT e.v INTO hp FROM jsonb_array_elements(p.participants) e(v) WHERE e.v->>'user_id'=v_user::text;
  v_occ:=(x->>'occupancy_id')::uuid; v_seat:=(x->>'seat_id')::uuid; v_join:=(x->>'seat_joined_at')::timestamptz;
  v_before:=(x->>'stack_before')::numeric; v_after:=(hp->>'stack_after')::numeric;
  IF x IS NULL OR hp IS NULL OR v_occ IS NULL OR v_seat IS NULL OR v_join IS NULL OR v_before IS NULL OR v_after IS NULL
   OR hp->>'occupancy_id' IS DISTINCT FROM v_occ::text OR (hp->>'stack_before')::numeric IS DISTINCT FROM v_before THEN
   RAISE EXCEPTION 'late_credit_refused:participant_identity_missing'; END IF;
  -- The seat generation is the one its own funding receipts were recorded
  -- against (each receipt is written from the live seat row); the table_seats
  -- row itself is not retained after the player leaves.
  IF NOT EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f WHERE f.occupancy_id=v_occ)
   OR EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f WHERE f.occupancy_id=v_occ
    AND (f.seat_id IS DISTINCT FROM v_seat OR f.seat_joined_at IS DISTINCT FROM v_join
     OR f.user_id IS DISTINCT FROM v_user OR f.table_id IS DISTINCT FROM p_table_id)) THEN
   RAISE EXCEPTION 'late_credit_refused:seat_identity_unproven'; END IF;
  -- The stack this occupancy carried out of its previous accepted hand.
  prev_hn:=NULL; prev_at:=NULL; prev_after:=0;
  SELECT pr.hand_number,pr.accepted_at,(pp.v->>'stack_after')::numeric INTO prev_hn,prev_at,prev_after
   FROM public.cash_hand_provenance_receipts pr CROSS JOIN LATERAL jsonb_array_elements(pr.participants) pp(v)
   WHERE pr.table_id=p_table_id AND pr.hand_number<p_hand_number AND pp.v->>'occupancy_id'=v_occ::text
   ORDER BY pr.hand_number DESC LIMIT 1;
  IF prev_hn IS NULL THEN prev_after:=0;
  ELSE
   IF prev_at>m.captured_at OR prev_after IS NULL OR prev_after<0 THEN RAISE EXCEPTION 'late_credit_refused:previous_hand_unusable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes po WHERE po.table_id=p_table_id AND po.hand_number=prev_hn
     AND po.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb AND po.evidence->'game_scope' IS NOT DISTINCT FROM po.game_scope
     AND ((po.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND po.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
      OR false /* no resolution receipt exists before the migration */)) THEN
    RAISE EXCEPTION 'late_credit_refused:previous_hand_not_accepted'; END IF;
  END IF;
  -- Receipted money that reached the occupancy after that hand and before this manifest.
  SELECT COALESCE(array_agg(f.id ORDER BY f.recorded_at,f.id),'{}'),COALESCE(array_agg(f.amount ORDER BY f.recorded_at,f.id),'{}'),
   COALESCE(array_agg(f.operation_kind ORDER BY f.recorded_at,f.id),'{}')
   INTO v_ids,v_amts,v_kinds
   FROM public.cash_participant_funding_receipts f
   WHERE f.occupancy_id=v_occ AND f.pending_addon_id IS NULL
    AND f.recorded_at>COALESCE(prev_at,'-infinity'::timestamptz) AND f.recorded_at<=m.captured_at;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
    LEFT JOIN public.chip_ledger l ON l.id=f.source_ledger_id
    WHERE f.id=ANY(v_ids) AND (f.user_id IS DISTINCT FROM v_user OR f.table_id IS DISTINCT FROM p_table_id
     OR f.asset IS DISTINCT FROM 'chips' OR f.amount<=0 OR l.id IS NULL OR l.status IS DISTINCT FROM 'posted'
     OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM p_table_id
     OR l.amount IS DISTINCT FROM f.amount OR l.category IS DISTINCT FROM f.operation_kind)) THEN
   RAISE EXCEPTION 'late_credit_refused:window_funding_not_ledger_proven'; END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
    WHERE f.occupancy_id=v_occ AND a.applied>0 AND a.applied_at>COALESCE(prev_at,'-infinity'::timestamptz) AND a.applied_at<=m.captured_at) THEN
   RAISE EXCEPTION 'late_credit_refused:pending_application_in_window'; END IF;
  -- The dealt stack is the prior stack plus an earlier prefix of those receipts;
  -- the remaining suffix (non-empty, direct add-ons only) landed after the snapshot.
  v_split:=NULL; v_prefix:=prev_after;
  FOR k IN 0..cardinality(v_amts)-1 LOOP
   IF k>0 THEN v_prefix:=v_prefix+v_amts[k]; END IF;
   IF v_prefix=v_before THEN v_split:=k; EXIT; END IF;
  END LOOP;
  IF v_split IS NULL THEN RAISE EXCEPTION 'late_credit_refused:starting_stack_not_explained_by_receipts'; END IF;
  v_late:=0;
  FOR k IN v_split+1..cardinality(v_amts) LOOP
   IF v_kinds[k] IS DISTINCT FROM 'addon' THEN RAISE EXCEPTION 'late_credit_refused:late_credit_is_not_a_direct_add_on'; END IF;
   v_late:=v_late+v_amts[k];
  END LOOP;
  -- The late chips stayed on the seat: the next hand this occupancy was dealt
  -- carries this hand's result plus them (plus any later receipted credit).
  nxt_hn:=NULL; nxt_at:=NULL; nxt_before:=NULL;
  SELECT mn.hand_number,mn.captured_at,(pp.v->>'stack_before')::numeric INTO nxt_hn,nxt_at,nxt_before
   FROM public.cash_hand_participant_manifests mn CROSS JOIN LATERAL jsonb_array_elements(mn.participants) pp(v)
   WHERE mn.table_id=p_table_id AND mn.hand_number>p_hand_number AND pp.v->>'occupancy_id'=v_occ::text
   ORDER BY mn.hand_number LIMIT 1;
  IF nxt_hn IS NULL THEN
   -- No later hand: the occupancy left. Its first recorded seat exit after
   -- this manifest must carry the late chips out instead.
   SELECT e.occurred_at,e.stack INTO nxt_at,nxt_before FROM public.ca_seat_stack_exits e
    WHERE e.user_id=v_user AND e.occurred_at>m.captured_at AND e.table_id=p_table_id AND e.seat_id=v_seat
    ORDER BY e.occurred_at LIMIT 1;
   IF nxt_at IS NULL THEN RAISE EXCEPTION 'late_credit_refused:late_credit_not_observed_in_next_hand_or_exit'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_seat_move_receipts mv WHERE mv.source_occupancy_id=v_occ AND mv.created_at<=nxt_at) THEN
   RAISE EXCEPTION 'late_credit_refused:occupancy_moved_away'; END IF;
  v_matched:=false; v_extra:=v_after+v_late;
  IF v_extra=nxt_before THEN v_matched:=true; END IF;
  IF NOT v_matched THEN
   FOR r IN SELECT q.amt FROM (
     SELECT f.recorded_at at,f.amount amt,f.id::text id FROM public.cash_participant_funding_receipts f
      WHERE f.occupancy_id=v_occ AND f.pending_addon_id IS NULL AND f.recorded_at>m.captured_at AND f.recorded_at<=nxt_at
     UNION ALL SELECT a.applied_at,a.applied,a.pending_addon_id::text FROM public.cash_participant_funding_receipts f
      JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
      WHERE f.occupancy_id=v_occ AND a.applied_occupancy_id=v_occ AND a.applied>0 AND a.applied_at>m.captured_at AND a.applied_at<=nxt_at) q
     ORDER BY q.at,q.id LOOP
    v_extra:=v_extra+r.amt;
    IF v_extra=nxt_before THEN v_matched:=true; EXIT; END IF;
   END LOOP;
  END IF;
  IF NOT v_matched THEN RAISE EXCEPTION 'late_credit_refused:next_hand_does_not_carry_the_late_credit'; END IF;
  v_late_total:=v_late_total+v_late;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'occupancy_id',v_occ,'seat_id',v_seat,
   'seat_joined_at',v_join,'dealt_stack_before',v_before,'stack_after',v_after,
   'previous_hand',CASE WHEN prev_hn IS NULL THEN NULL ELSE jsonb_build_object('hand_number',prev_hn,'accepted_at',prev_at,'stack_after',prev_after) END,
   'in_stack_receipt_ids',to_jsonb(v_ids[1:v_split]),'late_receipt_ids',to_jsonb(v_ids[v_split+1:]),
   'late_amounts',to_jsonb(v_amts[v_split+1:]),'late_total',v_late,
   'carried_into',jsonb_build_object('kind',CASE WHEN nxt_hn IS NULL THEN 'seat_exit' ELSE 'next_hand' END,
    'hand_number',nxt_hn,'at',nxt_at,'stack',nxt_before)));
 END LOOP;
 v_result:=jsonb_build_object('status','proven','resolution_kind','late_seat_credit_after_roster_snapshot',
  'table_id',p_table_id,'hand_number',p_hand_number,'hand_id',o.hand_id,'outcome_payload_hash',o.payload_hash,
  'outcome_evidence_md5',md5(o.evidence::text),'manifest_id',m.id,'manifest_captured_at',m.captured_at,
  'late_total',v_late_total,'participants',v_people);
 -- CORE END
   v_out:=v_result;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM NOT LIKE 'late\_credit\_refused:%' THEN RAISE; END IF;
   v_out:=jsonb_build_object('status','refused','reason',substr(SQLERRM,21));
  END;
  IF v_out->>'status'='proven' THEN v_proven:=v_proven+1; v_late_sum:=v_late_sum+(v_out->>'late_total')::numeric;
  ELSE v_refused:=v_refused+1; v_reasons:=jsonb_set(v_reasons,ARRAY[v_out->>'reason'],to_jsonb(COALESCE((v_reasons->>(v_out->>'reason'))::int,0)+1));
   RAISE NOTICE 'REFUSED % % %',b.table_id,b.hand_number,v_out->>'reason';
  END IF;
 END LOOP;
 RAISE NOTICE 'DRYRUN blocked=% provable=% refused=% late_credit_total=% refused_by_reason=% accepted_cash_basis_incomplete_after=%',
  v_total,v_proven,v_refused,v_late_sum,v_reasons,v_refused;
END $dry$;
ROLLBACK;
