-- A redeemed noncash ticket refunded to its player's wallet is an original
-- tournament return. Prove its award, issue, admission and exact disposition;
-- a kind label alone is not evidence. No money or certificate is written.
-- @live-proof: md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))='f85d5f26253365ec1052b74ed23a14cc' AND md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))='b87c67498a800464fb3d8f3558b8eefa' AND md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))='2c6795299ab0fd50fc2848e2b5fa19fb' AND md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure))='06a789f7d4d680e7bc71ddf72b8216b9' AND smarter_private.original_inventory_proof_sources_match() IS TRUE
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $install$
DECLARE flow text; guard text; changed text; newhash text; win text; advance text; ticket_arm text;
BEGIN
 SELECT pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure) INTO flow;
 SELECT pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure) INTO guard;
 SELECT pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure) INTO win;
 SELECT pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure) INTO advance;
 IF md5(win) IS DISTINCT FROM '8a625319f1aeeef9446feabff82262ef'
  OR md5(advance) IS DISTINCT FROM '64c67ea9c59eaa94d10eb7e0bff1ccdd' THEN
  RAISE EXCEPTION 'ticket_refund_window_source_preimage_changed' USING ERRCODE='55000'; END IF;
 IF md5(flow) IS DISTINCT FROM '09745f78c6cc2ae57f403419020fd1ab'
  OR md5(guard) IS DISTINCT FROM '7aadedcc005c7abeb827d712891df7e7'
  OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'ticket_refund_original_source_preimage_changed' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN(
   'public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure,
   'smarter_private.original_inventory_proof_sources_match()'::regprocedure,
   'smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure,
   'public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure)
  AND (p.proowner<>'postgres'::regrole OR p.proacl::text IS DISTINCT FROM CASE WHEN p.proname='fn_accounting_union_earned_plan_advance' THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END)) THEN
  RAISE EXCEPTION 'ticket_refund_original_source_metadata_changed' USING ERRCODE='55000'; END IF;
 changed:=replace(flow,$old$IN('satellite_seat','wallet_charge')$old$,$new$IN('satellite_seat','wallet_charge','tournament_ticket')$new$);
 ticket_arm:=$ticket_arm$     WHEN 'tournament_ticket' THEN t.charge_category='tournament_ticket'
      AND t.evidence_kind='atomic_tournament_ticket' AND t.escrow_bucket='ticket_gross'
      AND q.l->>'from_entity_id'=t.tournament_id::text
      AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets replacement WHERE replacement.source_refund_entitlement_id=t.id)
      AND (SELECT count(*) FROM public.tournament_refund_entitlements duplicate WHERE duplicate.source_ticket_id=t.source_ticket_id)=1
      AND (SELECT count(*) FROM public.tournament_refund_tranches tr
       WHERE tr.entitlement_id=t.id AND tr.credit_ledger_id=q.ledger_id AND tr.transaction_id=q.transaction_id
        AND tr.tournament_id=t.tournament_id AND tr.user_id=t.user_id AND tr.source_wallet_club_id=t.refund_wallet_club_id
        AND tr.idempotency_key=q.l->>'idempotency_key' AND tr.amount_paid_before=0 AND tr.amount_paid_now=t.gross
        AND tr.refund_prize=t.refund_prize AND tr.refund_bounty=t.refund_bounty AND tr.refund_fee=t.refund_fee)=1
      AND (SELECT count(*) FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=t.id)=1
      AND (SELECT count(*) FROM public.tournament_tickets tk
       JOIN public.chip_ledger admission ON admission.id=t.source_ledger_id
       JOIN public.tournament_satellite_awards a ON a.ticket_id=tk.id
       JOIN public.tournament_satellite_settlements h ON h.tournament_id=a.tournament_id
       JOIN public.tournament_payouts p ON p.id=a.payout_id
       JOIN public.chip_ledger issue ON issue.idempotency_key=a.idempotency_key||':ticket_escrow'
       WHERE tk.id=t.source_ticket_id AND tk.holder_id=t.user_id AND tk.club_id=t.refund_wallet_club_id
        AND tk.status='redeemed' AND tk.redemption_mode='tournament_entry_only' AND tk.cancelled_at IS NULL
        AND tk.value=t.gross AND tk.entry_prize=t.refund_prize AND tk.entry_bounty=t.refund_bounty AND tk.entry_fee=t.refund_fee
        AND t.gross=t.refund_prize+t.refund_bounty+t.refund_fee
        AND tk.source_tournament_id=t.tournament_id AND tk.source_satellite_id=t.source_satellite_id
        -- Only the original direct award is admitted here. A replacement
        -- ticket still requires its distinct original refund disposition.
        AND tk.source_refund_entitlement_id IS NULL
        AND a.tournament_id=tk.source_satellite_id AND a.place=tk.source_satellite_award_place
        AND a.user_id=t.user_id AND a.delivery_kind='ticket' AND a.amount=t.gross AND a.payout_source='satellite_ticket'
        AND p.tournament_id=a.tournament_id AND p.user_id=a.user_id AND p.amount=a.amount
        AND p.source=a.payout_source AND p.idempotency_key=a.idempotency_key
        AND (p.position=a.place OR h.receipt_version>=3)
        AND h.target_id=t.tournament_id AND h.ticket_cost=t.gross
        AND h.target_buy_in=tk.entry_prize+tk.entry_bounty AND h.target_fee=tk.entry_fee
        AND issue.status='posted' AND issue.category='ticket_issue' AND issue.amount=t.gross
        AND issue.club_id=tk.club_id AND issue.tournament_id=a.tournament_id
        AND issue.from_type='prize_liability' AND issue.from_entity_id=a.tournament_id
        AND issue.to_type='escrow' AND issue.to_entity_id=tk.id
        AND issue.metadata->>'kind'='direct_satellite_entry_ticket'
        AND issue.metadata->>'ticket_id'=tk.id::text AND issue.metadata->>'payout_id'=p.id::text
        AND issue.metadata->>'user_id'=t.user_id::text
        AND issue.metadata->>'satellite_target_id'=t.tournament_id::text
        AND COALESCE(issue.metadata->>'position',issue.metadata->>'award_slot')=a.place::text
        AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=a.idempotency_key)
        AND (SELECT count(*) FROM public.chip_transactions x
          WHERE x.transaction_type='tournament_ticket_issue' AND x.club_id=tk.club_id
           AND x.from_user_id IS NULL AND x.to_user_id=t.user_id AND x.amount=t.gross
           AND x.metadata->>'ticket_id'=tk.id::text AND x.metadata->>'ledger_id'=issue.id::text
           AND x.metadata->>'payout_id'=p.id::text AND x.metadata->>'idempotency_key'=a.idempotency_key
           AND x.metadata->>'source_tournament_id'=t.tournament_id::text
           AND x.metadata->>'source_satellite_id'=a.tournament_id::text
           AND x.metadata->>'source_award_place'=a.place::text)=1
        AND admission.status='posted' AND admission.category='ticket_redeem' AND admission.amount=t.gross
        AND admission.club_id=tk.club_id AND admission.tournament_id=t.tournament_id
        AND admission.from_type='escrow' AND admission.from_entity_id=tk.id
        AND admission.to_type='prize_liability' AND admission.to_entity_id=t.tournament_id
        AND admission.idempotency_key='ticket:'||tk.id::text||':tournament:'||t.tournament_id::text||':entry'
        AND admission.metadata->>'kind'='tournament_entry_ticket_admission'
        AND admission.metadata->>'ticket_id'=tk.id::text AND admission.metadata->>'user_id'=t.user_id::text
        AND admission.metadata->>'registration_id'=t.registration_id::text
        AND admission.metadata->>'source_tournament_id'=t.tournament_id::text
        AND admission.metadata->>'source_satellite_id'=t.source_satellite_id::text
        AND admission.metadata->'entry_prize'=to_jsonb(t.refund_prize)
        AND admission.metadata->'entry_bounty'=to_jsonb(t.refund_bounty)
        AND admission.metadata->'entry_fee'=to_jsonb(t.refund_fee))=1
$ticket_arm$;
 changed:=replace(changed,$old$     ELSE false END
  ) te ON true$old$,ticket_arm||$tail$     ELSE false END
  ) te ON true$tail$);
 IF changed=flow OR position($needle$WHEN 'tournament_ticket' THEN$needle$ IN changed)=0 THEN
  RAISE EXCEPTION 'ticket_refund_original_source_edit_missing' USING ERRCODE='55000'; END IF;
 EXECUTE changed;
 SELECT md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) INTO newhash;
 -- Both window freshness checks bind generation, so no cache is erased.
 -- Keep the bounded reader and its qualified parent source hash connected.
 win:=replace(win,$old$IN('satellite_seat','wallet_charge')$old$,$new$IN('satellite_seat','wallet_charge','tournament_ticket')$new$);
 win:=replace(win,$old$     ELSE false END
  ) te ON true$old$,ticket_arm||$tail$     ELSE false END
  ) te ON true$tail$);
 EXECUTE win;
 EXECUTE replace(advance,$old$'09745f78c6cc2ae57f403419020fd1ab'$old$,quote_literal(newhash));
 changed:=replace(guard,$old$'09745f78c6cc2ae57f403419020fd1ab'$old$,quote_literal(newhash));
 IF changed=guard THEN RAISE EXCEPTION 'ticket_refund_original_guard_edit_missing' USING ERRCODE='55000'; END IF;
 EXECUTE changed;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'ticket_refund_original_source_postimage_refused' USING ERRCODE='55000'; END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'f85d5f26253365ec1052b74ed23a14cc'
  OR md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)) IS DISTINCT FROM 'b87c67498a800464fb3d8f3558b8eefa'
  OR md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '2c6795299ab0fd50fc2848e2b5fa19fb'
  OR md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '06a789f7d4d680e7bc71ddf72b8216b9'
 THEN RAISE EXCEPTION 'ticket_refund_exact_postimage_changed' USING ERRCODE='55000'; END IF;
END $install$;
COMMIT;
