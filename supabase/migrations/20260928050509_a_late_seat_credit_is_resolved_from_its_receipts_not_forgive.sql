-- A LATE SEAT CREDIT IS RESOLVED FROM ITS RECEIPTS, NOT FORGIVEN (2026-09-28).
--
-- Midway Union's first weekly close (book 2026-09-21 07:00 .. 09-28 07:00 UTC)
-- is refused by fn_union_pnl_close_quality because fn_union_pnl_evidence_report
-- counts accepted cash hands whose original evidence is blocked with
-- original_cash_funding_incomplete + original_seat_or_starting_stack_unproven.
--
-- Root cause (engine, fixed in server/src/engine/ServerTableEngineSeating.ts in
-- the same change): addChips decided "between hands" before its await, while
-- dealHand() was preparing the next hand under the seat boundary. The add-on
-- landed on table_seats.stack after the roster's stacks had been snapshotted,
-- so fn_cash_capture_hand_manifest found the seat row = dealt stack + add-on.
-- Every blocked hand in the book has exactly one direct add-on receipt
-- committed 0.006-6.7s before its manifest; none of the money is missing.
--
-- This migration does NOT touch union_pnl_cash_outcomes (immutable) and does
-- not move any settlement floor. It adds:
--   * union_pnl_cash_outcome_resolutions: immutable per-hand receipts, keyed
--     (table_id, hand_number), bound to the outcome's hand_id, payload_hash and
--     md5(evidence), holding the proof rebuilt from primary evidence;
--   * fn_union_pnl_prove_late_seat_credit: re-proves one blocked hand from
--     primary receipts and refuses anything else (any other evidence defect,
--     uncertified ownership, a stack not explained by ledger-backed receipts,
--     a late credit that is not a direct add-on, or late chips not carried
--     into the occupancy's next dealt hand);
--   * fn_union_pnl_resolve_blocked_cash_outcome / _week: service-role writers
--     (dry run by default) that insert a receipt only for a proven hand;
--   * fn_union_pnl_cash_outcome_accepted: the one acceptance predicate;
--   * fn_union_pnl_evidence_report: counts a blocked outcome as accepted only
--     through a valid, hash-bound receipt, and reports how many were resolved.
-- A hand that cannot be proven stays blocked and keeps the close refused.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
     IS DISTINCT FROM '6c0a97bdf833591da55646e8f8322f42' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_evidence_report is not the reviewed definition';
  END IF;
  IF to_regclass('public.union_pnl_cash_outcome_resolutions') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_prove_late_seat_credit(uuid,bigint)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_resolve_blocked_cash_outcome(uuid,bigint,text)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_resolve_blocked_cash_week(uuid,timestamp with time zone,timestamp with time zone,text,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: resolution objects already exist';
  END IF;
END $pre$;

CREATE TABLE public.union_pnl_cash_outcome_resolutions (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  outcome_payload_hash text NOT NULL,
  outcome_evidence_md5 text NOT NULL CHECK (outcome_evidence_md5 ~ '^[0-9a-f]{32}$'),
  resolution_kind text NOT NULL CHECK (resolution_kind = 'late_seat_credit_after_roster_snapshot'),
  proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object' AND proof->>'status' = 'proven'),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  resolved_by text NOT NULL DEFAULT session_user,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number),
  UNIQUE (hand_id)
);
ALTER TABLE public.union_pnl_cash_outcome_resolutions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_cash_outcome_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_cash_outcome_resolutions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_cash_outcome_resolutions TO service_role;

CREATE FUNCTION public.fn_union_pnl_cash_outcome_accepted(o public.union_pnl_cash_outcomes)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT o.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb
  AND o.evidence->'game_scope' IS NOT DISTINCT FROM o.game_scope
  AND ((o.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND o.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number
    AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text)))
$function$;

CREATE FUNCTION public.fn_union_pnl_prove_late_seat_credit(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 o public.union_pnl_cash_outcomes%ROWTYPE; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; x jsonb; hp jsonb; r record;
 v_issue_users uuid[]; v_user uuid; v_occ uuid; v_seat uuid; v_join timestamptz; v_before numeric; v_after numeric;
 prev_hn bigint; prev_at timestamptz; prev_after numeric; nxt_hn bigint; nxt_at timestamptz; nxt_before numeric;
 v_ids uuid[]; v_amts numeric[]; v_kinds text[]; v_split integer; v_prefix numeric; v_late numeric; v_late_total numeric;
 v_extra numeric; v_matched boolean; v_people jsonb; v_result jsonb;
BEGIN
 IF p_table_id IS NULL OR p_hand_number IS NULL THEN RAISE EXCEPTION 'invalid_outcome_identity' USING ERRCODE='22023'; END IF;
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
      OR /*R*/EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions rr WHERE rr.table_id=po.table_id AND rr.hand_number=po.hand_number
       AND rr.hand_id=po.hand_id AND rr.outcome_payload_hash=po.payload_hash AND rr.outcome_evidence_md5=md5(po.evidence::text))/*R*/)) THEN
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
 EXCEPTION
  WHEN raise_exception THEN
   IF SQLERRM LIKE 'late\_credit\_refused:%' THEN
    RETURN jsonb_build_object('status','refused','reason',substr(SQLERRM,21),'table_id',p_table_id,'hand_number',p_hand_number);
   END IF;
   RAISE;
  WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
   RETURN jsonb_build_object('status','refused','reason','malformed_original_evidence','table_id',p_table_id,'hand_number',p_hand_number);
 END;
 RETURN v_result;
END $function$;

CREATE FUNCTION public.fn_union_pnl_resolve_blocked_cash_outcome(p_table_id uuid, p_hand_number bigint, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_proof jsonb; v_prior public.union_pnl_cash_outcome_resolutions%ROWTYPE;
BEGIN
 IF p_table_id IS NULL OR p_hand_number IS NULL THEN RAISE EXCEPTION 'invalid_outcome_identity' USING ERRCODE='22023'; END IF;
 IF p_reason IS NULL OR length(btrim(p_reason))<20 THEN RAISE EXCEPTION 'resolution_reason_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union_pnl_cash_outcome_resolution:'||p_table_id::text||':'||p_hand_number::text,0));
 SELECT * INTO v_prior FROM public.union_pnl_cash_outcome_resolutions WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND THEN
  RETURN jsonb_build_object('status','already_resolved','table_id',p_table_id,'hand_number',p_hand_number,
   'resolution_kind',v_prior.resolution_kind,'late_total',v_prior.proof->'late_total','resolved_at',v_prior.resolved_at);
 END IF;
 v_proof:=public.fn_union_pnl_prove_late_seat_credit(p_table_id,p_hand_number);
 IF v_proof->>'status' IS DISTINCT FROM 'proven' THEN RETURN v_proof; END IF;
 INSERT INTO public.union_pnl_cash_outcome_resolutions(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,
  resolution_kind,proof,reason)
 VALUES(p_table_id,p_hand_number,(v_proof->>'hand_id')::uuid,v_proof->>'outcome_payload_hash',v_proof->>'outcome_evidence_md5',
  v_proof->>'resolution_kind',v_proof,btrim(p_reason));
 RETURN v_proof||jsonb_build_object('status','resolved');
END $function$;

CREATE FUNCTION public.fn_union_pnl_resolve_blocked_cash_week(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_reason text, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c record; v jsonb; v_blocked integer:=0; v_proven integer:=0; v_resolved integer:=0; v_already integer:=0;
 v_refused integer:=0; v_late numeric:=0; v_refusals jsonb:='[]';
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_end<=p_start OR p_end-p_start>interval '8 days' THEN
  RAISE EXCEPTION 'invalid_resolution_period' USING ERRCODE='22023'; END IF;
 IF p_apply IS NOT FALSE AND (p_reason IS NULL OR length(btrim(p_reason))<20) THEN
  RAISE EXCEPTION 'resolution_reason_required' USING ERRCODE='22023'; END IF;
 -- Ascending hand order: a hand whose previous hand is itself resolvable is
 -- re-proved after that previous hand's receipt exists.
 FOR c IN SELECT o.table_id,o.hand_number,o.recognized_at FROM public.union_pnl_cash_outcomes o
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
    OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope)
  ORDER BY o.hand_number LOOP
  v_blocked:=v_blocked+1;
  IF p_apply THEN
   v:=public.fn_union_pnl_resolve_blocked_cash_outcome(c.table_id,c.hand_number,p_reason);
  ELSIF EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=c.table_id AND r.hand_number=c.hand_number) THEN
   v:=jsonb_build_object('status','already_resolved');
  ELSE
   v:=public.fn_union_pnl_prove_late_seat_credit(c.table_id,c.hand_number);
  END IF;
  CASE v->>'status'
   WHEN 'resolved' THEN v_resolved:=v_resolved+1; v_late:=v_late+(v->>'late_total')::numeric;
   WHEN 'proven' THEN v_proven:=v_proven+1; v_late:=v_late+(v->>'late_total')::numeric;
   WHEN 'already_resolved' THEN v_already:=v_already+1;
   ELSE v_refused:=v_refused+1;
    v_refusals:=v_refusals||jsonb_build_array(jsonb_build_object('table_id',c.table_id,'hand_number',c.hand_number,
     'recognized_at',c.recognized_at,'reason',v->>'reason'));
  END CASE;
 END LOOP;
 RETURN jsonb_build_object('union_id',p_union_id,'period_start',p_start,'period_end',p_end,'applied',p_apply IS NOT FALSE,
  'blocked_outcomes',v_blocked,'proven_not_written',v_proven,'resolved_now',v_resolved,'already_resolved',v_already,
  'refused',v_refused,'late_credit_total',v_late,'refusals',v_refusals);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_resolved bigint:=0; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<>public.fn_union_week_start(p_start) OR p_end<>public.fn_union_week_start(p_start+interval '8 days')
  OR p_end>clock_timestamp() THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO v_fence FROM public.union_pnl_weekly_capture WHERE singleton;
 IF v_fence IS NULL OR p_start<=v_fence THEN
  RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
   'issues',jsonb_build_array('week_precedes_complete_original_capture'),'capture_started_at',v_fence,'all_players_included',false);
 END IF;
 -- Both readers wait for the original book's in-flight transactions; this
 -- function is VOLATILE so every subsequent query sees their committed facts.
 v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
 v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
 IF v_open->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','opening_basis_incomplete','evidence',v_open)); END IF;
 IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 -- A blocked outcome counts as accepted only through an immutable resolution
 -- receipt re-proved from primary receipts and bound to this exact outcome
 -- (hand, payload hash, evidence). The outcome row itself is never changed.
 SELECT count(*),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope)
   AND NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_hands,v_bad,v_resolved FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
 -- A missing original game scope cannot silently disappear from every Union.
 SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_original_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.union_pnl_original_flows WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_participant_funding_receipts WHERE recorded_at>=v_fence AND recorded_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_funding_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_funding_application_receipts WHERE applied_at>=v_fence AND applied_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_application_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_hand_provenance_receipts WHERE accepted_at>=v_fence AND accepted_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_hand_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) WHERE NOT valid;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_basis_incomplete','count',v_bad)); END IF;
 -- Every touched tournament registration must have its original chip entry,
 -- including zero-rake players. Historical/current membership is never used.
 SELECT count(*) INTO v_bad FROM public.union_pnl_inventory_events i
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
 WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
  AND EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id::text=COALESCE(i.after_row,i.before_row)->>'tournament_id'
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
  AND (NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.registration_id=i.row_id AND r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.registration_id=i.row_id AND (r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL)));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_original_population_or_instrument_incomplete','count',v_bad)); END IF;
 -- An award must return to the original funding club; a changed credited
 -- wallet does not prove a new earning ownership agreement.
 SELECT count(*) INTO v_bad FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE c.tournament_snapshot->>'union_id'=p_union_id::text AND b.observed_at>=p_start AND b.observed_at<p_end
  AND (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_award_original_earning_owner_incomplete','count',v_bad)); END IF;
 v_eco:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','eco_commercial_basis_incomplete','evidence',v_eco)); END IF;
 SELECT count(DISTINCT x->'terms') INTO v_bad FROM jsonb_array_elements(COALESCE(v_eco->'segments','[]')) x;
 IF v_bad<>1 THEN v_issues:=v_issues||jsonb_build_array('eco_intraweek_changed_terms_require_original_allocation'); END IF;
 v_terms_value:=v_eco#>'{segments,0,terms}';
 -- Validate every original bank/source leg even when the week has no rows.
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 WITH flows AS MATERIALIZED (SELECT * FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end)),
 hand_players AS MATERIALIZED (
  SELECT (p->>'earning_club_id')::uuid club_id,(p->>'user_id')::uuid user_id,(p->>'observed_stack_delta')::numeric delta
  FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
 ), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x GROUP BY 1),
 closing AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x GROUP BY 1),
 -- The canonical payout basis excludes retained Union-house rake. Gross
 -- original rake still belongs in the all-player P&L and bank reconciliation.
 rake AS MATERIALIZED (
  SELECT s.club_id,sum(s.rake_credit) generated,COALESCE(k.earned,0) earned,
   sum(s.rake_credit) FILTER(WHERE s.source_type='cash_rake_accrual') cash_rake,
   sum(s.rake_credit) FILTER(WHERE s.source_type='tournament_fee_accrual') tournament_rake
  FROM public.accounting_payable_earning_sources s
  LEFT JOIN (SELECT club_id,sum(payout) earned FROM public.fn_union_club_rake_basis(p_union_id,p_start,p_end) GROUP BY club_id) k ON k.club_id=s.club_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end GROUP BY s.club_id,k.earned
 ),
 roster AS (
  SELECT DISTINCT (COALESCE(after_row,before_row)->>'club_id')::uuid club_id FROM public.union_pnl_inventory_events
   WHERE source_name='union_clubs' AND COALESCE(after_row,before_row)->>'union_id'=p_union_id::text AND observed_at<p_end
    AND (observed_at>=p_start OR row_id::text IN(SELECT x#>>'{row,id}' FROM jsonb_array_elements(COALESCE(v_open#>'{inventory,population,union_clubs}','[]')) x))
  UNION SELECT club_id FROM rake UNION SELECT club_id FROM flows UNION SELECT club_id FROM hand_players UNION SELECT club_id FROM opening UNION SELECT club_id FROM closing
 ), movement AS (SELECT club_id,sum(buyins) buyins,sum(cashouts) cashouts,
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return')) cash_flow,
  sum(buyins) FILTER(WHERE kind='cash_funding') cash_buyins,sum(cashouts) FILTER(WHERE kind='cash_return') cash_cashouts FROM flows GROUP BY club_id),
 hands AS (SELECT club_id,sum(delta) delta FROM hand_players GROUP BY club_id),
 people AS (SELECT club_id,count(DISTINCT user_id)::int players FROM(SELECT club_id,user_id FROM flows UNION SELECT club_id,user_id FROM hand_players
  UNION SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')||COALESCE(v_close->'holdings','[]')) x) q GROUP BY club_id),
 club_rows AS (
  SELECT r.club_id,COALESCE(m.buyins,0) buyins,COALESCE(m.cashouts,0) cashouts,COALESCE(m.cash_buyins,0) cash_buyins,COALESCE(m.cash_cashouts,0) cash_cashouts,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0) realized_net,COALESCE(o.amount,0) seated_start,COALESCE(c.amount,0) seated_end,
   COALESCE(o.cash,0) seated_start_cash,COALESCE(c.cash,0) seated_end_cash,
   COALESCE(c.amount,0)-COALESCE(o.amount,0) stack_delta,COALESCE(h.delta,0) cash_player_pnl,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)-COALESCE(h.delta,0) tournament_player_pnl,
   COALESCE(m.cash_flow,0)+COALESCE(c.cash,0)-COALESCE(o.cash,0)=COALESCE(h.delta,0) cash_reconciled,
   COALESCE(p.players,0) players,COALESCE(k.generated,0) rake_paid,COALESCE(k.earned,0) rake_earned,COALESCE(k.cash_rake,0) cash_rake,COALESCE(k.tournament_rake,0) tournament_rake,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)+COALESCE(k.generated,0) net
  FROM roster r LEFT JOIN movement m USING(club_id) LEFT JOIN opening o USING(club_id) LEFT JOIN closing c USING(club_id)
  LEFT JOIN hands h USING(club_id) LEFT JOIN people p USING(club_id) LEFT JOIN rake k USING(club_id)
  WHERE r.club_id IS NOT NULL
 ), player_results AS (
  SELECT club_id,user_id,sum(delta) delta FROM (
   SELECT club_id,user_id,cashouts-buyins delta FROM flows
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,-(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  ) amounts GROUP BY club_id,user_id
 ), wins AS(SELECT club_id,sum(greatest(delta,0)) winnings,sum(greatest(-delta,0)) losses FROM player_results GROUP BY club_id), complete AS (
  SELECT q.*,COALESCE(w.winnings,0) winnings,COALESCE(w.losses,0) losses,
   CASE v_terms_value->>'eco_base_mode'
    WHEN 'club_cash_profit' THEN rake_earned-cash_player_pnl
    WHEN 'net_invoice_position' THEN realized_net+stack_delta+rake_paid+rake_earned
    WHEN 'winnings_plus_rake' THEN realized_net+stack_delta+rake_paid
    WHEN 'winnings_only' THEN realized_net+stack_delta END eco_base
  FROM club_rows q LEFT JOIN wins w USING(club_id)
 ) SELECT COALESCE(jsonb_agg(to_jsonb(q)||jsonb_build_object('eco_amount',CASE WHEN v_terms_value->'eco_enabled'='true'::jsonb
  THEN round(-(v_terms_value->>'eco_rate')::numeric*eco_base,2) ELSE 0 END) ORDER BY club_id),'[]'),
  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0) INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake FROM complete q;
 SELECT COALESCE(sum((evidence->>'accepted_rake')::numeric),0) INTO v_accepted_rake FROM public.union_pnl_cash_outcomes
  WHERE game_scope->>'game_union_id'=p_union_id::text AND recognized_at>=p_start AND recognized_at<p_end;
 IF v_accepted_rake IS DISTINCT FROM v_cash_rake THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_rake_does_not_match_original_earning_and_bank_basis'); END IF;
 IF NOT v_cash_reconciled THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'); END IF;
 RETURN jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'issues',v_issues,'clubs',v_clubs,'opening_basis',v_open,'closing_basis',v_close,'eco_commercial_terms_evidence',v_eco,
  'accepted_cash_hands',v_hands,'accepted_cash_hands_resolved',v_resolved,'club_count',v_rows,'current_seats_used',false,'current_membership_used',false,
  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_late_seat_credit(uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_resolve_blocked_cash_outcome(uuid,bigint,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_resolve_blocked_cash_week(uuid,timestamp with time zone,timestamp with time zone,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_resolve_blocked_cash_outcome(uuid,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_resolve_blocked_cash_week(uuid,timestamp with time zone,timestamp with time zone,text,boolean) TO service_role;

DO $post$
DECLARE f text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
     IS DISTINCT FROM 'e42a295828a8d21d5be083c6a7ae4a15' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_evidence_report';
  END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_prove_late_seat_credit(uuid,bigint)'::regprocedure))
     IS DISTINCT FROM 'd3f0d6d189f378cab4446e2573792721' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_prove_late_seat_credit';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)',
    'public.fn_union_pnl_prove_late_seat_credit(uuid,bigint)','public.fn_union_pnl_resolve_blocked_cash_outcome(uuid,bigint,text)',
    'public.fn_union_pnl_resolve_blocked_cash_week(uuid,timestamp with time zone,timestamp with time zone,text,boolean)',
    'public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is browser-executable',f;
    END IF;
  END LOOP;
  IF has_table_privilege('anon','public.union_pnl_cash_outcome_resolutions','SELECT')
     OR has_table_privilege('authenticated','public.union_pnl_cash_outcome_resolutions','SELECT')
     OR has_table_privilege('service_role','public.union_pnl_cash_outcome_resolutions','INSERT') THEN
    RAISE EXCEPTION 'postimage: resolution receipts are writable or browser-readable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_pnl_cash_outcome_resolutions'::regclass AND tgname='original_pnl_immutable') THEN
    RAISE EXCEPTION 'postimage: resolution receipts are not immutable';
  END IF;
END $post$;

COMMIT;
