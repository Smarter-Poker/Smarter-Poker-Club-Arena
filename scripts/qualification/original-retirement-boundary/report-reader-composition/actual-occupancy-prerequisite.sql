-- @live-proof: md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))='b23655a15587192f137ae4ad57859742' AND md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))='c4ea982db893a45aade32874bd7cd495' AND md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure))='2627c8820e0147d5e91a2014415ec558' AND md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))='8734797c6093c7e5a2a72de9b387a6de'
-- Original return ownership still uses every original predicate. Candidate receipt
-- rows now come from those same original event/refund occupancy keys, avoiding
-- a global receipt scan per flow. No new index, eligibility or money operation.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';
DO $owner0$
DECLARE original text;before_meta jsonb;after_meta jsonb;
BEGIN
 IF public.fn_platform_frozen()THEN RAISE EXCEPTION 'original_flow_occupancy_install_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'INTO original,before_meta FROM pg_proc p WHERE p.oid='public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(original)IS DISTINCT FROM '0998b0c974aac59fbd4914eef394f1c7'THEN RAISE EXCEPTION 'original_flow_occupancy_preimage_changed:0';END IF;
 EXECUTE $qualified_owner0$CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
 ), rf_original_keys AS MATERIALIZED (
  SELECT DISTINCT q.transaction_id,(q.l->>'table_id')::uuid table_id,
   (q.l->>'club_id')::uuid club_id,(q.l->>'to_entity_id')::uuid user_id,(q.l->>'amount')::numeric amount
  FROM originals q
  WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
   AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
 ), rf_original_matches AS MATERIALIZED (
  SELECT k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount,count(*) refunds,
   min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
  FROM rf_original_keys k
  JOIN public.cash_funding_application_receipts a ON a.transaction_id=k.transaction_id
   AND a.refunded>0 AND a.refunded=k.amount
  JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
  WHERE a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
   AND o.table_id=k.table_id AND o.account_type='player_wallet' AND o.account_entity_id=k.user_id
   AND o.funding_club_id=k.club_id AND o.user_id=k.user_id
  GROUP BY k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount
 ), bbj_wallet_matches AS MATERIALIZED (
  SELECT q.ledger_id,(q.l->>'club_id')::uuid club_id,r.user_id,r.amount,b.id payout_id
  FROM originals q
  JOIN public.bbj_payouts b ON b.id=CASE WHEN q.l->>'idempotency_key' ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(q.l->>'idempotency_key',':',2)::uuid END
  JOIN public.bbj_payout_recipients r ON r.payout_id=b.id AND r.user_id=(q.l->>'to_entity_id')::uuid
  JOIN public.wallet_credit_idempotency w ON w.key=q.l->>'idempotency_key' AND w.user_id=r.user_id AND w.amount=r.amount
  JOIN public.bbj_pools pool ON pool.id=b.pool_id
  WHERE q.tournament_id IS NULL AND q.l->>'category'='bbj_payout' AND q.l->>'status'='posted'
   AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
   AND q.l->>'from_entity_id'=b.table_id::text AND q.l->>'table_id'=b.table_id::text
   AND q.l->>'id'=q.ledger_id::text AND q.l->>'idempotency_key'='bbj:'||b.id::text||':'||r.user_id::text
   AND q.game_scope->>'game_union_id'=p_union_id::text AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND (pool.union_id=p_union_id OR (pool.union_id IS NULL AND pool.club_id::text=q.game_scope->>'host_club_id'))
   AND b.kind IN('main','mini') AND b.total_amount>0 AND b.total_amount=round(b.total_amount,2)
   AND b.created_at<=q.recognized_at AND r.created_at=w.created_at AND w.created_at>=b.created_at AND w.created_at<=q.recognized_at
   AND (SELECT count(*) FROM public.bbj_payout_recipients unique_recipient WHERE unique_recipient.payout_id=b.id AND unique_recipient.user_id=r.user_id)=1
   AND r.amount=(q.l->>'amount')::numeric AND r.amount>0 AND r.amount=round(r.amount,2)
   AND r.amount::text NOT IN('NaN','Infinity','-Infinity')
   AND (SELECT count(*) FROM public.chip_transactions t WHERE t.transaction_type='bbj_payout' AND t.table_id=b.table_id
     AND t.to_user_id=r.user_id AND t.club_id=(q.l->>'club_id')::uuid AND t.amount=r.amount AND t.created_at=w.created_at)=1
   AND (SELECT count(*) FROM public.chip_ledger bank WHERE bank.status='posted' AND bank.category='bbj_payout'
     AND bank.from_type='bbj_pool' AND bank.from_entity_id=b.pool_id AND bank.to_type='table_stack' AND bank.to_entity_id=b.table_id
     AND bank.amount=b.total_amount AND bank.idempotency_key=CASE WHEN b.kind='mini' THEN 'bbj_mini:'||b.pool_id::text||':'||b.table_id::text||':'||b.hand_number::text ELSE 'bbj_payout:'||b.id::text END)=1
   AND (SELECT coalesce(sum(p.amount),0) FROM public.bbj_payout_recipients p WHERE p.payout_id=b.id)
      +(SELECT coalesce(sum(u.amount),0) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.paid_at IS NULL)=b.total_amount
   AND (NOT EXISTS(SELECT FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id)
     OR (SELECT count(*) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id AND u.amount=r.amount
       AND u.pool_id=b.pool_id AND u.table_id=b.table_id AND u.paid_at=w.created_at
       AND (SELECT count(*) FROM public.chip_ledger parked WHERE parked.status='posted' AND parked.category='bbj_payout'
         AND parked.from_type='table_stack' AND parked.from_entity_id=b.table_id AND parked.to_type='bbj_pool' AND parked.to_entity_id=b.pool_id
         AND parked.amount=r.amount AND parked.idempotency_key='bbj_park:bbj:'||b.id::text||':'||r.user_id::text)=1
       AND (SELECT count(*) FROM public.chip_ledger redeemed WHERE redeemed.status='posted' AND redeemed.category='bbj_payout'
         AND redeemed.from_type='bbj_pool' AND redeemed.from_entity_id=b.pool_id AND redeemed.to_type='table_stack' AND redeemed.to_entity_id=b.table_id
         AND redeemed.amount=r.amount AND redeemed.idempotency_key='bbj_redeem:'||b.id::text||':'||r.user_id::text)=1)=1)
 ), matched AS (
  SELECT q.*,gift.proof treasury_gift,returned.proof treasury_return,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta,j.club_id bbj_club,j.user_id bbj_user,j.payout_id bbj_payout
  FROM originals q
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_gift_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category'='horse_funding'
    AND q.l->>'from_type'='club_treasury' AND q.l->>'to_type'='table_stack') gift ON true
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_return_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category' IN('cashout','table_cashout','refund')
    AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet') returned ON true
  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p
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
   FROM (
    SELECT CASE WHEN COALESCE(i.after_row,i.before_row)->>'occupancy_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (COALESCE(i.after_row,i.before_row)->>'occupancy_id')::uuid END occupancy_id
    FROM public.union_pnl_inventory_events i
    WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=((q.l->>'table_id')::uuid)::text
    UNION
    SELECT original.occupancy_id FROM public.cash_funding_application_receipts a
     JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
     WHERE a.transaction_id=q.transaction_id AND a.refunded=(q.l->>'amount')::numeric
   ) original_occupancies
   JOIN public.cash_participant_funding_receipts r ON r.occupancy_id=original_occupancies.occupancy_id
   WHERE r.table_id=(q.l->>'table_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND ((r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid) OR (r.operation_kind='horse_funding' AND r.account_type='club_treasury' AND r.user_id=(q.l->>'to_entity_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)))
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
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE smarter_private.cash_initial_funding_receipt(r.id)) buyins,count(DISTINCT r.funding_club_id) clubs,
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
   SELECT r.refunds,r.club,r.player FROM rf_original_matches r
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
    AND r.transaction_id=q.transaction_id AND r.table_id=(q.l->>'table_id')::uuid
    AND r.club_id=(q.l->>'club_id')::uuid AND r.user_id=(q.l->>'to_entity_id')::uuid
    AND r.amount=(q.l->>'amount')::numeric
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
    AND t.entitlement_kind IN('satellite_seat','wallet_charge','tournament_ticket') AND t.gross=(q.l->>'amount')::numeric
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
     WHEN 'tournament_ticket' THEN t.charge_category='tournament_ticket'
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
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN bbj_payout IS NOT NULL THEN 'cash_return' WHEN late_count=1 THEN 'cash_late_settlement' WHEN treasury_gift->>'status'='proven' THEN 'cash_funding' WHEN treasury_return->>'status'='proven' THEN 'cash_return' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(bbj_club,late_club,(treasury_gift->>'earning_club')::uuid,(treasury_return->>'earning_club')::uuid,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(bbj_user,late_user,(treasury_gift->>'user_id')::uuid,(treasury_return->>'user_id')::uuid,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND (owner_club::text=l->>'club_id' OR (treasury_gift->>'status'='proven' AND treasury_gift->>'ledger_id'=ledger_id::text AND treasury_gift->>'sponsor_bank_club'=l->>'club_id' AND treasury_gift->>'earning_club'=owner_club::text)) AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN (cash_amount=(l->>'amount')::numeric OR (treasury_gift->>'status'='proven' AND (treasury_gift->>'amount')::numeric=(l->>'amount')::numeric)) AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN ((treasury_return->>'status'='proven' AND (treasury_return->>'amount')::numeric=(l->>'amount')::numeric) OR bbj_payout IS NOT NULL OR owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user)
     OR (l->>'category'='bbj_payout' AND bbj_payout IS NOT NULL AND bbj_club=owner_club AND bbj_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected
 UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end)
 UNION ALL SELECT * FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end);
$function$
$qualified_owner0$;
 SELECT to_jsonb(p)-'prosrc'INTO after_meta FROM pg_proc p WHERE p.oid='public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM 'b23655a15587192f137ae4ad57859742'THEN RAISE EXCEPTION 'original_flow_occupancy_postimage_changed:0';END IF;
END$owner0$;
DO $owner1$
DECLARE original text;before_meta jsonb;after_meta jsonb;
BEGIN
 IF public.fn_platform_frozen()THEN RAISE EXCEPTION 'original_flow_occupancy_install_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'INTO original,before_meta FROM pg_proc p WHERE p.oid='smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure;
 IF md5(original)IS DISTINCT FROM 'cefb154e19a245a5688dbc87fed141f5'THEN RAISE EXCEPTION 'original_flow_occupancy_preimage_changed:1';END IF;
 EXECUTE $qualified_owner1$CREATE OR REPLACE FUNCTION smarter_private.union_pnl_original_flow_evidence_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_window_start timestamp with time zone, p_window_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
   AND q.recognized_at>=p_window_start AND q.recognized_at<p_window_end
 ), rf_original_keys AS MATERIALIZED (
  SELECT DISTINCT q.transaction_id,(q.l->>'table_id')::uuid table_id,
   (q.l->>'club_id')::uuid club_id,(q.l->>'to_entity_id')::uuid user_id,(q.l->>'amount')::numeric amount
  FROM originals q
  WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
   AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
 ), rf_original_matches AS MATERIALIZED (
  SELECT k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount,count(*) refunds,
   min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
  FROM rf_original_keys k
  JOIN public.cash_funding_application_receipts a ON a.transaction_id=k.transaction_id
   AND a.refunded>0 AND a.refunded=k.amount
  JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
  WHERE a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
   AND o.table_id=k.table_id AND o.account_type='player_wallet' AND o.account_entity_id=k.user_id
   AND o.funding_club_id=k.club_id AND o.user_id=k.user_id
  GROUP BY k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount
 ), bbj_wallet_matches AS MATERIALIZED (
  SELECT q.ledger_id,(q.l->>'club_id')::uuid club_id,r.user_id,r.amount,b.id payout_id
  FROM originals q
  JOIN public.bbj_payouts b ON b.id=CASE WHEN q.l->>'idempotency_key' ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(q.l->>'idempotency_key',':',2)::uuid END
  JOIN public.bbj_payout_recipients r ON r.payout_id=b.id AND r.user_id=(q.l->>'to_entity_id')::uuid
  JOIN public.wallet_credit_idempotency w ON w.key=q.l->>'idempotency_key' AND w.user_id=r.user_id AND w.amount=r.amount
  JOIN public.bbj_pools pool ON pool.id=b.pool_id
  WHERE q.tournament_id IS NULL AND q.l->>'category'='bbj_payout' AND q.l->>'status'='posted'
   AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
   AND q.l->>'from_entity_id'=b.table_id::text AND q.l->>'table_id'=b.table_id::text
   AND q.l->>'id'=q.ledger_id::text AND q.l->>'idempotency_key'='bbj:'||b.id::text||':'||r.user_id::text
   AND q.game_scope->>'game_union_id'=p_union_id::text AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND (pool.union_id=p_union_id OR (pool.union_id IS NULL AND pool.club_id::text=q.game_scope->>'host_club_id'))
   AND b.kind IN('main','mini') AND b.total_amount>0 AND b.total_amount=round(b.total_amount,2)
   AND b.created_at<=q.recognized_at AND r.created_at=w.created_at AND w.created_at>=b.created_at AND w.created_at<=q.recognized_at
   AND (SELECT count(*) FROM public.bbj_payout_recipients unique_recipient WHERE unique_recipient.payout_id=b.id AND unique_recipient.user_id=r.user_id)=1
   AND r.amount=(q.l->>'amount')::numeric AND r.amount>0 AND r.amount=round(r.amount,2)
   AND r.amount::text NOT IN('NaN','Infinity','-Infinity')
   AND (SELECT count(*) FROM public.chip_transactions t WHERE t.transaction_type='bbj_payout' AND t.table_id=b.table_id
     AND t.to_user_id=r.user_id AND t.club_id=(q.l->>'club_id')::uuid AND t.amount=r.amount AND t.created_at=w.created_at)=1
   AND (SELECT count(*) FROM public.chip_ledger bank WHERE bank.status='posted' AND bank.category='bbj_payout'
     AND bank.from_type='bbj_pool' AND bank.from_entity_id=b.pool_id AND bank.to_type='table_stack' AND bank.to_entity_id=b.table_id
     AND bank.amount=b.total_amount AND bank.idempotency_key=CASE WHEN b.kind='mini' THEN 'bbj_mini:'||b.pool_id::text||':'||b.table_id::text||':'||b.hand_number::text ELSE 'bbj_payout:'||b.id::text END)=1
   AND (SELECT coalesce(sum(p.amount),0) FROM public.bbj_payout_recipients p WHERE p.payout_id=b.id)
      +(SELECT coalesce(sum(u.amount),0) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.paid_at IS NULL)=b.total_amount
   AND (NOT EXISTS(SELECT FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id)
     OR (SELECT count(*) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id AND u.amount=r.amount
       AND u.pool_id=b.pool_id AND u.table_id=b.table_id AND u.paid_at=w.created_at
       AND (SELECT count(*) FROM public.chip_ledger parked WHERE parked.status='posted' AND parked.category='bbj_payout'
         AND parked.from_type='table_stack' AND parked.from_entity_id=b.table_id AND parked.to_type='bbj_pool' AND parked.to_entity_id=b.pool_id
         AND parked.amount=r.amount AND parked.idempotency_key='bbj_park:bbj:'||b.id::text||':'||r.user_id::text)=1
       AND (SELECT count(*) FROM public.chip_ledger redeemed WHERE redeemed.status='posted' AND redeemed.category='bbj_payout'
         AND redeemed.from_type='bbj_pool' AND redeemed.from_entity_id=b.pool_id AND redeemed.to_type='table_stack' AND redeemed.to_entity_id=b.table_id
         AND redeemed.amount=r.amount AND redeemed.idempotency_key='bbj_redeem:'||b.id::text||':'||r.user_id::text)=1)=1)
 ), matched AS (
  SELECT q.*,gift.proof treasury_gift,returned.proof treasury_return,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta,j.club_id bbj_club,j.user_id bbj_user,j.payout_id bbj_payout
  FROM originals q
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_gift_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category'='horse_funding'
    AND q.l->>'from_type'='club_treasury' AND q.l->>'to_type'='table_stack') gift ON true
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_return_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category' IN('cashout','table_cashout','refund')
    AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet') returned ON true
  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p
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
   FROM (
    SELECT CASE WHEN COALESCE(i.after_row,i.before_row)->>'occupancy_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (COALESCE(i.after_row,i.before_row)->>'occupancy_id')::uuid END occupancy_id
    FROM public.union_pnl_inventory_events i
    WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=((q.l->>'table_id')::uuid)::text
    UNION
    SELECT original.occupancy_id FROM public.cash_funding_application_receipts a
     JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
     WHERE a.transaction_id=q.transaction_id AND a.refunded=(q.l->>'amount')::numeric
   ) original_occupancies
   JOIN public.cash_participant_funding_receipts r ON r.occupancy_id=original_occupancies.occupancy_id
   WHERE r.table_id=(q.l->>'table_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND ((r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid) OR (r.operation_kind='horse_funding' AND r.account_type='club_treasury' AND r.user_id=(q.l->>'to_entity_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)))
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
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE smarter_private.cash_initial_funding_receipt(r.id)) buyins,count(DISTINCT r.funding_club_id) clubs,
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
   SELECT r.refunds,r.club,r.player FROM rf_original_matches r
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
    AND r.transaction_id=q.transaction_id AND r.table_id=(q.l->>'table_id')::uuid
    AND r.club_id=(q.l->>'club_id')::uuid AND r.user_id=(q.l->>'to_entity_id')::uuid
    AND r.amount=(q.l->>'amount')::numeric
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
    AND t.entitlement_kind IN('satellite_seat','wallet_charge','tournament_ticket') AND t.gross=(q.l->>'amount')::numeric
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
     WHEN 'tournament_ticket' THEN t.charge_category='tournament_ticket'
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
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN bbj_payout IS NOT NULL THEN 'cash_return' WHEN late_count=1 THEN 'cash_late_settlement' WHEN treasury_gift->>'status'='proven' THEN 'cash_funding' WHEN treasury_return->>'status'='proven' THEN 'cash_return' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(bbj_club,late_club,(treasury_gift->>'earning_club')::uuid,(treasury_return->>'earning_club')::uuid,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(bbj_user,late_user,(treasury_gift->>'user_id')::uuid,(treasury_return->>'user_id')::uuid,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND (owner_club::text=l->>'club_id' OR (treasury_gift->>'status'='proven' AND treasury_gift->>'ledger_id'=ledger_id::text AND treasury_gift->>'sponsor_bank_club'=l->>'club_id' AND treasury_gift->>'earning_club'=owner_club::text)) AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN (cash_amount=(l->>'amount')::numeric OR (treasury_gift->>'status'='proven' AND (treasury_gift->>'amount')::numeric=(l->>'amount')::numeric)) AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN ((treasury_return->>'status'='proven' AND (treasury_return->>'amount')::numeric=(l->>'amount')::numeric) OR bbj_payout IS NOT NULL OR owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user)
     OR (l->>'category'='bbj_payout' AND bbj_payout IS NOT NULL AND bbj_club=owner_club AND bbj_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected
;
$function$
$qualified_owner1$;
 SELECT to_jsonb(p)-'prosrc'INTO after_meta FROM pg_proc p WHERE p.oid='smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM 'c4ea982db893a45aade32874bd7cd495'THEN RAISE EXCEPTION 'original_flow_occupancy_postimage_changed:1';END IF;
END$owner1$;
DO $owner2$
DECLARE original text;before_meta jsonb;after_meta jsonb;
BEGIN
 IF public.fn_platform_frozen()THEN RAISE EXCEPTION 'original_flow_occupancy_install_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'INTO original,before_meta FROM pg_proc p WHERE p.oid='public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(original)IS DISTINCT FROM 'c9c79cce604c8f481772149fa2538ab2'THEN RAISE EXCEPTION 'original_flow_occupancy_preimage_changed:2';END IF;
 EXECUTE $qualified_owner2$CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_advance(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE w record; r record; began timestamptz; proved boolean:=false;
 stop_at timestamptz; v_generation text; v_bad bigint; v_flows jsonb; v_windows bigint; v_fresh bigint;v_hand_projected boolean;v_hand_witness jsonb;v_hand_groups jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- THE STATEMENT'S OWN CLOCK (20261015b): an attempt can begin late in its
 -- tick (job 272 visits other scopes first in the same 240 s statement), so a
 -- proving loop also stops a minute before the statement itself would be
 -- cancelled, not only 120 s after the attempt began.
 stop_at:=began+interval '120 seconds';
 IF current_setting('statement_timeout') NOT IN ('0','0ms') THEN
  stop_at:=LEAST(stop_at,statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds');
 END IF;
 IF public.fn_accounting_close_certificate('earned_plan',p_union_id,p_start,p_end) IS NULL THEN
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime());
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
  IF NOT FOUND THEN
   -- v3 over the same window refuses exactly what it refuses in the week.
   PERFORM public.fn_accounting_union_earned_plan_v3(p_union_id,w.window_start,w.window_end);
   RAISE EXCEPTION 'union_earned_plan_window_unproved' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('union_id',p_union_id,'period_start',p_start,'period_end',p_end,'window_start',w.window_start,'window_end',w.window_end)::text;
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES('earned_plan_window',p_union_id,p_start,p_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 -- PROVING WINDOWS IS A WHOLE ATTEMPT (20261015): an attempt that proved a
 -- window ends here, even when it proved the last one, so the closing boundary
 -- and every later step start the next attempt with the whole budget.
 IF proved THEN RETURN false; END IF;
 END IF;
 -- THE WEEK'S ORIGINAL FLOWS ARE PROVED TWO HOURS AT A TIME (20261015b).
 -- fn_union_pnl_evidence_report proves the week's original money flows in one
 -- statement (814,510 flows for the 2026-10-05 week: 162 s alone, 2 GB of
 -- temporary files), which cannot fit an attempt of job 272's 240 s statement
 -- once the attempt's preparation and the tick's other scopes have run, so
 -- every attempt that reached it was cancelled and rolled back. The same proof
 -- is made here one plan window at a time (each flow is proved from its own
 -- row and the week's bounds, so the windows partition the week exactly), kept
 -- as partials like the earned-plan windows, and assembled into the very
 -- certificate the report reads, in an attempt of its own. Only while the
 -- report and the week proof are the reviewed definitions, the window proof is
 -- derived from; otherwise the report proves the week itself, as before.
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00Z'::timestamptz THEN
  v_generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');
 END IF;
 IF v_generation IS NOT DISTINCT FROM 'original-inventory-245:unqualified'
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'b23655a15587192f137ae4ad57859742'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'c4a17522149bfd879342ccc68dec98f9'
 THEN RETURN true;END IF;
 IF smarter_private.inventory_basis_cache_read(v_generation,false,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL
 OR smarter_private.inventory_basis_cache_read(v_generation,true,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL THEN
 -- Original hand proof progresses only after original flow proof, in its own attempt.
 IF md5(pg_get_functiondef('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'a3b1c75ad2b122dc0b0fede8a66813c8'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '97fc255997a2faeac593b5b1f5420d4c'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)) IS DISTINCT FROM 'd427fd27d163ba72a7dc3cd50866163d'
 THEN RAISE EXCEPTION 'weekly_hand_parts_owner_changed';END IF;
 IF (SELECT count(*) FROM pg_proc WHERE oid IN('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)
  AND proowner='postgres'::regrole AND NOT prosecdef AND provolatile='s' AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_owner_authority_changed';END IF;
 v_hand_projected:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 IF EXISTS(SELECT FROM public.accounting_close_partials p WHERE p.kind='pnl_hands_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end
 AND NOT EXISTS(SELECT FROM public.fn_accounting_close_windows(p_start,p_end)cw WHERE cw.window_start=p.window_start)) THEN RAISE EXCEPTION 'weekly_hand_parts_noncanonical_window';END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  v_hand_witness:=smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected);
  CONTINUE WHEN EXISTS(SELECT FROM public.accounting_close_partials p WHERE p.kind='pnl_hands_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND p.computed_at<=clock_timestamp() AND jsonb_typeof(p.value->'groups')='array' AND p.value->>'groups_md5'=md5((p.value->'groups')::text)
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation AND p.value->'projected' IS NOT DISTINCT FROM to_jsonb(v_hand_projected)
   AND p.value->>'contract' IS NOT DISTINCT FROM '9dee2921c7b956281be61a3eb9d7df6e' AND p.value->'witness' IS NOT DISTINCT FROM v_hand_witness);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false;END IF;
  DELETE FROM public.accounting_close_certificates WHERE union_id=p_union_id AND period_start=p_start AND period_end=p_end AND kind IN('pnl_clubs','pnl_clubs_problem');
  v_hand_groups:=smarter_private.weekly_hand_parts_reduce(p_union_id,w.window_start,w.window_end,v_hand_projected);
  IF v_hand_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected) THEN RAISE EXCEPTION 'weekly_hand_parts_sources_changed_during_window';END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_hands_window',p_union_id,p_start,p_end,w.window_start,w.window_end,jsonb_build_object('generation',v_generation,'projected',v_hand_projected,'contract','9dee2921c7b956281be61a3eb9d7df6e','witness',v_hand_witness,'groups',v_hand_groups,'groups_md5',md5(v_hand_groups::text)),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false;END IF;
 IF smarter_private.weekly_hand_parts_read(p_union_id,p_start,p_end,v_generation,v_hand_projected) IS NULL THEN RETURN false;END IF;
 RETURN true;
 END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  -- A window that found a problem is re-proved after an hour, as the report
  -- re-proves a week whose flows found one.
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
   FROM smarter_private.union_pnl_original_flow_evidence_window(p_union_id,p_start,p_end,w.window_start,w.window_end) f;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_flows_window',p_union_id,p_start,p_end,w.window_start,w.window_end,
   jsonb_build_object('generation',v_generation,'bad',v_bad,'flows',v_flows),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false; END IF;
 -- Every window is fresh: the week's flows are its windows' flows and the two
 -- whole-week return families, the same rows the week proof returns.
 SELECT count(*),count(p.window_start) INTO v_windows,v_fresh
  FROM public.fn_accounting_close_windows(p_start,p_end) cw
  LEFT JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation;
 IF v_windows=0 OR v_fresh<>v_windows THEN RETURN false; END IF;
 WITH parts AS MATERIALIZED (
  SELECT p.value FROM public.fn_accounting_close_windows(p_start,p_end) cw
  JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
 ), tails AS MATERIALIZED (
  SELECT t.* FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
  UNION ALL
  SELECT t.* FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
 ) SELECT COALESCE((SELECT sum((value->>'bad')::bigint) FROM parts),0)+(SELECT count(*) FILTER(WHERE NOT valid) FROM tails),
  COALESCE((SELECT jsonb_agg(x.flow) FROM (SELECT e.flow FROM parts CROSS JOIN LATERAL jsonb_array_elements(parts.value->'flows') e(flow)
   UNION ALL SELECT to_jsonb(t) FROM tails t) x),'[]')
 INTO v_bad,v_flows;
 IF v_bad=0 THEN PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows));
 ELSE PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 -- Assembling the certificate is the attempt's step; the report reads it next.
 RETURN false;
END $function$
$qualified_owner2$;
 SELECT to_jsonb(p)-'prosrc'INTO after_meta FROM pg_proc p WHERE p.oid='public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM '2627c8820e0147d5e91a2014415ec558'THEN RAISE EXCEPTION 'original_flow_occupancy_postimage_changed:2';END IF;
END$owner2$;
DO $owner3$
DECLARE original text;before_meta jsonb;after_meta jsonb;
BEGIN
 IF public.fn_platform_frozen()THEN RAISE EXCEPTION 'original_flow_occupancy_install_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'INTO original,before_meta FROM pg_proc p WHERE p.oid='smarter_private.original_inventory_proof_sources_match()'::regprocedure;
 IF md5(original)IS DISTINCT FROM '22ee5025206e6eff274200496e2d4714'THEN RAISE EXCEPTION 'original_flow_occupancy_preimage_changed:3';END IF;
 EXECUTE $qualified_owner3$CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT count(*)=65 AND bool_and(p.oid IS NOT NULL AND p.proowner='postgres'::regrole AND md5(pg_get_functiondef(p.oid)) IS NOT DISTINCT FROM x.body_md5)
 FROM(VALUES ('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)','d77f5ad055ee433875efed7fd53bd25a'),('public.fn_union_pnl_inventory_population(timestamptz,timestamptz)','449f6f13feefe0d7e26e767a3465bc67'),('public.fn_union_pnl_inventory_as_of(timestamptz)','85513ff85d2b37ad04b79f89e125f1aa'),('smarter_private.original_retirement_boundary_proof(jsonb,timestamptz,timestamptz)','56457798f46f7c06a32b0e52915740a0'),('smarter_private.original_paired_seat_restoration_proof(jsonb,jsonb,timestamptz,timestamptz)','ada80c7f667ca7dad36cf223c80c3a6a'),('smarter_private.original_closed_tournament_rails_proof(jsonb,timestamptz)','a9319182a566e9917353765c414a1aa1'),('smarter_private.original_closed_player_proof(jsonb,timestamptz,timestamptz)','a441c3abe887cc4528268e347916d236'),('smarter_private.original_continued_chair_proof(jsonb,timestamptz,timestamptz)','8876018a8370a99f4012696cb264c740'),('smarter_private.original_returned_cash_base_proof(jsonb,timestamptz,timestamptz)','7ed06b6ccded0d6eb2bc3357742e360d'),('smarter_private.original_erased_cash_base_proof(jsonb,timestamptz)','a2d5ac28a5f07929ed99d6e871dddfa2'),('smarter_private.original_inventory_source_ref_md5(jsonb)','81fba77f13564999931e8a7a47cbd609'),('smarter_private.original_inventory_finite_witness(bigint)','0ef0a8a5b9e85633cf4bf8b0cd15c8d7'),('smarter_private.original_inventory_finite_family_proof(text,jsonb,timestamptz,timestamptz)','dd7861e20f4c90567a704cb2625962b8'),('smarter_private.original_erased_cash_base_request(bigint,text)','1467e44cc7f7871b34eff07f7038019d'),('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)','3beddbfe1e3d204d1907b428d9358f08'),('public.fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc'),('public.fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0'),('smarter_private.original_inventory_case_insert_guard()','d9bcabf711efa4c81c0ae7567897b722'),('smarter_private.original_inventory_certificate_insert_guard()','d4956b2b4c0a58bb5dc57b35e3e884ce'),('smarter_private.original_inventory_restoration_immutable()','6c939d278f5fad857bd97437dfaa5f4d'),('smarter_private.certify_original_inventory_restoration(bigint,timestamptz)','f5db14badd4a6b07c0f4b82e2ec5cb1e'),('smarter_private.inventory_restoration_issue_accepted(jsonb,timestamptz)','fdba882b3557f6ffd1cc29129773ff04'),('public.fn_union_pnl_boundary(uuid,timestamptz)','5e4e878524a91518de209bc5e008db36'),('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','b23655a15587192f137ae4ad57859742'),('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','c4a17522149bfd879342ccc68dec98f9'),('smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz)','058d499ade9d0609f83cc07d551b7f35'),('smarter_private.inventory_basis_cache_write(text,text,uuid,timestamptz,timestamptz,jsonb)','2c3f0af276c29f33d09cdb7ecd86df6a'),('smarter_private.original_inventory_basis_generation()','58dc20e1ba380ccb9b9dee8809731d33'),('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)','7b4a5f4572a45db069b6058899614021'),('public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)','9667c8b8c5aa74bf2ad2c57fbfa3991d'),('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)','58501728a93f9f4534dbf26d26aba63f'),('public.fn_union_pnl_inventory_as_of_admitted(timestamptz)','d65a33c20fb224c1dc2cc1ecb8168940'),('smarter_private.original_erased_cash_base_expected_hash(bigint)','afe5941dd7c4bbcccbfadc5d65a4f447'),('smarter_private.original_erased_cash_base_discharge_receipt(bigint,text)','f2c22efcfd9231094732ca82edff9101'),('smarter_private.original_erased_cash_base_discharge_evidence_valid(bigint,text,jsonb)','d4bc8b8d57c9037805a735bc1bb2be21'),('smarter_private.original_erased_cash_base_discharge(bigint,text)','9e6fcbf606004b81353a7704b50f072f'),('smarter_private.original_erased_cash_receivables(uuid,timestamptz)','0c53bd1f7fd7d22117af340ee02769d6'),('smarter_private.original_erased_cash_discharge_returns(uuid,timestamptz,timestamptz)','2a41fe7ccedc2947cf3ab84cead2493c'),('smarter_private.original_restoration_cash_returns(uuid,timestamptz,timestamptz)','e7cecf308d34108e12c0006029c1a3fa'),('public.fn_union_week_start(timestamptz)','103f192a228084dad0e4268c36c82c4b'),('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)','c4ea982db893a45aade32874bd7cd495'),('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)','faf875701e49db1cf99b481119e87404'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)','2627c8820e0147d5e91a2014415ec558'),('smarter_private.original_treasury_witness_immutable()','f6326523741592230d149799b876e886'),('smarter_private.original_treasury_gift_evidence(uuid)','df84a641f40ee44d9db83e979398f9af'),('smarter_private.admit_original_treasury_gift(uuid)','07c857f67488e000ecbaf63e083c1c05'),('smarter_private.original_treasury_return_evidence(uuid)','3f2b8626b018cc5d22d9ebe9e6d3fb72'),('smarter_private.admit_original_treasury_return(uuid)','c51b45b085ac1a26f043711804ff8d00'),('smarter_private.cash_initial_funding_receipt(uuid)','e111dad7c0f5d5e3b74710053835caa4'),('smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz)','95b9a25f9a422bb7d8df115f86bc5993'),('smarter_private.original_treasury_cash_outcome_evidence(jsonb)','12c94769bbcd6eb2c3349728cdc8512d'),('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)','4a7cee2cfecdf7a36446c169f754ccd0'),('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)','d01404c53405fd1826de26e58b04f4b1'),('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','8269577929892d8634e32dcfac08ff77'),('public.fn_pnl_cash_hand_evidence(uuid,bigint)','43820fe60b759bd93f6838f908122c96'),('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)','1a5e66c29d3d36e41752589d59daa478'),('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)','2ba3a2891019b46e06b46b4c642e566a'),('public.fn_ca_cash_seat_club(uuid,uuid)','148f2246fc0ee3ab11cd86456765e419'),('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)','9dee2921c7b956281be61a3eb9d7df6e'),('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)','d427fd27d163ba72a7dc3cd50866163d'),('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','a3b1c75ad2b122dc0b0fede8a66813c8'),('public.fn_claim_entry_purchase_receipt(text,text,jsonb)','4a10a4e1cfd2794046a6cb8ad1463de6'),('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)','ad64ff6223a433108f4f3625de1be3be'),('smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)','d768afe805ed480569b44ef107d15675'),('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)','a7c0b003d24f5ae64cf440ce94d52d93'))x(signature,body_md5) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature);
$function$
$qualified_owner3$;
 SELECT to_jsonb(p)-'prosrc'INTO after_meta FROM pg_proc p WHERE p.oid='smarter_private.original_inventory_proof_sources_match()'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))IS DISTINCT FROM '8734797c6093c7e5a2a72de9b387a6de'THEN RAISE EXCEPTION 'original_flow_occupancy_postimage_changed:3';END IF;
END$owner3$;
-- The original full reader is postgres-only; name that preserved ACL explicitly.
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
DO $final$BEGIN IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'original_flow_occupancy_source65_not_qualified';END IF;END$final$;
COMMIT;
