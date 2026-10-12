-- A UNION CLOSE PROVES ITS P&L EVIDENCE ONCE, AND FAST (2026-09-28).
--
-- WHAT WAS SLOW (read-only on production 2026-09-28, Midway Union, week
-- 2026-09-21 07:00 .. 2026-09-28 07:00 UTC; 355k accepted hands, 84k original
-- flows, 3,938 + 3,690 open tournament registrations at the two boundaries).
-- fn_prepare_accounting_week ran 20 minutes and was cancelled inside its one
-- call of fn_union_pnl_evidence_report (through fn_union_pnl_close_quality);
-- the close then reaches that report about four more times (close quality,
-- cascade, qualified clubs, invoices).
--  * fn_union_pnl_boundary: four queries per open registration, two of them
--    fn_union_pnl_tournament_returns(t,reg,NULL,at), which scans every
--    tournament credit (73 ms, 15.8k buffers each): 7,628 registrations x 2 x
--    73 ms = about 18.5 minutes for the two boundaries. This alone is the
--    20-minute timeout.
--  * fn_union_pnl_original_flow_evidence, called twice: its cash-return
--    lateral reads every buy-in receipt per flow (no table_id index; planner
--    cost 5.8e10), and its tournament returns probe a frame per credit (28 s).
--  * the touched-registration test: a nested-loop semi join of every
--    tournament_players event against every tournaments event (cost 3.9e9),
--    then two hashed scans of every tournament receipt.
--  * the week's hands read three times (count with a per-row acceptance call:
--    over 45 s; participants; accepted rake: 23 s each), plus a sequential
--    scan of every Union's hands for missing scopes (over 45 s) and of 15 GB of
--    hand provenance receipts for missing transaction ids (31 s).
--
-- WHAT CHANGES (same report, same issues, same order, same refusals)
--  * fn_union_pnl_boundary reads each open tournament once, as a set, in the
--    population's order: the same entry, instrument, owner-change and
--    returned-credit tests per registration (4 queries per registration
--    become 1 per tournament).
--  * fn_union_pnl_evidence_report reads the flow proof once (and reuses the
--    same rows for the P&L), the week's hands once (per club and player
--    totals, hand count and accepted rake in one pass), counts refused or
--    resolved hands through a partial index, and finds the week's touched
--    registrations through their own events.
--  * Inside one union close attempt (app.accounting_close_memo='on') the first
--    complete report of a (union, week) is kept in app.union_pnl_evidence_memo
--    for the rest of the attempt; fn_weekly_accounting_attempt_begin/_end
--    clear it; a rolled-back subtransaction forgets it. Outside a close every
--    call computes the report exactly as before.
--  * STEP 1: eight indexes, built CONCURRENTLY, that the queries above need.
--
-- Native qualification: scripts/dev/test-union-pnl-evidence-fast.sh (46 books,
-- identical values and refusals, old vs new; memo; index use; red control).

-- ============================================================================
-- STEP 1 - OUTSIDE ANY TRANSACTION (each statement commits on its own; none
-- blocks writers). Re-running it is harmless.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_outcomes_unaccepted ON public.union_pnl_cash_outcomes (((game_scope->>'game_union_id')),recognized_at)
 WHERE (evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR evidence->'game_scope' IS DISTINCT FROM game_scope);
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_outcomes_scope_missing ON public.union_pnl_cash_outcomes (recognized_at)
 WHERE NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_original_flows_scope_missing ON public.union_pnl_original_flows (recognized_at)
 WHERE NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_hand_provenance_untransacted ON public.cash_hand_provenance_receipts (accepted_at) WHERE transaction_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_participant_funding_buyin_table ON public.cash_participant_funding_receipts (table_id,account_entity_id) WHERE operation_kind='buyin';
CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_accounting_credit_receipts_tournament ON public.tournament_accounting_credit_receipts (tournament_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_inventory_events_players_observed ON public.union_pnl_inventory_events (observed_at) WHERE source_name='tournament_players';
CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_participant_funding_receipts_registration ON public.tournament_participant_funding_receipts (registration_id);

-- ============================================================================
-- STEP 2 - ONE TRANSACTION
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.union_pnl_cash_outcomes_unaccepted') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index union_pnl_cash_outcomes_unaccepted missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.union_pnl_cash_outcomes_unaccepted; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.union_pnl_cash_outcomes_scope_missing') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index union_pnl_cash_outcomes_scope_missing missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.union_pnl_cash_outcomes_scope_missing; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.union_pnl_original_flows_scope_missing') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index union_pnl_original_flows_scope_missing missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.union_pnl_original_flows_scope_missing; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.cash_hand_provenance_untransacted') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index cash_hand_provenance_untransacted missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.cash_hand_provenance_untransacted; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.cash_participant_funding_buyin_table') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index cash_participant_funding_buyin_table missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.cash_participant_funding_buyin_table; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.tournament_accounting_credit_receipts_tournament') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index tournament_accounting_credit_receipts_tournament missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.tournament_accounting_credit_receipts_tournament; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.union_pnl_inventory_events_players_observed') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index union_pnl_inventory_events_players_observed missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.union_pnl_inventory_events_players_observed; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.tournament_participant_funding_receipts_registration') AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index tournament_participant_funding_receipts_registration missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS public.tournament_participant_funding_receipts_registration; then re-run STEP 1' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'e42a295828a8d21d5be083c6a7ae4a15' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_evidence_report' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'be154af9a391203d46ae54e5c318141f' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_boundary' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure)) IS DISTINCT FROM '96e8c69092908fbe9526963e9012b3e0' THEN RAISE EXCEPTION 'preimage mismatch: fn_weekly_accounting_attempt_begin' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_end()'::regprocedure)) IS DISTINCT FROM 'b7d27aa978a1b8db3a98921d6af82588' THEN RAISE EXCEPTION 'preimage mismatch: fn_weekly_accounting_attempt_end' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_tournament_returns(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '065c90de9bd14ae893dcb96bff0a3be1' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_tournament_returns' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '5c4d8cb079d19fe08536afd7067b7617' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_original_flow_evidence' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_tournament_entry_club(tournament_participant_funding_receipts)'::regprocedure)) IS DISTINCT FROM 'b49d259721d3eb9c1d8ba7061fd28b7e' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_tournament_entry_club' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '7e443fd75f3b1ece7cd0713a6b8fc0a5' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_cash_outcome_accepted' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_close_quality(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '8b5551d177b27bcbd211b8ecd9ee3a11' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_close_quality' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_qualified_clubs(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '2fed6a15cdb5186d19e3cee731b8d804' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_qualified_clubs' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '409eade1f18decea288db84784f127b2' THEN RAISE EXCEPTION 'preimage mismatch: fn_accounting_union_earned_plan' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_observe()'::regprocedure)) IS DISTINCT FROM '11c7c788d943a11375a15819e78873ba' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_inventory_observe' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_original_frame()'::regprocedure)) IS DISTINCT FROM '9a6559774cc1ed4ed49b315a3428abdb' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_original_frame' USING ERRCODE='55000'; END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
 nonchips boolean; changed boolean; returned numeric;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of(p_at);
 IF inv->>'status' IS DISTINCT FROM 'observed' THEN RETURN jsonb_build_object('status','blocked','inventory',inv,'holdings',holdings); END IF;
 FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,table_seats}','[]')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
   WHERE y#>>'{row,id}'=x#>>'{row,table_id}' AND y#>>'{row,union_id}'=p_union_id::text) LOOP
  lineage:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,(s->>'table_id')::uuid,
   (s->>'id')::uuid,(s->>'occupancy_id')::uuid,(s->>'joined_at')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE r.operation_kind='buyin'),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->'funding_receipts') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid;
  value:=public.fn_pnl_evidence_cents(s->'stack');
  IF lineage->'issues'<>'[]'::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','cash_boundary_original_funding_missing_or_ambiguous','seat_id',s->'id'));
  ELSE
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','cash_stack','source_id',s->'id'));
  END IF;
 END LOOP;
 -- Money awaiting the original add-on application is still held for its
 -- original funding account. It must not appear as a poker loss at midnight.
 FOR f IN
  SELECT r.*,r.amount-CASE WHEN COALESCE(af.observed_at,a.applied_at)<p_at THEN a.applied+a.refunded ELSE 0 END AS held
  FROM public.cash_participant_funding_receipts r
  LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=r.id
  LEFT JOIN public.union_pnl_transaction_frames rf ON rf.transaction_id=r.transaction_id
  LEFT JOIN public.union_pnl_transaction_frames af ON af.transaction_id=a.transaction_id
  WHERE r.pending_addon_id IS NOT NULL AND COALESCE(rf.observed_at,r.recorded_at)<p_at
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
    WHERE y#>>'{row,id}'=r.table_id::text AND y#>>'{row,union_id}'=p_union_id::text)
 LOOP
  IF f.held<0 OR f.funding_club_id IS NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_boundary_invalid','source_id',f.id));
  ELSIF f.held>0 THEN
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',f.funding_club_id,'user_id',f.user_id,'amount',f.held,'kind','pending_cash_funding','source_id',f.id));
  END IF;
 END LOOP;
 -- Preserve the established realized-settlement rule: original gross entry
 -- less money already returned is deferred while a tournament remains open.
 -- This is not market value, ICM, or a new allocation of the prize pool.
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
  WHERE x#>>'{row,union_id}'=p_union_id::text LOOP
  SELECT operation INTO first_op FROM public.union_pnl_inventory_events WHERE source_name='tournaments' AND row_id=(t->>'id')::uuid ORDER BY event_id LIMIT 1;
  IF first_op IS DISTINCT FROM 'INSERT' THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population's order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned IN
   WITH players AS MATERIALIZED (
    SELECT y.x->'row' s,y.o ord,(y.x#>>'{row,id}')::uuid registration_id,(y.x#>>'{row,user_id}')::uuid user_id
    FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) WITH ORDINALITY y(x,o)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
   ), credits AS MATERIALIZED (
    -- fn_union_pnl_tournament_returns(t,NULL,NULL,p_at): every credit of this
    -- tournament observed before the boundary; the registration filter that
    -- function applied per call is applied per player below.
    SELECT c.user_id,c.credited_club_id,c.amount,c.entry_receipt_ids,true same_tournament
    FROM public.tournament_accounting_credit_receipts c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
    UNION ALL
    SELECT r2.user_id,r2.source_wallet_club_id,r2.amount_paid_now,ARRAY[r.id],false
    FROM public.tournament_refund_tranches r2
    JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=r2.entitlement_id
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
    WHERE r2.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
     AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=r2.credit_ledger_id)
   ) SELECT p.s,e.entries,e.owners,e.owned,e.value,
    EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND r.asset<>'chips'),
    k.changed,k.returned
   FROM players p
   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club(r)) owners,
     min(public.fn_union_pnl_tournament_entry_club(r)::text)::uuid owned,sum(r.amount) value
    FROM public.tournament_participant_funding_receipts r
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
    WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND b.observed_at<p_at AND r.asset='chips') e
   CROSS JOIN LATERAL (SELECT COALESCE(bool_or(c.credited_club_id<>e.owned),false) changed,sum(c.amount) returned
    FROM credits c WHERE c.user_id=p.user_id
     AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
      WHERE r.registration_id=p.registration_id AND r.id=ANY(c.entry_receipt_ids)
       AND (NOT c.same_tournament OR r.tournament_id=(t->>'id')::uuid))) k
   ORDER BY p.ord
  LOOP
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',s->'id')); CONTINUE;
   END IF;
   IF changed THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_credit_owner_changed','registration_id',s->'id')); CONTINUE;
   END IF;
   value:=value-COALESCE(returned,0);
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','deferred_tournament_result','source_id',s->'id'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('status',CASE WHEN issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'boundary',p_at,
  'inventory',inv,'holdings',holdings,'issues',issues,'tournament_basis','original_realized_settlement_deferred_while_open');
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_resolved bigint:=0; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
 v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<>public.fn_union_week_start(p_start) OR p_end<>public.fn_union_week_start(p_start+interval '8 days')
  OR p_end>clock_timestamp() THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO v_fence FROM public.union_pnl_weekly_capture WHERE singleton;
 IF v_fence IS NULL OR p_start<=v_fence THEN
  RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
   'issues',jsonb_build_array('week_precedes_complete_original_capture'),'capture_started_at',v_fence,'all_players_included',false);
 END IF;
 -- UNION P&L EVIDENCE MEMO (20260928): one weekly close reaches this report
 -- through preparation (close quality), the cascade (qualified clubs, ECO,
 -- player P&L) and the invoices. Inside a union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin)
 -- the first complete report of this (union, week) is kept for the rest of
 -- the attempt; attempt_begin and attempt_end clear it and a rolled-back
 -- subtransaction forgets it with its settings. Everywhere else the report is
 -- proved on every call, exactly as before.
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  v_memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  v_memo:=NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb;
  IF v_memo ? v_memo_key THEN RETURN v_memo->v_memo_key; END IF;
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
 -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: count those through the partial index
 -- union_pnl_cash_outcomes_unaccepted, whose predicate is the last clause here.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
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
 -- The flow proof is read once; the P&L below reuses these exact rows.
 SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_basis_incomplete','count',v_bad)); END IF;
 -- Every touched tournament registration must have its original chip entry,
 -- including zero-rake players. Historical/current membership is never used.
 -- The week's registration events, each touched tournament's Union proved
 -- once through its own events (t.row_id::text equality kept; the uuid
 -- equality only lets the index find the same rows and is never attempted on
 -- a non-canonical id). The frame test is unchanged; i.observed_at repeats it
 -- because fn_union_pnl_inventory_observe, the only writer of framed events,
 -- stamps each event with its frame's observed_at (both tables immutable), so
 -- the same rows are reached through union_pnl_inventory_events_players_observed.
 WITH touched AS MATERIALIZED (
  SELECT i.row_id,COALESCE(i.after_row,i.before_row)->>'tournament_id' tournament_id
  FROM public.union_pnl_inventory_events i
  JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
  WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
   AND i.observed_at>=p_start AND i.observed_at<p_end
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
    AND t.row_id::text=d.tournament_id
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE NOT COALESCE(e.has_entry,false) OR COALESCE(e.has_other,false);
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
 WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
  AS f(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)),
 -- One read of the week's hands: each (club, player) delta total, and (kind 0)
 -- the hand count and accepted rake that used to cost two more reads.
 outcome_pass AS MATERIALIZED (
  SELECT x.kind,x.club_id,x.user_id,sum(x.delta) delta,count(*) hands,sum(x.rake) rake
  FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,(o.evidence->>'accepted_rake')::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p) x
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  GROUP BY x.kind,x.club_id,x.user_id
 ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
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
  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0),
  COALESCE((SELECT h.hands FROM outcome_pass h WHERE h.kind=0),0),(SELECT COALESCE(sum(h.rake),0) FROM outcome_pass h WHERE h.kind=0)
  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;
 IF v_accepted_rake IS DISTINCT FROM v_cash_rake THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_rake_does_not_match_original_earning_and_bank_basis'); END IF;
 IF NOT v_cash_reconciled THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'); END IF;
 v_report:=jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'issues',v_issues,'clubs',v_clubs,'opening_basis',v_open,'closing_basis',v_close,'eco_commercial_terms_evidence',v_eco,
  'accepted_cash_hands',v_hands,'accepted_cash_hands_resolved',v_resolved,'club_count',v_rows,'current_seats_used',false,'current_membership_used',false,
  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');
 IF v_memo_key IS NOT NULL THEN
  PERFORM set_config('app.union_pnl_evidence_memo',(COALESCE(NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb,'{}')
   ||jsonb_build_object(v_memo_key,v_report))::text,true);
 END IF;
 RETURN v_report;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_weekly_accounting_attempt_begin(p_memo boolean) RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 -- One close attempt of one book: its deadline, and (for a union) the
 -- earned-plan memo, both transaction-local and cleared by attempt_end.
 PERFORM set_config('app.weekly_accounting_scope_deadline',
  (clock_timestamp()+COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval)::text,true);
 PERFORM set_config('app.accounting_close_memo',CASE WHEN p_memo THEN 'on' ELSE '' END,true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
 PERFORM set_config('app.union_pnl_evidence_memo','',true);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_weekly_accounting_attempt_end() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 PERFORM set_config('app.weekly_accounting_scope_deadline','',true);
 PERFORM set_config('app.accounting_close_memo','',true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
 PERFORM set_config('app.union_pnl_evidence_memo','',true);
END $function$;

-- Production access, restated: owner only, as before.
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_attempt_begin(boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_attempt_end() FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '52682459bd047ad5aea7c454f3ae8c5e' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_boundary(uuid,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '3fda4fe97fac170716fef799ab6c5830' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure)) IS DISTINCT FROM '130c004569f961aa6f312c4f2ed15961' THEN RAISE EXCEPTION 'postimage mismatch: fn_weekly_accounting_attempt_begin(boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_end()'::regprocedure)) IS DISTINCT FROM '60f06cac8b45e49447155914600f7ca6' THEN RAISE EXCEPTION 'postimage mismatch: fn_weekly_accounting_attempt_end()' USING ERRCODE='55000'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'access mismatch: fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'access mismatch: fn_union_pnl_boundary(uuid,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'access mismatch: fn_weekly_accounting_attempt_begin(boolean)' USING ERRCODE='55000'; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_weekly_accounting_attempt_end()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'access mismatch: fn_weekly_accounting_attempt_end()' USING ERRCODE='55000'; END IF;
END $post$;
COMMIT;
