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
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta
  FROM originals q
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
 FROM projected
 UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end)
 UNION ALL SELECT * FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end);
$function$;
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
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta
  FROM originals q
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
 FROM projected
;
$function$;
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_advance(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
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
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'f85d5f26253365ec1052b74ed23a14cc'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'c4a17522149bfd879342ccc68dec98f9'
 THEN RETURN true;END IF;
 IF smarter_private.inventory_basis_cache_read(v_generation,false,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL
 OR smarter_private.inventory_basis_cache_read(v_generation,true,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL THEN
 -- Original hand proof progresses only after original flow proof, in its own attempt.
 IF md5(pg_get_functiondef('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '491323192dc49931df7c36e4699eac9a'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '97fc255997a2faeac593b5b1f5420d4c'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)) IS DISTINCT FROM '1ecd757e644477bb02400a17b53edd32'
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
   AND p.value->>'contract' IS NOT DISTINCT FROM 'd4665eb6e43425a93816c55ded55f644' AND p.value->'witness' IS NOT DISTINCT FROM v_hand_witness);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false;END IF;
  DELETE FROM public.accounting_close_certificates WHERE union_id=p_union_id AND period_start=p_start AND period_end=p_end AND kind IN('pnl_clubs','pnl_clubs_problem');
  v_hand_groups:=smarter_private.weekly_hand_parts_reduce(p_union_id,w.window_start,w.window_end,v_hand_projected);
  IF v_hand_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected) THEN RAISE EXCEPTION 'weekly_hand_parts_sources_changed_during_window';END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_hands_window',p_union_id,p_start,p_end,w.window_start,w.window_end,jsonb_build_object('generation',v_generation,'projected',v_hand_projected,'contract','d4665eb6e43425a93816c55ded55f644','witness',v_hand_witness,'groups',v_hand_groups,'groups_md5',md5(v_hand_groups::text)),clock_timestamp())
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
END $function$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_bbj_stack_awards(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(club_id uuid, user_id uuid, amount numeric, payout_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (pp.p->>'earning_club_id')::uuid, r.user_id, r.amount, r.payout_id
 FROM public.bbj_payout_recipients r
 JOIN public.bbj_payouts b ON b.id=r.payout_id
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=b.table_id AND o.hand_number=b.hand_number
 CROSS JOIN LATERAL (SELECT p FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p
  WHERE p->>'user_id'=r.user_id::text LIMIT 1) pp
 WHERE r.created_at>=p_start AND r.created_at<p_end AND r.amount>0
  AND o.game_scope->>'game_union_id'=p_union_id::text
  -- a share paid to the wallet of a departed recipient never reached the felt
  AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w
   WHERE w.key='bbj:'||r.payout_id::text||':'||r.user_id::text)
$function$;
