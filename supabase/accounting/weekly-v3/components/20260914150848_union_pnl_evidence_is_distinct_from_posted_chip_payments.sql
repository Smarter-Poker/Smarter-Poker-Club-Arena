-- Pure P&L evidence diagnostics only. No existing writer is replaced, no
-- payment is activated, and no historical snapshot/invoice is rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Pure diagnostics. These readers never calculate an amount to pay, establish
-- a baseline, bless historical membership, or alter an invoice/payment.
CREATE FUNCTION public.fn_pnl_evidence_cents(p_value jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v numeric;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
 v := (p_value#>>'{}')::numeric;
 IF v::text IN ('NaN','Infinity','-Infinity') OR v<>round(v,2) THEN RETURN NULL; END IF;
 RETURN v;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END $$;

CREATE FUNCTION public.fn_pnl_cash_hand_evidence(p_table_id uuid,p_hand_number bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.hand_atomic_commits%ROWTYPE; x jsonb; v_user uuid; v_hand uuid;
 v_before numeric; v_after numeric; v_delta numeric:=0; v_rake numeric; v_bbj numeric; v_inflow numeric;
 v_seen uuid[]:=ARRAY[]::uuid[]; v_people jsonb:='[]'; v_issues jsonb:='[]'; v_clubs jsonb;
 v_request jsonb; v_claim_count int; v_walk_count int;
BEGIN
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','atomic_hand_receipt_missing'); END IF;
 v_request:=a.stack_result->'request';
 IF a.committed_at IS NULL OR NOT isfinite(a.committed_at) OR a.stack_result->>'success' IS DISTINCT FROM 'true'
  OR a.stack_result->>'mode' IS DISTINCT FROM 'delta' OR jsonb_typeof(v_request->'stacks') IS DISTINCT FROM 'array'
 THEN RETURN jsonb_build_object('status','blocked','hand_id',a.hand_id,'reason','accepted_delta_request_missing'); END IF;
 IF jsonb_array_length(v_request->'stacks')=0 THEN
  RETURN jsonb_build_object('status','blocked','hand_id',a.hand_id,'reason','accepted_delta_roster_empty'); END IF;
 IF NOT (a.stack_result ? 'tournament_id') OR a.stack_result->>'tournament_id' IS NOT NULL THEN
  RETURN jsonb_build_object('status','blocked','hand_id',a.hand_id,'reason','cash_hand_scope_unproven_or_tournament_play_chips'); END IF;
 BEGIN v_hand:=(a.stack_result->>'hand_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN v_hand:=NULL; END;
 SELECT count(*) INTO v_claim_count FROM public.settlement_idempotency_keys k
  WHERE k.table_id=p_table_id AND k.hand_id=v_hand AND k.status='succeeded'
   AND k.completed_at IS NOT NULL AND k.result=a.stack_result;
 SELECT count(*) INTO v_walk_count FROM public.ca_settlements s
  WHERE s.settlement_type='hand_stacks' AND s.table_id=p_table_id AND s.hand_id=v_hand AND s.state='final';
 IF v_claim_count<>1 OR v_walk_count<>1 THEN v_issues:=v_issues||'"accepted_stack_receipt_link_missing"'::jsonb; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(v_request->'stacks') LOOP
  BEGIN v_user:=(x->>'user_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN v_user:=NULL; END;
  v_before:=public.fn_pnl_evidence_cents(x->'stack_before');
  v_after:=public.fn_pnl_evidence_cents(x->'stack');
  IF v_user IS NULL OR v_user=ANY(v_seen) OR v_before IS NULL OR v_after IS NULL OR v_before<0 OR v_after<0 THEN
   RETURN jsonb_build_object('status','blocked','hand_id',a.hand_id,'reason','invalid_or_duplicate_delta_participant'); END IF;
  v_seen:=array_append(v_seen,v_user); v_delta:=v_delta+v_after-v_before;
  -- Rake attribution is corroboration only. Zero-rake hands and players who
  -- contributed nothing must never disappear or inherit another player's club.
  SELECT COALESCE(jsonb_agg(DISTINCT ra.club_id ORDER BY ra.club_id) FILTER(WHERE ra.club_id IS NOT NULL),'[]')
   INTO v_clubs FROM public.rake_attributions ra
   WHERE ra.hand_id=a.hand_id AND ra.player_id=v_user;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'observed_stack_delta',v_after-v_before,
   'earning_club_id',NULL,'ownership_certified',false,'corroborating_rake_clubs',v_clubs));
 END LOOP;
 v_rake:=public.fn_pnl_evidence_cents(v_request->'rake'); v_bbj:=public.fn_pnl_evidence_cents(v_request->'bbj');
 v_inflow:=public.fn_pnl_evidence_cents(v_request->'inflow');
 -- Explicit JSON null has the installed stack writer's COALESCE(...,0)
 -- meaning; an absent field or invalid numeric representation does not.
 IF v_request->'rake'='null'::jsonb THEN v_rake:=0; END IF;
 IF v_request->'bbj'='null'::jsonb THEN v_bbj:=0; END IF;
 IF v_request->'inflow'='null'::jsonb THEN v_inflow:=0; END IF;
 IF v_rake IS NULL OR v_bbj IS NULL OR v_inflow IS NULL OR v_rake<0 OR v_bbj<0 OR v_inflow<0 THEN
  v_issues:=v_issues||'"hand_conservation_inputs_missing"'::jsonb;
 ELSIF v_delta+v_rake+v_bbj<>v_inflow THEN v_issues:=v_issues||'"hand_delta_conservation_mismatch"'::jsonb; END IF;
 -- The installed writer strips participant club/union/asset ownership from
 -- its canonical request. Arbitrary additional JSON keys cannot certify it.
 v_issues:=v_issues||'["participant_earning_ownership_receipt_missing","historical_game_asset_and_union_receipt_missing"]'::jsonb;
 RETURN jsonb_build_object('status','blocked','basis_certified',false,'hand_id',a.hand_id,'table_id',p_table_id,
  'hand_number',p_hand_number,'observed_commit_at',a.committed_at,'observed_delta_total',v_delta,
  'participants',v_people,'issues',v_issues,'current_seats_used',false,'current_membership_used',false,'all_players_included',true);
END $$;

CREATE FUNCTION public.fn_union_pnl_posted_payment_evidence(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.union_pnl_settlements%ROWTYPE; s public.ca_settlements%ROWTYPE;
 v_count int; v_expected int:=0; v_actual int; v_net numeric; v_collect numeric:=0; v_pay numeric:=0;
 v_club uuid; v_seen uuid[]:=ARRAY[]::uuid[]; x jsonb; v_legs jsonb:='[]'; v_ids jsonb; v_issues jsonb:='[]';
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<=p_start THEN
  RAISE EXCEPTION 'invalid_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM public.union_pnl_settlements
  WHERE union_id=p_union_id AND period_start=p_start AND period_end=p_end AND status='settled';
 IF v_count<>1 THEN RETURN jsonb_build_object('status',CASE WHEN v_count=0 THEN 'not_posted' ELSE 'unverified' END,
  'settled_in_chips',false,'basis_certified',false,'reason','exact_settled_pnl_claim_missing_or_ambiguous','claim_count',v_count); END IF;
 SELECT * INTO c FROM public.union_pnl_settlements
  WHERE union_id=p_union_id AND period_start=p_start AND period_end=p_end AND status='settled';
 IF c.settled_at IS NULL OR NOT isfinite(c.settled_at) OR c.total_unpaid IS DISTINCT FROM 0
  OR public.fn_pnl_evidence_cents(to_jsonb(c.total_collected)) IS NULL OR c.total_collected<0
  OR public.fn_pnl_evidence_cents(to_jsonb(c.total_paid)) IS NULL OR c.total_paid<0
  OR jsonb_typeof(c.club_results) IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('status','unverified','settled_in_chips',false,'basis_certified',false,'claim_id',c.id,'reason','invalid_or_partial_pnl_claim'); END IF;
 SELECT count(*) INTO v_count FROM public.ca_settlements
  WHERE settlement_type='union_player_pnl' AND union_id=p_union_id
   AND idempotency_key='pnl:'||p_union_id::text||':'||extract(epoch FROM p_start)::bigint::text AND state='final';
 IF v_count<>1 THEN RETURN jsonb_build_object('status','unverified','settled_in_chips',false,'basis_certified',false,
  'claim_id',c.id,'reason','final_pnl_posting_receipt_missing_or_ambiguous'); END IF;
 SELECT * INTO s FROM public.ca_settlements WHERE settlement_type='union_player_pnl' AND union_id=p_union_id
  AND idempotency_key='pnl:'||p_union_id::text||':'||extract(epoch FROM p_start)::bigint::text AND state='final';
 FOR x IN SELECT value FROM jsonb_array_elements(c.club_results) LOOP
  BEGIN v_club:=(x->>'club_id')::uuid; EXCEPTION WHEN invalid_text_representation THEN v_club:=NULL; END;
  v_net:=public.fn_pnl_evidence_cents(x->'net');
  IF v_club IS NULL OR v_club=ANY(v_seen) OR v_net IS NULL THEN
   RETURN jsonb_build_object('status','unverified','settled_in_chips',false,'basis_certified',false,'claim_id',c.id,'reason','invalid_or_duplicate_club_obligation'); END IF;
  v_seen:=array_append(v_seen,v_club);
  IF v_net=0 THEN CONTINUE; END IF;
  v_expected:=v_expected+1; v_collect:=v_collect+greatest(-v_net,0); v_pay:=v_pay+greatest(v_net,0);
  SELECT count(*),COALESCE(jsonb_agg(l.id ORDER BY l.id),'[]') INTO v_count,v_ids
   FROM public.chip_ledger l JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
   WHERE l.settlement_id=s.id::text AND l.club_id=v_club AND l.union_id=p_union_id
    AND l.category='pnl_settlement' AND l.status='posted' AND l.amount=abs(v_net)
    AND l.from_type=CASE WHEN v_net<0 THEN 'club_treasury' ELSE 'union_wallet' END
    AND l.from_entity_id=CASE WHEN v_net<0 THEN v_club ELSE p_union_id END
    AND l.to_type=CASE WHEN v_net<0 THEN 'union_wallet' ELSE 'club_treasury' END
    AND l.to_entity_id=CASE WHEN v_net<0 THEN p_union_id ELSE v_club END
    AND public.fn_pnl_evidence_cents(to_jsonb(CASE WHEN v_net<0 THEN l.pre_from_balance ELSE l.pre_to_balance END)) IS NOT NULL
    AND public.fn_pnl_evidence_cents(to_jsonb(CASE WHEN v_net<0 THEN l.post_from_balance ELSE l.post_to_balance END)) IS NOT NULL
    AND CASE WHEN v_net<0 THEN l.pre_from_balance ELSE l.pre_to_balance END>=0
    AND CASE WHEN v_net<0 THEN l.post_from_balance ELSE l.post_to_balance END>=0
    AND CASE WHEN v_net<0 THEN l.post_from_balance-l.pre_from_balance ELSE l.post_to_balance-l.pre_to_balance END=v_net
    AND i.club_id=v_club AND i.status='paid' AND i.chips_transferred AND i.message_sent
    AND i.from_entity_type=CASE WHEN v_net<0 THEN 'club' ELSE 'union' END
    AND i.from_entity_id=CASE WHEN v_net<0 THEN v_club ELSE p_union_id END::text
    AND i.to_entity_type=CASE WHEN v_net<0 THEN 'union' ELSE 'club' END
    AND i.to_entity_id=CASE WHEN v_net<0 THEN p_union_id ELSE v_club END::text
    AND i.gross_amount=abs(v_net) AND i.net_amount=abs(v_net) AND i.deductions=0;
  v_legs:=v_legs||jsonb_build_array(jsonb_build_object('club_id',v_club,'claimed_net',v_net,
   'verified_posted_net',CASE WHEN v_count=1 THEN v_net ELSE NULL END,'posted_receipt_count',v_count,'source_ledger_ids',v_ids));
  IF v_count<>1 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','club_posted_payment_receipt_missing_or_ambiguous','club_id',v_club)); END IF;
 END LOOP;
 SELECT count(*) INTO v_actual FROM public.chip_ledger WHERE settlement_id=s.id::text AND category='pnl_settlement';
 IF v_actual<>v_expected OR v_collect<>c.total_collected OR v_pay<>c.total_paid
  OR public.fn_pnl_evidence_cents(s.totals->'collected') IS DISTINCT FROM v_collect
  OR public.fn_pnl_evidence_cents(s.totals->'paid') IS DISTINCT FROM v_pay
  OR public.fn_pnl_evidence_cents(s.totals->'unpaid') IS DISTINCT FROM 0::numeric
 THEN v_issues:=v_issues||'"pnl_posting_totals_or_leg_count_mismatch"'::jsonb; END IF;
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(v_issues)=0 THEN 'verified' ELSE 'unverified' END,
  'settled_in_chips',jsonb_array_length(v_issues)=0 AND v_expected>0,'basis_certified',false,
  'claim_id',c.id,'posting_id',s.id,'no_chip_movement',v_expected=0,'clubs',v_legs,'issues',v_issues);
END $$;

CREATE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb; v_flows jsonb; v_payments jsonb;
 v_refunds jsonb; v_unknown jsonb; v_open_count int; v_close_count int;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<'2026-09-07 07:00:00+00'::timestamptz OR p_end<=p_start OR p_end>statement_timestamp()
  OR p_end-p_start>interval '8 days' THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('id',id,'period_start',period_start,'period_end',period_end,
  'status',status,'club_results',club_results) ORDER BY id),'[]') INTO v_open_count,v_open
  FROM public.union_pnl_settlements WHERE union_id=p_union_id AND period_end=p_start AND status IN('baseline','settled');
 SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('id',id,'period_start',period_start,'period_end',period_end,
  'status',status,'club_results',club_results) ORDER BY id),'[]') INTO v_close_count,v_close
  FROM public.union_pnl_settlements WHERE union_id=p_union_id AND period_end=p_end AND status IN('baseline','settled');
 v_issues:='["canonical_pnl_coverage_manifest_missing","boundary_snapshot_provenance_missing","participant_earning_ownership_receipt_missing","historical_game_asset_and_union_coverage_missing","tournament_earning_and_open_equity_basis_uncertified","eco_commercial_basis_uncertified"]'::jsonb;
 IF v_open_count<>1 THEN v_issues:=v_issues||jsonb_build_array(CASE WHEN v_open_count=0 THEN 'exact_opening_snapshot_missing' ELSE 'exact_opening_snapshot_ambiguous' END); END IF;
 IF v_close_count<>1 THEN v_issues:=v_issues||jsonb_build_array(CASE WHEN v_close_count=0 THEN 'exact_closing_snapshot_missing' ELSE 'exact_closing_snapshot_ambiguous' END); END IF;
 -- Recorded journal ownership is useful cash-flow evidence, not proof of
 -- the complete player-profit population or original tournament earning club.
 WITH observed AS MATERIALIZED (
  SELECT l.*,CASE
   WHEN l.from_type='player_wallet' AND l.to_type='prize_liability' AND l.category IN('tournament_buyin','rebuy','addon') THEN 'tournament_wallet_funding'
   WHEN l.from_type='prize_liability' AND l.to_type='player_wallet' AND l.category='refund' THEN 'tournament_wallet_refund'
   WHEN l.from_type='prize_liability' AND l.to_type='player_wallet' AND l.category IN('prize','bounty') THEN 'tournament_wallet_award'
   WHEN l.from_type='player_wallet' AND l.category IN('buyin','rebuy','addon') AND l.tournament_id IS NULL THEN 'cash_wallet_funding'
   WHEN l.to_type='player_wallet' AND l.category='cashout' AND l.tournament_id IS NULL THEN 'cash_wallet_return'
   ELSE 'unclassified_player_movement' END AS evidence_kind
  FROM public.chip_ledger l WHERE l.union_id=p_union_id AND l.created_at>=p_start AND l.created_at<p_end
   AND (l.from_type='player_wallet' OR l.to_type='player_wallet')
 ), grouped AS (
  SELECT club_id,evidence_kind,count(*) AS observed_rows,
   count(*) FILTER(WHERE status='posted' AND public.fn_pnl_evidence_cents(to_jsonb(amount))>=0) AS posted_rows,
   sum(amount) FILTER(WHERE status='posted' AND public.fn_pnl_evidence_cents(to_jsonb(amount))>=0) AS observed_posted_amount
   FROM observed GROUP BY club_id,evidence_kind
 ) SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY club_id,evidence_kind),'[]') INTO v_flows FROM grouped g;
 WITH issues AS (
  SELECT l.id,l.club_id,l.category,l.status,
   CASE WHEN l.club_id IS NULL THEN 'recorded_wallet_club_missing'
    WHEN l.status<>'posted' OR l.status IS NULL THEN 'player_journal_not_posted'
    WHEN public.fn_pnl_evidence_cents(to_jsonb(l.amount)) IS NULL OR l.amount<0 THEN 'invalid_player_journal_amount'
    ELSE 'player_movement_requires_category_basis' END AS reason
   FROM public.chip_ledger l WHERE l.union_id=p_union_id AND l.created_at>=p_start AND l.created_at<p_end
    AND (l.from_type='player_wallet' OR l.to_type='player_wallet')
    AND (l.club_id IS NULL OR l.status IS DISTINCT FROM 'posted' OR public.fn_pnl_evidence_cents(to_jsonb(l.amount)) IS NULL
     OR l.amount<0 OR l.category IS NULL OR l.category NOT IN('buyin','cashout','tournament_buyin','rebuy','addon','prize','bounty','refund')
     OR NOT (
      (l.from_type='player_wallet' AND l.to_type='prize_liability' AND l.category IN('tournament_buyin','rebuy','addon'))
      OR (l.from_type='prize_liability' AND l.to_type='player_wallet' AND l.category IN('refund','prize','bounty'))
      OR (l.from_type='player_wallet' AND l.tournament_id IS NULL AND l.category IN('buyin','rebuy','addon'))
      OR (l.to_type='player_wallet' AND l.tournament_id IS NULL AND l.category='cashout')))
 ) SELECT jsonb_build_object('count',count(*),'first_source_ids',COALESCE((SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT * FROM issues ORDER BY id LIMIT 100) q),'[]')) INTO v_unknown FROM issues;
 -- A refund is a return of original funding, not winnings. Count it only
 -- once, by the immutable tranche's exact debit/credit and original club.
 WITH proofs AS (
  SELECT tr.wallet_transaction_id,tr.entitlement_id,tr.credit_ledger_id,tr.tournament_id,tr.user_id,
   tr.source_wallet_club_id AS recorded_funding_club_id,tr.amount_paid_now,
   (e.id IS NOT NULL AND e.entitlement_kind='wallet_charge' AND e.tournament_id=tr.tournament_id AND e.user_id=tr.user_id
    AND e.refund_wallet_club_id=tr.source_wallet_club_id
    AND debit.status='posted' AND debit.club_id=e.refund_wallet_club_id AND debit.tournament_id=e.tournament_id
    AND debit.from_type='player_wallet' AND debit.from_entity_id=e.user_id
    AND debit.to_type='prize_liability' AND debit.to_entity_id=e.tournament_id AND debit.category=e.charge_category AND debit.amount=e.gross
    AND public.fn_pnl_evidence_cents(to_jsonb(e.gross))>0
    AND credit.status='posted' AND credit.club_id=tr.source_wallet_club_id AND credit.tournament_id=tr.tournament_id
    AND credit.from_type='prize_liability' AND credit.from_entity_id=tr.tournament_id
    AND credit.to_type='player_wallet' AND credit.to_entity_id=tr.user_id
    AND credit.category='refund' AND credit.amount=tr.amount_paid_now AND public.fn_pnl_evidence_cents(to_jsonb(tr.amount_paid_now))>0
    AND credit.created_at=tr.created_at AND credit.union_id IS NOT DISTINCT FROM debit.union_id
    AND (SELECT count(*) FROM public.tournament_refund_tranches duplicate WHERE duplicate.credit_ledger_id=tr.credit_ledger_id)=1
    AND tr.refund_prize>=0 AND tr.refund_bounty>=0 AND tr.refund_fee>=0
    AND tr.refund_prize+tr.refund_bounty+tr.refund_fee=tr.amount_paid_now) IS TRUE AS exact_wallet_refund_proof
  FROM public.tournament_refund_tranches tr
  LEFT JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
  LEFT JOIN public.chip_ledger debit ON debit.id=e.source_ledger_id
  LEFT JOIN public.chip_ledger credit ON credit.id=tr.credit_ledger_id
  WHERE tr.created_at>=p_start AND tr.created_at<p_end AND (debit.union_id=p_union_id OR credit.union_id=p_union_id)
 ) SELECT jsonb_build_object('count',count(*),'verified_wallet_refunds',count(*) FILTER(WHERE exact_wallet_refund_proof),
  'unverified_count',count(*) FILTER(WHERE NOT exact_wallet_refund_proof),
  'first_receipts',COALESCE((SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT * FROM proofs ORDER BY wallet_transaction_id LIMIT 100) q),'[]')) INTO v_refunds FROM proofs;
 IF (v_unknown->>'count')::int>0 THEN v_issues:=v_issues||'"player_journal_evidence_gaps"'::jsonb; END IF;
 IF (v_refunds->>'unverified_count')::int>0 THEN v_issues:=v_issues||'"tournament_refund_proof_missing_or_instrument_requires_separate_accounting"'::jsonb; END IF;
 v_payments:=public.fn_union_pnl_posted_payment_evidence(p_union_id,p_start,p_end);
 RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
  'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',v_issues,
  'opening_snapshot_candidates',v_open,'closing_snapshot_candidates',v_close,
  'observed_journal_flows',v_flows,'player_journal_gaps',v_unknown,'tournament_refund_evidence',v_refunds,
  'posted_pnl_payment_evidence',v_payments,'player_pnl',NULL,'eco_amount',NULL,
  'current_seats_used',false,'current_membership_used',false,'all_players_included',true,
  'coverage_note','Recorded-union journal evidence is partial discovery. Missing union stamps and zero-rake hands remain unproved; absence is never zero activity.');
END $$;

REVOKE ALL ON FUNCTION public.fn_pnl_evidence_cents(jsonb),
 public.fn_pnl_cash_hand_evidence(uuid,bigint),
 public.fn_union_pnl_posted_payment_evidence(uuid,timestamptz,timestamptz),
 public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint),
 public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) TO service_role;
COMMENT ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) IS
 'Read-only evidence and explicit gaps. Never a payout plan, baseline certificate, ECO rate approval, or authority to settle. Every player includes horses.';

COMMIT;
