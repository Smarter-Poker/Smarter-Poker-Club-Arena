-- The original departed-seat wallet correction is part of cash P&L.
-- No ledger, wallet, outcome, inventory, certificate or membership is rewritten.
-- Native captured originals: 31 flows, 125.70 debits / 339.89 credits / +214.19.
-- The legacy hand key is proved through its final settlement, succeeded claim,
-- signed canonical hand and original funding owner. This is neither an ordinary
-- buy-in/return relabel nor a zero-valued exception. Every absent proof refuses.
-- Original refund, satellite, tournament and moved-seat routes are preserved.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure))='0ff6de5baff6a5939003718e6f6a5d90' AND md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))='4132bd1a9fadde8bb8ae40e5e493e155' AND md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))='b9acdceb99c92dc9c472eaa73b1194d8')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $precondition$
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'late_settlement_installation_requires_thawed_platform' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RAISE EXCEPTION 'original_weekly_accounting_operation_owns_reader_boundary' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN(
   'public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,
   'public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure,
   'public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)
   AND (pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'])) THEN
  RAISE EXCEPTION 'late_settlement_original_reader_owner_or_access_differs';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)')
   AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
   AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
 OR (SELECT count(*) FROM pg_proc WHERE oid IN(
   to_regprocedure('smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'),
   to_regprocedure('smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)'))
   AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}'
   AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']) IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'late_settlement_retained_bridge_authority_differs';END IF;
 IF to_regprocedure('public.fn_union_pnl_prove_late_settlement(uuid)') IS NOT NULL
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '4b8273549e5781ff321c8e26d5b9bb39'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '929cc88e98cd027e821f871f8adbe935'
  OR md5(pg_get_functiondef('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)'::regprocedure)) IS DISTINCT FROM '7e443fd75f3b1ece7cd0713a6b8fc0a5'
  OR md5(pg_get_functiondef('public.fn_pnl_evidence_cents(jsonb)'::regprocedure)) IS DISTINCT FROM '8d712bd799c3dfa691f2d8d9ff5101e8'
  OR md5(pg_get_functiondef('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'bb74ae7693dc40b812fce685cfc3c294'
  OR md5(pg_get_functiondef('public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure)) IS DISTINCT FROM '4d7431e0be2290bb7ebf84df286119d4'
  OR md5(pg_get_functiondef('smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb)'::regprocedure)) IS DISTINCT FROM '1b2960aedb5878428409fafb8242bb06'
  OR md5(pg_get_functiondef('smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)'::regprocedure)) IS DISTINCT FROM '9b34ace9a694e65a7bd0b3917c4a70fd'
 THEN RAISE EXCEPTION 'late settlement original proof dependency differs or already installed';END IF;
END $precondition$;
-- Read-only original evidence proof. No historical financial record is mutated.
-- A late departed-seat adjustment is a real wallet/felt movement, not a zero
-- movement and not an ordinary buy-in/cash-out. Its original hand proves it.
CREATE FUNCTION public.fn_union_pnl_prove_late_settlement(p_ledger_id uuid)
RETURNS TABLE(club_id uuid,user_id uuid,delta numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC'
AS $function$
BEGIN
 RETURN QUERY
 WITH original AS MATERIALIZED (
  SELECT q.* FROM public.union_pnl_original_flows q
  JOIN public.chip_ledger l ON l.id=q.ledger_id AND to_jsonb(l)=q.ledger_snapshot
  JOIN public.union_pnl_transaction_frames frame ON frame.transaction_id=q.transaction_id AND frame.observed_at=q.recognized_at
  WHERE q.ledger_id=p_ledger_id AND q.ledger_snapshot->>'status'='posted'
   AND q.ledger_snapshot->>'category'='settlement' AND q.ledger_snapshot->>'row_hash' IS NOT NULL
   AND q.game_scope ?& ARRAY['host_club_id','game_union_id','asset','unit_scale','is_private','tournament_id']
   AND jsonb_typeof(q.game_scope->'is_private')='boolean'
   AND q.game_scope->'tournament_id'='null'::jsonb
   AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND q.ledger_snapshot->>'idempotency_key' LIKE 'late_seat_settle:%'
 ), linked AS MATERIALIZED (
  SELECT q.*,s.id settlement_id,s.hand_id legacy_id,s.totals,
   a.*,o.evidence,o.game_scope outcome_scope,
   live.hand_id live_hand_id,live.payload_hash live_payload_hash,live.stack_result live_stack_result,
   live.post_commit_completed_at live_completed_at,live.post_commit_result live_postcommit,
   cert.history_hand_id retained_hand_id,cert.manifest_id retained_manifest,cert.settled_at retained_completed_at,cert.hand_number retained_number,
   cert.original_result_sha256 retained_result_sha,cert.original_request_sha256 retained_stack_request_sha,cert.accounting_evidence_sha256 retained_evidence_sha,
   v.accepted_request,v.participants original_participants,v.stack_claim,v.stack_settlement,v.manifest_id original_manifest,v.accepted_at original_accepted_at,
   smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result) claim_result,k.status claim_status
  FROM original q
  JOIN public.ca_settlements s ON s.id=(q.ledger_snapshot->>'settlement_id')::uuid
   AND s.table_id=(q.ledger_snapshot->>'table_id')::uuid
   AND s.settlement_type='hand_stacks' AND s.state='final' AND s.tournament_id IS NULL
  JOIN public.settlement_idempotency_keys k ON k.table_id=s.table_id AND k.hand_id=s.hand_id
  JOIN public.cash_hand_provenance_receipts v ON v.table_id=s.table_id AND v.hand_number=(k.result->>'hand_number')::bigint
  CROSS JOIN LATERAL jsonb_populate_record(NULL::public.hand_atomic_commits,v.atomic_receipt) a
  LEFT JOIN public.hand_atomic_commits live ON live.table_id=a.table_id AND live.hand_number=a.hand_number
  LEFT JOIN smarter_private.horse_settlement_key_certificates cert ON cert.table_id=s.table_id AND cert.stack_hand_id=s.hand_id
  JOIN public.union_pnl_cash_outcomes o ON o.table_id=a.table_id AND o.hand_number=a.hand_number
   AND o.hand_id=a.hand_id AND o.payload_hash=a.payload_hash AND public.fn_union_pnl_cash_outcome_accepted(o)
  WHERE q.game_scope=o.game_scope AND v.game_scope=o.game_scope
   AND v.hand_id=a.hand_id AND v.payload_hash=a.payload_hash AND v.table_id=a.table_id AND v.hand_number=a.hand_number
   AND s.hand_id=md5('ca-hand:'||s.table_id::text||':'||a.hand_number::text||
    CASE WHEN s.totals->>'ref' IS NULL OR s.totals->>'ref'='' THEN '' ELSE ':'||(s.totals->>'ref') END)::uuid
   AND q.ledger_snapshot->>'idempotency_key'='late_seat_settle:'||s.hand_id::text||':'||
    CASE WHEN q.ledger_snapshot->>'to_type'='player_wallet' THEN q.ledger_snapshot->>'to_entity_id'
      ELSE q.ledger_snapshot->>'from_entity_id' END
 ), witnessed AS (
  SELECT a.*,d.v departed,p.v participant,r.v signed_request,own.v owner,
   public.fn_pnl_evidence_cents(d.v->'delta') signed_delta,
   public.fn_pnl_evidence_cents(a.ledger_snapshot->'amount') amount
  FROM linked a
  CROSS JOIN LATERAL (SELECT x v FROM jsonb_array_elements(a.stack_result->'departed') x
   WHERE x->>'user_id'=CASE WHEN a.ledger_snapshot->>'to_type'='player_wallet' THEN a.ledger_snapshot->>'to_entity_id' ELSE a.ledger_snapshot->>'from_entity_id' END) d
  CROSS JOIN LATERAL (SELECT x v FROM jsonb_array_elements(a.original_participants) x
   WHERE x->>'user_id'=d.v->>'user_id') p
  CROSS JOIN LATERAL (SELECT x v FROM jsonb_array_elements(a.accepted_request->'stacks') x
   WHERE x->>'user_id'=d.v->>'user_id') r
  CROSS JOIN LATERAL (SELECT x v FROM jsonb_array_elements(a.evidence->'participants') x
   WHERE x->>'user_id'=d.v->>'user_id') own
 )
 SELECT (w.departed->>'club_id')::uuid,(w.departed->>'user_id')::uuid,w.signed_delta
 FROM witnessed w
 JOIN public.wallet_credit_idempotency credit ON credit.key=w.ledger_snapshot->>'idempotency_key'
  AND credit.user_id=(w.departed->>'user_id')::uuid AND credit.amount=w.signed_delta
 WHERE w.claim_status='succeeded' AND w.claim_result=w.stack_result
  AND w.stack_claim->'result'=w.stack_result AND w.stack_settlement->'totals'=w.totals
  AND w.totals->'departed'=w.stack_result->'departed'
  AND w.stack_result->'success'='true'::jsonb AND w.stack_result->'conservation_checked'='true'::jsonb
  AND w.accepted_request->>'table_id'=w.table_id::text
  AND w.accepted_request->>'hand_number'=w.hand_number::text
  AND public.fn_cash_signed_retained_request_matches(w.table_id,w.hand_number,w.payload_hash,w.accepted_request)
  AND (SELECT count(*) FROM jsonb_array_elements(w.stack_result#>'{request,stacks}') refs(v)
   WHERE refs.v->>'user_id'=w.departed->>'user_id' AND refs.v->>'seat_id'=w.departed->>'seat_id'
    AND refs.v->>'seat_joined_at'=w.departed->>'seat_joined_at'
    AND public.fn_pnl_evidence_cents(refs.v->'stack')=public.fn_pnl_evidence_cents(w.participant->'stack_after')
    AND public.fn_pnl_evidence_cents(refs.v->'stack_before')=public.fn_pnl_evidence_cents(w.participant->'stack_before'))=1
  AND (SELECT count(*) FROM jsonb_array_elements(w.stack_result->'departed') q(v) WHERE q.v->>'user_id'=w.departed->>'user_id')=1
  AND (SELECT count(*) FROM jsonb_array_elements(w.original_participants) q(v) WHERE q.v->>'user_id'=w.departed->>'user_id')=1
  AND (SELECT count(*) FROM jsonb_array_elements(w.accepted_request->'stacks') q(v) WHERE q.v->>'user_id'=w.departed->>'user_id')=1
  AND (SELECT count(*) FROM jsonb_array_elements(w.evidence->'participants') q(v) WHERE q.v->>'user_id'=w.departed->>'user_id')=1
  AND (SELECT count(*) FROM jsonb_array_elements_text(w.owner->'funding_receipt_ids'))=
      (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(w.owner->'funding_receipt_ids') refs(v))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.original_participants) q(v)
   WHERE public.fn_pnl_evidence_cents(q.v->'stack_before') IS NULL OR public.fn_pnl_evidence_cents(q.v->'stack_after') IS NULL
    OR public.fn_pnl_evidence_cents(q.v->'poker_delta') IS DISTINCT FROM
       public.fn_pnl_evidence_cents(q.v->'stack_after')-public.fn_pnl_evidence_cents(q.v->'stack_before'))
  AND (SELECT sum(public.fn_pnl_evidence_cents(q.v->'poker_delta')) FROM jsonb_array_elements(w.original_participants) q(v))
      +public.fn_pnl_evidence_cents(w.accepted_request->'rake')+public.fn_pnl_evidence_cents(w.accepted_request->'bbj')
      =public.fn_pnl_evidence_cents(w.accepted_request->'inflow')
  AND CASE WHEN w.live_hand_id IS NOT NULL THEN
   w.live_hand_id=w.hand_id AND w.live_payload_hash=w.payload_hash AND w.live_stack_result=w.stack_result
   AND w.live_completed_at IS NOT NULL AND isfinite(w.live_completed_at) AND w.live_postcommit->'ok'='true'::jsonb
  ELSE w.retained_hand_id=w.hand_id AND w.retained_manifest=w.original_manifest
   AND w.retained_number=w.hand_number AND w.retained_completed_at IS NOT NULL AND isfinite(w.retained_completed_at)
   AND w.retained_completed_at>=w.original_accepted_at AND w.retained_completed_at>=w.committed_at
   -- These digests name the full retained monetary original in provenance,
   -- never the compact key's JSON or a reconstructed expired raw hand.
   AND w.retained_result_sha=encode(extensions.digest(convert_to(w.stack_result::text,'UTF8'),'sha256'),'hex')
   AND w.retained_stack_request_sha=encode(extensions.digest(convert_to((w.stack_result->'request')::text,'UTF8'),'sha256'),'hex')
   AND w.retained_evidence_sha=encode(extensions.digest(convert_to(w.evidence::text,'UTF8'),'sha256'),'hex') END
  AND w.amount>0 AND w.signed_delta<>0 AND abs(w.signed_delta)=w.amount
  AND public.fn_cash_original_funding_lineage((w.participant->>'user_id')::uuid,w.table_id,
    (w.participant->>'seat_id')::uuid,(w.participant->>'occupancy_id')::uuid,
    (w.participant->>'seat_joined_at')::timestamptz,(w.participant#>>'{funding_lineage,observed_at}')::timestamptz,false)
      IS NOT DISTINCT FROM w.participant->'funding_lineage'
  AND w.participant#>'{funding_lineage,issues}'='[]'::jsonb
  AND (SELECT array_agg(refs.v->>'id' ORDER BY refs.v->>'id') FROM jsonb_array_elements(w.participant#>'{funding_lineage,funding_receipts}') refs(v))
      IS NOT DISTINCT FROM (SELECT array_agg(refs.v ORDER BY refs.v) FROM jsonb_array_elements_text(w.owner->'funding_receipt_ids') refs(v))
  AND w.participant->>'seat_id'=w.departed->>'seat_id'
  AND w.participant->>'seat_joined_at'=w.departed->>'seat_joined_at'
  AND w.signed_request->>'seat_id'=w.departed->>'seat_id'
  AND w.signed_request->>'seat_joined_at'=w.departed->>'seat_joined_at'
  AND public.fn_pnl_evidence_cents(w.participant->'stack_before') IS NOT NULL
  AND public.fn_pnl_evidence_cents(w.participant->'stack_after') IS NOT NULL
  AND public.fn_pnl_evidence_cents(w.participant->'stack_after')-public.fn_pnl_evidence_cents(w.participant->'stack_before')=w.signed_delta
  AND public.fn_pnl_evidence_cents(w.signed_request->'stack_before')=public.fn_pnl_evidence_cents(w.participant->'stack_before')
  AND public.fn_pnl_evidence_cents(w.signed_request->'stack')=public.fn_pnl_evidence_cents(w.participant->'stack_after')
  AND w.owner->'ownership_certified'='true'::jsonb
  AND w.owner->>'earning_club_id'=w.departed->>'club_id'
  AND w.owner->>'earning_club_id'=w.ledger_snapshot->>'club_id'
  AND public.fn_pnl_evidence_cents(w.owner->'observed_stack_delta')=w.signed_delta
  AND jsonb_array_length(w.owner->'funding_receipt_ids')>0
  AND (SELECT count(*) FROM jsonb_array_elements_text(w.owner->'funding_receipt_ids') refs(receipt_id)
    JOIN public.cash_participant_funding_receipts f ON f.id=refs.receipt_id::uuid WHERE f.operation_kind='buyin')=1
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(w.owner->'funding_receipt_ids') refs(receipt_id)
   LEFT JOIN public.cash_participant_funding_receipts f ON f.id=refs.receipt_id::uuid
   LEFT JOIN public.chip_ledger l ON l.id=f.source_ledger_id
   WHERE f.id IS NULL OR f.user_id IS DISTINCT FROM (w.departed->>'user_id')::uuid
    OR f.funding_club_id IS DISTINCT FROM (w.departed->>'club_id')::uuid
    OR f.funding_union_id::text IS DISTINCT FROM w.game_scope->>'game_union_id'
    OR f.account_type IS DISTINCT FROM 'player_wallet' OR f.account_entity_id IS DISTINCT FROM f.user_id
    OR f.asset IS DISTINCT FROM 'chips' OR f.unit_scale IS DISTINCT FROM 2
    OR f.amount<=0 OR f.amount IS NULL OR f.amount<>round(f.amount,2) OR f.amount::text IN('NaN','Infinity','-Infinity')
    OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount
    OR l.id IS NULL OR l.row_hash IS NULL OR l.status IS DISTINCT FROM 'posted' OR l.amount IS DISTINCT FROM f.amount
    OR l.club_id IS DISTINCT FROM f.funding_club_id OR l.from_type IS DISTINCT FROM f.account_type
    OR l.from_entity_id IS DISTINCT FROM f.user_id OR l.to_type IS DISTINCT FROM 'table_stack'
    OR l.to_entity_id IS DISTINCT FROM f.table_id OR l.category IS DISTINCT FROM f.operation_kind)
  AND CASE WHEN w.signed_delta>0 THEN
   w.ledger_snapshot->>'from_type'='table_stack' AND w.ledger_snapshot->>'from_entity_id'=w.table_id::text
   AND w.ledger_snapshot->>'to_type'='player_wallet' AND w.ledger_snapshot->>'to_entity_id'=w.departed->>'user_id'
  ELSE w.ledger_snapshot->>'from_type'='player_wallet' AND w.ledger_snapshot->>'from_entity_id'=w.departed->>'user_id'
   AND w.ledger_snapshot->>'to_type'='table_stack' AND w.ledger_snapshot->>'to_entity_id'=w.table_id::text END;
EXCEPTION WHEN SQLSTATE '55000' THEN
 IF SQLERRM='HORSE_SETTLEMENT_COMPACT_ORIGINAL_CONFLICT' THEN RETURN;END IF;RAISE;
WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN
 RETURN;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_prove_late_settlement(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   rf.refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta
  FROM originals q
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM public.fn_union_pnl_prove_late_settlement(CASE WHEN q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' THEN q.ledger_id END) p
  ) late ON true
  -- One-time filter (20261001): a probe only for the flows that can match.
  LEFT JOIN LATERAL (SELECT f.* FROM public.cash_participant_funding_receipts f
   WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true
  LEFT JOIN LATERAL (SELECT e.* FROM public.tournament_participant_funding_receipts e
   WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true
  -- fn_union_pnl_tournament_returns(q.tournament_id,NULL,p_start,p_end) for
  -- this flow's ledger only: its two branches verbatim, keyed by the ledger.
  LEFT JOIN LATERAL (
   SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount
   FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
   UNION ALL
   SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now
   FROM public.tournament_refund_tranches t
   JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
   WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
    AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c2 WHERE c2.ledger_id=t.credit_ledger_id)
  ) c ON true
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND r.operation_kind='buyin'
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
  -- A seat cashed out after it arrived by a table move holds chips whose
  -- original buy-in is on the source occupancy, not this one. The occupancy
  -- the cash-out vacated (its seat row in the same original transaction,
  -- carrying exactly the cashed-out stack) is traced through its move receipts
  -- by fn_cash_original_funding_lineage, the proof the boundaries and hands
  -- already use; the owner is its one original buy-in's club and player.
  LEFT JOIN LATERAL (
   SELECT CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.club END moved_club,
    CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.player END moved_user
   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
      AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id AND i.source_name='table_seats' AND i.before_row->>'table_id'=q.l->>'table_id'
      AND i.before_row->>'user_id'=q.l->>'to_entity_id' AND i.before_row->'left_at'='null'::jsonb
      AND i.after_row->>'left_at' IS NOT NULL) s
   CROSS JOIN LATERAL (SELECT public.fn_cash_original_funding_lineage((s.seat->>'user_id')::uuid,(s.seat->>'table_id')::uuid,(s.seat->>'id')::uuid,
     (s.seat->>'occupancy_id')::uuid,(s.seat->>'joined_at')::timestamptz,q.recognized_at,false) v) lin
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE r.operation_kind='buyin') buyins,count(DISTINCT r.funding_club_id) clubs,
     count(DISTINCT r.user_id) users,min(r.funding_club_id::text)::uuid club,min(r.user_id::text)::uuid player
    FROM jsonb_array_elements(lin.v->'funding_receipts') ref JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) own
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet' AND ret.owners IS DISTINCT FROM 1
    AND s.n=1 AND public.fn_pnl_evidence_cents(s.seat->'stack') IS NOT DISTINCT FROM (q.l->>'amount')::numeric
  ) mv ON true
  -- A pending add-on returned unapplied is a refund of this player's own
  -- escrowed chips. Its wallet credit can carry no refund category: it runs
  -- inside the hand's post-commit obligations, after atomic_distribute_rake
  -- has declared that transaction's ledger context, so the audit labels it
  -- player_funding under the rake settlement. The application receipt
  -- written in the same transaction proves it: exactly one refund of this
  -- amount from a funding receipt of this player, club and table.
  LEFT JOIN LATERAL (
   SELECT count(*) refunds,min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
   FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
   WHERE a.transaction_id=q.transaction_id AND a.refunded>0 AND a.refunded=(q.l->>'amount')::numeric
    AND a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
    AND o.table_id=(q.l->>'table_id')::uuid AND o.account_type='player_wallet' AND o.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND o.funding_club_id=(q.l->>'club_id')::uuid AND o.user_id=(q.l->>'to_entity_id')::uuid
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
    AND q.l->>'category'='player_funding'
  ) rf ON true
  -- A seat won in a satellite and later refunded by the target tournament
  -- (cancelled, or the seat released) pays the seat's value back to the
  -- player's wallet from the target's prize liability. That seat was never a
  -- wallet-funded entry of the target, so no tournament credit receipt exists
  -- for it; its proof is the refund entitlement the payout is keyed by: same
  -- tournament, player, wallet club and gross, and the seat's owning club as
  -- resolved from its satellite registration.
  LEFT JOIN LATERAL (
   SELECT t.id refund_ent,t.user_id refund_ent_user,t.refund_wallet_club_id refund_ent_club
   FROM public.tournament_refund_entitlements t
   WHERE q.tournament_id IS NOT NULL AND t.tournament_id=q.tournament_id
    AND q.l->>'idempotency_key'='tourney:'||t.tournament_id::text||':refund-entitlement:'||t.id::text
    AND t.entitlement_kind IN('satellite_seat','wallet_charge') AND t.gross=(q.l->>'amount')::numeric
    AND t.user_id::text=q.l->>'to_entity_id' AND t.refund_wallet_club_id::text=q.l->>'club_id'
    AND q.l->>'from_type'='prize_liability' AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='refund'
    AND CASE t.entitlement_kind
     WHEN 'satellite_seat' THEN public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
     -- A pre-capture wallet entry refunded by cancellation (20261006154000):
     -- its entitlement's source ledger is the entry proven at the opening
     -- boundary of the refund's own week, for this exact registration, club
     -- and gross.
     WHEN 'wallet_charge' THEN t.source_ledger_id IS NOT NULL AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=public.fn_union_week_start(q.recognized_at) AND r.union_id=p_union_id AND r.tournament_id=t.tournament_id AND r.user_id=t.user_id
        AND r.owning_club_id=t.refund_wallet_club_id AND r.entries=1 AND r.entry_amount=t.gross AND r.returned=0
        AND r.proof_md5=md5(r.proof::text)
        AND r.proof->'entry_ledger' @> jsonb_build_array(jsonb_build_object('ledger_id',t.source_ledger_id::text)))=1
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN late_count=1 THEN 'cash_late_settlement' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(late_club,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(late_user,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND owner_club::text=l->>'club_id' AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN cash_amount=(l->>'amount')::numeric AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected;
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_resolved bigint:=0; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
 v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];
 v_inv boolean; v_cash boolean; v_credit boolean;
 v_cert jsonb;
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
 -- UNION P&L NARROW READS (20260929044303): the week's registration events,
 -- hands and tournament credits are read through their narrow projections
 -- (union_pnl_inventory_touches, union_pnl_cash_outcome_touches,
 -- union_pnl_credit_touches), each written by its source row's own insert,
 -- once the throttled backfill has proved it complete; until then through
 -- the original wide rows, statement for statement as before.
 v_inv:=public.fn_union_pnl_projection_ready('inventory_touches');
 v_cash:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 v_credit:=public.fn_union_pnl_projection_ready('credit_touches');
 -- Both readers wait for the original book's in-flight transactions; this
 -- function is VOLATILE so every subsequent query sees their committed facts.
 -- CHUNKED CLOSE CERTIFICATES (20261003): inside a chunked union close attempt
 -- each expensive read below that found nothing wrong is kept, once proved,
 -- in accounting_close_certificates for the rest of that close of this
 -- closed week (fn_accounting_close_certificate / fn_accounting_close_certify;
 -- both do nothing anywhere else). An attempt whose time budget is spent
 -- after a step it had to prove returns 'warming' - not ready, nothing
 -- certified for payment - and the next attempt continues from the kept
 -- steps. A step that found a problem is kept for ONE HOUR (20261012), as
 -- '<kind>_problem' (fn_accounting_close_problem): it is never certified and
 -- never pays, its issues are reported exactly as before, and an attempt
 -- re-proves it once that hour has passed. Re-proving every problem step on
 -- every attempt is what held job 272's transactions for 3 to 5 minutes.
 v_open:=COALESCE(public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_start,p_start),
  public.fn_accounting_close_problem('pnl_boundary',p_union_id,p_start,p_start));
 IF v_open IS NULL THEN
  v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
  IF v_open->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_start,p_start,v_open);
  ELSE PERFORM public.fn_accounting_close_certify('pnl_boundary_problem',p_union_id,p_start,p_start,v_open); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 -- THE WINDOWS GO FIRST (20261012): the plan's two-hour windows (seconds each)
 -- are proved before the steps below, so an attempt that would otherwise
 -- spend its budget re-reading the boundaries and flows proves windows
 -- instead. Outside a chunked close the advance is NULL and nothing changes.
 IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 v_close:=COALESCE(public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_end,p_end),
  public.fn_accounting_close_problem('pnl_boundary',p_union_id,p_end,p_end));
 IF v_close IS NULL THEN
  v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
  IF v_close->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_end,p_end,v_close);
  ELSE PERFORM public.fn_accounting_close_certify('pnl_boundary_problem',p_union_id,p_end,p_end,v_close); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 IF v_open->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','opening_basis_incomplete','evidence',v_open)); END IF;
 IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 -- The registrations the opening boundary carried through a valid opening
 -- resolution (union_pnl_opening_registration_resolutions): each one's
 -- original entry is proved from the posted chip ledger, not a funding receipt.
 v_open_resolved:=ARRAY(SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  WHERE x->>'kind'='deferred_tournament_result' AND x->>'basis'='opening_registration_resolution');
 -- A blocked outcome counts as accepted only through an immutable resolution
 -- receipt re-proved from primary receipts and bound to this exact outcome
 -- (hand, payload hash, evidence). The outcome row itself is never changed.
 -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: those hands (the predicate of
 -- union_pnl_cash_outcomes_unaccepted), found through the projection's shape
 -- flag and re-checked against their rows, never the whole week's evidence.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.fn_union_pnl_week_shaped_hands(p_union_id,p_start,p_end,v_cash) o;
 -- A hand whose provenance link the engine never recorded (its outcome has no
 -- game scope) counts only through its immutable link resolution
 -- (union_pnl_cash_outcome_link_resolutions), in the Union its re-proved scope
 -- names, and is accepted only when its re-proved evidence is certified.
 SELECT v_bad+count(*) FILTER(WHERE NOT (k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)),
  v_resolved+count(*) FILTER(WHERE k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)
 INTO v_bad,v_resolved FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
 -- A missing original game scope cannot silently disappear from every Union.
 SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']
  AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes));
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
 v_cert:=COALESCE(public.fn_accounting_close_certificate('pnl_flows',p_union_id,p_start,p_end),
  public.fn_accounting_close_problem('pnl_flows',p_union_id,p_start,p_end));
 IF v_cert IS NOT NULL THEN
  v_bad:=(v_cert->>'bad')::bigint; v_flows:=v_cert->'flows';
 ELSE
 SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows));
  ELSE PERFORM public.fn_accounting_close_certify('pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
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
 -- Both reads (fn_union_pnl_touched_registrations, fn_union_pnl_tournament_in_union)
 -- come from union_pnl_inventory_touches once it is complete: the same keys,
 -- the frame's observed_at copied at capture, without the wide rows.
 v_cert:=COALESCE(public.fn_accounting_close_certificate('pnl_touched',p_union_id,p_start,p_end),
  public.fn_accounting_close_problem('pnl_touched',p_union_id,p_start,p_end));
 IF v_cert IS NOT NULL THEN
  v_bad:=(v_cert->>'bad')::bigint;
 ELSE
 WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);
  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_touched',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad));
  ELSE PERFORM public.fn_accounting_close_certify('pnl_touched_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad)); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_original_population_or_instrument_incomplete','count',v_bad)); END IF;
 -- An award must return to the original funding club; a changed credited
 -- wallet does not prove a new earning ownership agreement.
 -- The week's credits of this Union (its tournament snapshot's Union, its
 -- frame in the week) come from union_pnl_credit_touches once complete. The
 -- two whole-row resolutions (a whole-row value detoasts every snapshot of
 -- the credit) are asked only of a credit the entry test did not settle: the
 -- same conjunction, in an order the planner may not change.
 SELECT count(*) INTO v_bad FROM public.fn_union_pnl_week_union_credits(p_union_id,p_start,p_end,v_credit) w
 JOIN public.tournament_accounting_credit_receipts c ON c.id=w.credit_id
 WHERE CASE WHEN (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))
  THEN NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)
   AND NOT public.fn_union_pnl_award_satellite_owner(c) ELSE false END;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_award_original_earning_owner_incomplete','count',v_bad)); END IF;
 v_eco:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','eco_commercial_basis_incomplete','evidence',v_eco)); END IF;
 SELECT count(DISTINCT x->'terms') INTO v_bad FROM jsonb_array_elements(COALESCE(v_eco->'segments','[]')) x;
 IF v_bad<>1 THEN v_issues:=v_issues||jsonb_build_array('eco_intraweek_changed_terms_require_original_allocation'); END IF;
 v_terms_value:=v_eco#>'{segments,0,terms}';
 -- Validate every original bank/source leg even when the week has no rows.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan's
 -- two-hour windows are proved first, a few per attempt; until all are, the
 -- attempt stops warming (fn_accounting_union_earned_plan_advance is NULL,
 -- and this test passes, everywhere else).
 -- (THE WINDOWS GO FIRST, 20261012: the plan's windows are proved above,
 -- right after the opening boundary, before any step that can be re-proved.)
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 v_cert:=COALESCE(public.fn_accounting_close_certificate('pnl_clubs',p_union_id,p_start,p_end),
  public.fn_accounting_close_problem('pnl_clubs',p_union_id,p_start,p_end));
 IF v_cert IS NOT NULL THEN
  v_clubs:=v_cert->'clubs'; v_cash_reconciled:=(v_cert->>'cash_reconciled')::boolean; v_rows:=(v_cert->>'rows')::bigint;
  v_cash_rake:=(v_cert->>'cash_rake')::numeric; v_hands:=(v_cert->>'hands')::bigint; v_accepted_rake:=(v_cert->>'accepted_rake')::numeric;
 ELSE
 WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
  AS f(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)),
 -- One read of the week's hands: each (club, player) delta total, and (kind 0)
 -- the hand count and accepted rake that used to cost two more reads.
 outcome_pass AS MATERIALIZED (
  SELECT x.kind,x.club_id,x.user_id,sum(x.delta) delta,count(*) hands,sum(x.rake) rake
  FROM (SELECT h.hand_accepted_rake accepted_rake,h.hand_participants participants
   FROM public.fn_union_pnl_week_hand_lines(p_union_id,p_start,p_end,v_cash) h
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence->>'accepted_rake',k.evidence->'participants' FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,o.accepted_rake::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.participants,'[]')) p) x
  GROUP BY x.kind,x.club_id,x.user_id
 ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1
  -- JACKPOT SHARES ON THE FELT (20260929): a Bad Beat Jackpot share credited
  -- to a seat after its hand committed is that player's cash result too.
  UNION ALL SELECT a.club_id,a.user_id,a.amount FROM public.fn_union_pnl_week_bbj_stack_awards(p_union_id,p_start,p_end) a), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
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
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return','cash_late_settlement')) cash_flow,
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
  IF v_cash_reconciled AND v_accepted_rake IS NOT DISTINCT FROM v_cash_rake THEN
   PERFORM public.fn_accounting_close_certify('pnl_clubs',p_union_id,p_start,p_end,jsonb_build_object('clubs',v_clubs,
    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  ELSE
   PERFORM public.fn_accounting_close_certify('pnl_clubs_problem',p_union_id,p_start,p_end,jsonb_build_object('clubs',v_clubs,
    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  END IF;
 END IF;
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
DO $postcondition$
BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure)) IS DISTINCT FROM '0ff6de5baff6a5939003718e6f6a5d90'
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '4132bd1a9fadde8bb8ae40e5e493e155'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'b9acdceb99c92dc9c472eaa73b1194d8'
  OR EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure
     AND (pg_get_userbyid(proowner)<>'postgres' OR NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp','TimeZone=UTC']))
  OR has_function_privilege('anon','public.fn_union_pnl_prove_late_settlement(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_union_pnl_prove_late_settlement(uuid)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_union_pnl_prove_late_settlement(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'late_settlement_installed_postimage_or_access_differs';END IF;
END $postcondition$;
COMMIT;
