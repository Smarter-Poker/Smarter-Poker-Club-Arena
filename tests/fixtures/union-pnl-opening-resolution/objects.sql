CREATE TABLE public.union_pnl_opening_registration_resolutions (
  boundary timestamptz NOT NULL,
  registration_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  union_id uuid NOT NULL,
  registration_row_md5 text NOT NULL CHECK (registration_row_md5 ~ '^[0-9a-f]{32}$'),
  tournament_row_md5 text NOT NULL CHECK (tournament_row_md5 ~ '^[0-9a-f]{32}$'),
  owning_club_id uuid NOT NULL,
  asset text NOT NULL CHECK (asset = 'chips'),
  entries integer NOT NULL CHECK (entries >= 1),
  entry_amount numeric NOT NULL CHECK (entry_amount >= 0 AND entry_amount = round(entry_amount, 2)),
  returned numeric NOT NULL CHECK (returned >= 0 AND returned = round(returned, 2)),
  deferred_amount numeric NOT NULL,
  resolution_kind text NOT NULL CHECK (resolution_kind = 'opening_registration_entry_from_chip_ledger'),
  proof jsonb NOT NULL,
  proof_md5 text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  resolved_by text NOT NULL DEFAULT session_user,
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (boundary, registration_id),
  CHECK (deferred_amount = entry_amount - returned),
  CHECK (proof_md5 = md5(proof::text)),
  CHECK (jsonb_typeof(proof) = 'object' AND proof->>'status' = 'proven'
    AND proof->>'resolution_kind' = resolution_kind
    AND (proof->>'boundary')::timestamptz = boundary
    AND proof->>'registration_id' = registration_id::text AND proof->>'tournament_id' = tournament_id::text
    AND proof->>'user_id' = user_id::text AND proof->>'union_id' = union_id::text
    AND proof->>'registration_row_md5' = registration_row_md5 AND proof->>'tournament_row_md5' = tournament_row_md5
    AND proof->>'owning_club_id' = owning_club_id::text AND proof->>'instrument' = asset
    AND (proof->>'entries')::integer = entries AND (proof->>'entry_amount')::numeric = entry_amount
    AND (proof->>'returned')::numeric = returned AND (proof->>'deferred_amount')::numeric = deferred_amount)
);
ALTER TABLE public.union_pnl_opening_registration_resolutions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_opening_registration_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_opening_registration_resolutions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.union_pnl_opening_registration_resolutions TO service_role;

-- The one acceptance predicate: the valid resolution of this registration at
-- this boundary, bound to the exact population rows the boundary is reading
-- (registration and tournament) and to its own proof. Anything else: no row.
CREATE FUNCTION public.fn_union_pnl_opening_registration_resolution(p_union_id uuid, p_at timestamp with time zone, p_tournament jsonb, p_registration jsonb)
 RETURNS SETOF public.union_pnl_opening_registration_resolutions
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT r.* FROM public.union_pnl_opening_registration_resolutions r
 WHERE r.boundary=p_at AND r.registration_id::text=p_registration->>'id' AND r.union_id=p_union_id
  AND p_tournament->>'union_id'=p_union_id::text AND p_registration->>'tournament_id'=p_tournament->>'id'
  AND r.tournament_id::text=p_tournament->>'id' AND r.user_id::text=p_registration->>'user_id'
  AND r.registration_row_md5=md5(p_registration::text) AND r.tournament_row_md5=md5(p_tournament::text)
  AND r.proof_md5=md5(r.proof::text) AND r.proof->>'status'='proven'
$function$;

-- Re-proves, from primary evidence observed before the boundary, the original
-- entry of every registration fn_union_pnl_boundary cannot prove from funding
-- receipts: each registration of an open tournament of this Union whose
-- tournament was captured as the baseline (it existed before the original
-- inventory capture of 2026-09-18) and whose registration either was captured
-- as the baseline too or has no framed chip entry receipt before the boundary.
-- Population rows come from the sealed inventory checkpoint AT the boundary
-- (the same rows fn_union_pnl_inventory_as_of returns for it). Refuses, with
-- the first failing reason, anything it cannot prove.
CREATE FUNCTION public.fn_union_pnl_prove_opening_registrations(p_union_id uuid, p_at timestamp with time zone)
 RETURNS TABLE(registration_id uuid, tournament_id uuid, proof jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- CORE BEGIN (the production dry run executes exactly this text)
WITH args AS MATERIALIZED (SELECT p_union_id AS union_id, p_at AS boundary),
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
$function$;

-- Service-role writer, dry run by default: proves every candidate of this
-- Union at this boundary and, only when p_apply, inserts a receipt for each
-- proven registration that has none. Refused registrations stay unresolved,
-- and keep their tournament blocked in fn_union_pnl_boundary.
CREATE FUNCTION public.fn_union_pnl_resolve_opening_registrations(p_union_id uuid, p_at timestamp with time zone, p_reason text, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c record; v_cand integer:=0; v_proven integer:=0; v_resolved integer:=0; v_already integer:=0; v_refused integer:=0;
 v_entry numeric:=0; v_returned numeric:=0; v_deferred numeric:=0; v_refusals jsonb:='{}'; v_refused_amount numeric:=0; v_n integer;
BEGIN
 IF p_union_id IS NULL OR p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() THEN
  RAISE EXCEPTION 'invalid_resolution_boundary' USING ERRCODE='22023'; END IF;
 IF p_apply IS NOT FALSE AND (p_reason IS NULL OR length(btrim(p_reason))<20) THEN
  RAISE EXCEPTION 'resolution_reason_required' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints k WHERE k.boundary=p_at) THEN
  RAISE EXCEPTION 'boundary_checkpoint_missing' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union_pnl_opening_registration_resolution:'||p_union_id::text||':'||p_at::text,0));
 FOR c IN SELECT * FROM public.fn_union_pnl_prove_opening_registrations(p_union_id,p_at) LOOP
  v_cand:=v_cand+1;
  IF c.proof->>'status'='proven' THEN
   IF EXISTS(SELECT 1 FROM public.union_pnl_opening_registration_resolutions r WHERE r.boundary=p_at AND r.registration_id=c.registration_id) THEN
    v_already:=v_already+1;
   ELSIF p_apply THEN
    INSERT INTO public.union_pnl_opening_registration_resolutions(boundary,registration_id,tournament_id,user_id,union_id,
     registration_row_md5,tournament_row_md5,owning_club_id,asset,entries,entry_amount,returned,deferred_amount,resolution_kind,proof,proof_md5,reason)
    VALUES(p_at,c.registration_id,c.tournament_id,(c.proof->>'user_id')::uuid,p_union_id,c.proof->>'registration_row_md5',c.proof->>'tournament_row_md5',
     (c.proof->>'owning_club_id')::uuid,c.proof->>'instrument',(c.proof->>'entries')::integer,(c.proof->>'entry_amount')::numeric,
     (c.proof->>'returned')::numeric,(c.proof->>'deferred_amount')::numeric,c.proof->>'resolution_kind',c.proof,md5(c.proof::text),btrim(p_reason));
    v_resolved:=v_resolved+1;
   ELSE
    v_proven:=v_proven+1;
   END IF;
   v_entry:=v_entry+(c.proof->>'entry_amount')::numeric; v_returned:=v_returned+(c.proof->>'returned')::numeric;
   v_deferred:=v_deferred+(c.proof->>'deferred_amount')::numeric;
  ELSE
   v_refused:=v_refused+1; v_refused_amount:=v_refused_amount+COALESCE((c.proof->>'entry_amount')::numeric,0);
   v_n:=COALESCE((v_refusals->>(c.proof->>'reason'))::integer,0)+1;
   v_refusals:=v_refusals||jsonb_build_object(c.proof->>'reason',v_n);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('union_id',p_union_id,'boundary',p_at,'applied',p_apply IS NOT FALSE,'candidates',v_cand,
  'proven_not_written',v_proven,'resolved_now',v_resolved,'already_resolved',v_already,'refused',v_refused,
  'refusals',v_refusals,'refused_entry_amount',v_refused_amount,
  'entry_amount',v_entry,'returned',v_returned,'deferred_amount',v_deferred);
END $function$;
