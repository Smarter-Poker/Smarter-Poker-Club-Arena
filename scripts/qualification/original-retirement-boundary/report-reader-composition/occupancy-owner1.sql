CREATE OR REPLACE FUNCTION smarter_private.union_pnl_original_flow_evidence_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_window_start timestamp with time zone, p_window_end timestamp with time zone)
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
