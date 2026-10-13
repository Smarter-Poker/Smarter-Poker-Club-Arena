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
 FROM projected
 UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end)
 UNION ALL SELECT * FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end);
$function$;
