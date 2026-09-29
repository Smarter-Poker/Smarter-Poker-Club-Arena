-- Read-only (a single SELECT). Midway Union at 2026-09-28 07:00+00: the migration's proof core,
-- byte for byte except the argument line (test-union-pnl-opening-resolution.sh checks it).
SET statement_timeout='44s';
SELECT q.proof->>'status' status,q.proof->>'reason' reason,q.proof->>'registration_first_operation' first_op,(q.proof->>'zero_cost_entry')::boolean zero_cost,
 count(*) registrations,count(DISTINCT q.tournament_id) tournaments,sum((q.proof->>'entry_amount')::numeric) entry,
 sum((q.proof->>'returned')::numeric) returned,sum((q.proof->>'deferred_amount')::numeric) deferred
FROM (
-- CORE BEGIN (the production dry run executes exactly this text)
WITH args AS MATERIALIZED (SELECT 'fade0000-0000-0000-0000-000000000001'::uuid AS union_id, '2026-09-28 07:00+00'::timestamptz AS boundary),
fence AS MATERIALIZED (
 SELECT a.union_id, a.boundary, (SELECT w.captured_at FROM public.union_pnl_weekly_capture w WHERE w.singleton) frames_began
 FROM args a WHERE EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints k WHERE k.boundary=a.boundary)
), tours AS MATERIALIZED (
 SELECT c.row_id tournament_id, c.after_row trow
 FROM fence f JOIN public.union_pnl_inventory_checkpoint_rows c ON c.boundary=f.boundary AND c.source_name='tournaments'
 WHERE c.after_row->>'union_id'=f.union_id::text AND c.after_row->>'status' NOT IN ('COMPLETED','CANCELLED')
  AND (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournaments' AND e.row_id=c.row_id ORDER BY e.event_id LIMIT 1)='baseline'
), regs AS MATERIALIZED (
 SELECT t.tournament_id, t.trow, c.row_id registration_id, c.after_row rrow, (c.after_row->>'user_id')::uuid user_id,
  (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players' AND e.row_id=c.row_id ORDER BY e.event_id LIMIT 1) first_op
 FROM fence f JOIN public.union_pnl_inventory_checkpoint_rows c ON c.boundary=f.boundary AND c.source_name='tournament_players'
 JOIN tours t ON t.tournament_id::text=c.after_row->>'tournament_id'
), cand AS MATERIALIZED (
 SELECT r.*,f.union_id,f.boundary,f.frames_began,COALESCE(tt.buy_in_amount,0)+COALESCE(tt.buy_in_fee,0) price,tt.id IS NOT NULL terms_found,
  tt.rebuy_cost,tt.addon_cost,COALESCE(tt.is_rebuy,false) OR COALESCE(tt.is_reentry,false) rebuy_allowed,COALESCE(tt.add_on_available,false) addon_allowed,
  tt.free_buy,tt.buy_in_amount,tt.buy_in_fee
 FROM regs r CROSS JOIN fence f LEFT JOIN public.tournaments tt ON tt.id=r.tournament_id
 WHERE r.first_op IS DISTINCT FROM 'INSERT' OR NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts x
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=x.transaction_id
   WHERE x.tournament_id=r.tournament_id AND x.registration_id=r.registration_id AND x.asset='chips' AND b.observed_at<f.boundary)
), orphan_credits AS MATERIALIZED (
 -- a return the platform receipted before the boundary must be one of the
 -- ledger returns read below
 SELECT c.registration_id,count(*) n FROM cand c
 JOIN public.tournament_accounting_credit_receipts cr ON cr.tournament_id=c.tournament_id AND cr.user_id=c.user_id
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=cr.transaction_id AND b.observed_at<c.boundary
 WHERE NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=cr.ledger_id AND l.tournament_id=c.tournament_id
   AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.created_at<c.boundary)
 GROUP BY 1
 UNION ALL
 SELECT c.registration_id,count(*) FROM cand c
 JOIN public.tournament_refund_tranches rt ON rt.tournament_id=c.tournament_id AND rt.user_id=c.user_id
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=rt.transaction_id AND b.observed_at<c.boundary
 WHERE NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=rt.credit_ledger_id AND l.tournament_id=c.tournament_id
   AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.created_at<c.boundary)
 GROUP BY 1
), facts AS (
 SELECT c.*,d.*,k.*,x.*,
  COALESCE((SELECT sum(o.n) FROM orphan_credits o WHERE o.registration_id=c.registration_id),0) n_orphan_returns,
  c.rrow->>'source_satellite_id' IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.tournament_ticket_admission_authorizations a WHERE a.tournament_id=c.tournament_id AND a.user_id=c.user_id)
   OR EXISTS(SELECT 1 FROM public.tournament_qualification_entitlements q WHERE q.tournament_id=c.tournament_id AND q.user_id=c.user_id) non_chip,
  CASE WHEN c.price=0 THEN (c.rrow->>'club_id')::uuid ELSE d.d_club END owning_club
 FROM cand c
 CROSS JOIN LATERAL (
  SELECT count(l.id) d_n,count(l.id) FILTER(WHERE l.category='tournament_buyin') d_buyins,
   count(l.id) FILTER(WHERE l.status IS DISTINCT FROM 'posted' OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM c.tournament_id
    OR l.amount IS NULL OR l.amount<=0 OR l.club_id IS NULL OR l.row_hash IS NULL OR l.category NOT IN ('tournament_buyin','rebuy','addon')) d_bad,
   count(l.id) FILTER(WHERE l.created_at>=c.frames_began AND b.observed_at IS NULL) d_unreceipted,
   count(l.id) FILTER(WHERE rx.id IS NOT NULL AND rx.registration_id IS DISTINCT FROM c.registration_id) d_foreign,
   count(l.id) FILTER(WHERE (l.category='tournament_buyin' AND l.amount IS DISTINCT FROM c.price)
    OR (l.category='rebuy' AND (NOT c.rebuy_allowed OR l.amount IS DISTINCT FROM c.rebuy_cost))
    OR (l.category='addon' AND (NOT c.addon_allowed OR l.amount IS DISTINCT FROM c.addon_cost))) d_off_schedule,
   count(DISTINCT l.club_id) d_clubs,min(l.club_id::text)::uuid d_club,COALESCE(sum(l.amount),0) d_amount,
   COALESCE(jsonb_agg(jsonb_build_object('ledger_id',l.id,'chain_seq',l.chain_seq,'row_hash',l.row_hash,'category',l.category,'amount',l.amount,
    'club_id',l.club_id,'created_at',l.created_at,'receipt_id',rx.id,'receipt_observed_at',b.observed_at) ORDER BY l.created_at,l.id) FILTER(WHERE l.id IS NOT NULL),'[]') d_rows
  FROM public.chip_ledger l
  LEFT JOIN public.tournament_participant_funding_receipts rx ON rx.ledger_id=l.id
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=rx.transaction_id
  WHERE l.tournament_id=c.tournament_id AND l.from_type='player_wallet' AND l.from_entity_id=c.user_id AND l.created_at<c.boundary
   AND (b.observed_at IS NULL OR b.observed_at<c.boundary)
 ) d
 CROSS JOIN LATERAL (
  SELECT count(l.id) k_n,
   count(l.id) FILTER(WHERE l.status IS DISTINCT FROM 'posted' OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM c.tournament_id
    OR l.amount IS NULL OR l.amount<=0 OR l.club_id IS NULL OR l.row_hash IS NULL OR l.category NOT IN ('tournament_prize','bounty')
    OR (cr.id IS NOT NULL AND (cr.user_id IS DISTINCT FROM c.user_id OR cr.amount IS DISTINCT FROM l.amount OR cr.asset IS DISTINCT FROM 'chips'))
    OR (rt.wallet_transaction_id IS NOT NULL AND (rt.user_id IS DISTINCT FROM c.user_id OR rt.amount_paid_now IS DISTINCT FROM l.amount))) k_bad,
   count(l.id) FILTER(WHERE l.created_at>=c.frames_began AND b.observed_at IS NULL) k_unreceipted,
   count(l.id) FILTER(WHERE COALESCE(cr.credited_club_id,rt.source_wallet_club_id,l.club_id) IS DISTINCT FROM l.club_id) k_split_club,
   COALESCE(array_agg(DISTINCT l.club_id) FILTER(WHERE l.id IS NOT NULL),'{}') k_clubs,COALESCE(sum(l.amount),0) k_amount,
   COALESCE(jsonb_agg(jsonb_build_object('ledger_id',l.id,'chain_seq',l.chain_seq,'row_hash',l.row_hash,'category',l.category,'amount',l.amount,
    'club_id',l.club_id,'created_at',l.created_at,'credit_receipt_id',cr.id,'refund_tranche_id',rt.wallet_transaction_id,'receipt_observed_at',b.observed_at)
    ORDER BY l.created_at,l.id) FILTER(WHERE l.id IS NOT NULL),'[]') k_rows
  FROM public.chip_ledger l
  LEFT JOIN public.tournament_accounting_credit_receipts cr ON cr.ledger_id=l.id
  LEFT JOIN public.tournament_refund_tranches rt ON rt.credit_ledger_id=l.id
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=COALESCE(cr.transaction_id,rt.transaction_id)
  WHERE l.tournament_id=c.tournament_id AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.created_at<c.boundary
   AND (b.observed_at IS NULL OR b.observed_at<c.boundary)
 ) k
 CROSS JOIN LATERAL (
  -- the platform's own entry receipts for this registration (framed before
  -- the boundary, or written before frames began) must agree with the ledger
  SELECT count(r.id) FILTER(WHERE r.asset IS DISTINCT FROM 'chips') x_non_chip,
   count(r.id) FILTER(WHERE r.asset='chips' AND ((r.ledger_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=r.ledger_id
     AND l.tournament_id=c.tournament_id AND l.from_type='player_wallet' AND l.from_entity_id=c.user_id AND l.created_at<c.boundary AND l.amount=r.amount))
    OR (r.ledger_id IS NULL AND (r.amount<>0 OR r.entitlement_id IS NOT NULL OR r.registration_snapshot->>'source_satellite_id' IS NOT NULL
     OR r.registration_snapshot->>'club_id' IS DISTINCT FROM c.rrow->>'club_id')))) x_disagree,
   COALESCE(jsonb_agg(r.id ORDER BY r.observed_at,r.id) FILTER(WHERE r.id IS NOT NULL),'[]') x_ids
  FROM public.tournament_participant_funding_receipts r
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
  WHERE r.tournament_id=c.tournament_id AND r.registration_id=c.registration_id
   AND ((b.observed_at IS NULL AND r.observed_at<c.frames_began) OR b.observed_at<c.boundary)
 ) x
), judged AS (
 SELECT f.*,CASE
  WHEN f.frames_began IS NULL OR f.frames_began>=f.boundary THEN 'capture_fence_missing'
  WHEN NOT f.terms_found THEN 'tournament_terms_missing'
  WHEN f.first_op IS NULL OR f.first_op NOT IN ('baseline','INSERT') THEN 'registration_original_population_missing'
  WHEN f.non_chip OR f.x_non_chip>0 THEN 'non_chip_instrument'
  WHEN f.d_bad>0 THEN 'entry_debit_not_posted_to_this_tournament_prize_pool'
  WHEN f.d_unreceipted>0 THEN 'post_capture_entry_debit_unreceipted'
  WHEN f.d_foreign>0 THEN 'entry_debit_receipted_for_another_registration'
  WHEN f.d_buyins<>CASE WHEN f.price=0 THEN 0 ELSE 1 END THEN 'entry_debit_count_does_not_match_schedule'
  WHEN f.d_off_schedule>0 THEN 'entry_amount_does_not_match_schedule'
  WHEN f.d_clubs>1 OR f.owning_club IS NULL OR (f.d_clubs=1 AND f.d_club IS DISTINCT FROM f.owning_club) THEN 'funding_club_ambiguous'
  WHEN f.x_disagree>0 THEN 'entry_receipt_disagrees_with_ledger'
  WHEN f.k_bad>0 THEN 'return_is_not_a_receipted_tournament_award'
  WHEN f.k_unreceipted>0 OR f.n_orphan_returns>0 THEN 'return_evidence_incomplete'
  WHEN f.k_split_club>0 OR EXISTS(SELECT 1 FROM unnest(f.k_clubs) z WHERE z IS DISTINCT FROM f.owning_club) THEN 'return_credited_to_another_club'
 END refusal
 FROM facts f
)
SELECT j.registration_id,j.tournament_id,
 jsonb_build_object('resolution_kind','opening_registration_entry_from_chip_ledger','union_id',j.union_id,'boundary',j.boundary,
  'tournament_id',j.tournament_id,'registration_id',j.registration_id,'user_id',j.user_id,
  'registration_first_operation',j.first_op,'registration_row_md5',md5(j.rrow::text),'tournament_row_md5',md5(j.trow::text),
  'instrument','chips','zero_cost_entry',j.price=0,'free_buy',j.free_buy,
  'schedule',jsonb_build_object('buy_in_amount',j.buy_in_amount,'buy_in_fee',j.buy_in_fee,'entry_price',j.price,'rebuy_cost',j.rebuy_cost,'addon_cost',j.addon_cost),
  'registration_club_id',j.rrow->'club_id','owning_club_id',j.owning_club,
  'entries',j.d_n+CASE WHEN j.price=0 THEN 1 ELSE 0 END,'entry_amount',j.d_amount,'entry_ledger',j.d_rows,'entry_receipt_ids',j.x_ids,
  'returned',j.k_amount,'returns',j.k_rows,'deferred_amount',j.d_amount-j.k_amount,'frames_began',j.frames_began)
 ||CASE WHEN j.refusal IS NULL THEN jsonb_build_object('status','proven') ELSE jsonb_build_object('status','refused','reason',j.refusal) END AS proof
FROM judged j
ORDER BY j.tournament_id,j.registration_id
-- CORE END
) q GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
