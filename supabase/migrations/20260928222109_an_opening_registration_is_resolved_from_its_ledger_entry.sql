-- AN OPENING REGISTRATION IS RESOLVED FROM ITS LEDGER ENTRY (2026-09-28).
--
-- Midway Union's first weekly close (book 2026-09-21 07:00 .. 09-28 07:00 UTC)
-- is refused with opening_basis_incomplete. Read-only on production
-- 2026-09-28: at the 09-21 boundary 364 Midway tournaments are open; 45 of
-- them were created before the original inventory capture (2026-09-18
-- 00:20:48, first inventory event 'baseline'), and fn_union_pnl_boundary
-- refuses each of those with open_tournament_precedes_original_population
-- before it reads a single registration. Of their 2,538 registrations, 1,395
-- have no tournament_participant_funding_receipts row (entered before receipt
-- capture began, 00:33:45) and 11 have only a receipt written before
-- transaction frames began (00:41:12), so no receipt is framed before the
-- boundary. All 1,406 are horses. Every one of their entries is on the
-- append-only, hash-chained chip_ledger: a posted tournament_buyin (or, in a
-- free-buy, no charge at all) from exactly one club wallet to this
-- tournament's prize_liability at the scheduled price, add-ons at the
-- scheduled cost, bounty returns each carried by a framed credit receipt to
-- the same club. Nothing about them is unknown; only the receipt is missing.
--
-- This migration does NOT touch tournament_participant_funding_receipts, the
-- inventory, the checkpoints or any balance. It adds:
--   * union_pnl_opening_registration_resolutions: immutable per-registration
--     receipts keyed (boundary, registration_id), bound to md5 of the exact
--     registration and tournament rows of the sealed checkpoint at that
--     boundary and to md5 of their own proof;
--   * fn_union_pnl_prove_opening_registrations: re-proves every such
--     registration from primary evidence observed before the boundary and
--     refuses (first failing reason) a missing or unposted ledger row, more
--     than one funding club, a non-chip instrument (satellite seat, ticket,
--     qualification), an amount or count off the tournament's schedule, a
--     post-capture debit or return without its receipt, a receipt that
--     disagrees with the ledger, or a return credited to another club;
--   * fn_union_pnl_resolve_opening_registrations: the service-role writer
--     (dry run by default) that writes a receipt only for a proven one;
--   * fn_union_pnl_opening_registration_resolution: the one acceptance
--     predicate;
--   * fn_union_pnl_boundary (as 20260928211132 installs it): a baseline
--     tournament is read only when every registration of its original
--     population has a valid resolution for this boundary, and a resolved
--     registration is carried at its re-proved entry less returns. Every other
--     tournament and registration is computed exactly as before.
-- A registration that cannot be proven keeps its tournament refused.
--
-- Native qualification: scripts/dev/test-union-pnl-opening-resolution.sh
-- (green + RED=1 control). Production dry run (read-only, the proof core byte
-- for byte): tests/fixtures/union-pnl-opening-resolution/production-dryrun-*.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  -- Built on the definition migration 20260928211132 (#5551) installs: apply
  -- that one first. On the pre-#5551 definition (be154af9a391203d46ae54e5c318141f)
  -- this refuses and changes nothing.
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '52682459bd047ad5aea7c454f3ae8c5e' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_boundary is not the 20260928211132 (#5551) definition' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_opening_registration_resolutions') IS NOT NULL OR to_regprocedure('public.fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb)') IS NOT NULL OR to_regprocedure('public.fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)') IS NOT NULL OR to_regprocedure('public.fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: opening resolution objects already exist' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.union_pnl_inventory_checkpoints') IS NULL OR to_regclass('public.union_pnl_inventory_checkpoint_rows') IS NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_immutable()') IS NULL THEN
    RAISE EXCEPTION 'preimage mismatch: sealed inventory checkpoints are required' USING ERRCODE='55000';
  END IF;
END $pre$;

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

CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
 nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric;
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
  -- A tournament captured as the baseline (it existed before the original
  -- inventory capture) is read only when every registration of its original
  -- population carries a valid opening resolution for this boundary
  -- (union_pnl_opening_registration_resolutions: its entry re-proved from the
  -- posted chip ledger, bound to these exact population rows). Otherwise it is
  -- refused exactly as before.
  IF first_op IS DISTINCT FROM 'INSERT' AND (first_op IS DISTINCT FROM 'baseline' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) y(x)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
     AND (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players'
       AND e.row_id=(y.x#>>'{row,id}')::uuid ORDER BY e.event_id LIMIT 1) IS DISTINCT FROM 'INSERT'
     AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,y.x->'row')))) THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population's order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned,res_club,res_amount IN
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
    k.changed,k.returned,rr.owning_club_id,rr.deferred_amount
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
   LEFT JOIN LATERAL (SELECT q.owning_club_id,q.deferred_amount
    FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,p.s) q WHERE first_op='baseline') rr ON true
   ORDER BY p.ord
  LOOP
   -- In a baseline tournament a resolved registration is carried at its
   -- re-proved original entry less its returns before the boundary.
   IF res_club IS NOT NULL THEN
    holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',res_club,'user_id',s->'user_id','amount',res_amount,
     'kind','deferred_tournament_result','source_id',s->'id','basis','opening_registration_resolution'));
    CONTINUE;
   END IF;
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

REVOKE ALL ON FUNCTION public.fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE f text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '0e1fb7d6826b5a95ce5e637174017ede' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_boundary(uuid,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM '09e6fc21f116c941de74edc8b37be654' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '2910a4e7d455ce6f05d1b6963fe54931' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean)'::regprocedure)) IS DISTINCT FROM 'b7946c6832f5d3dd80d3ac83a4a34536' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean)' USING ERRCODE='55000'; END IF;
  FOREACH f IN ARRAY ARRAY['public.fn_union_pnl_opening_registration_resolution(uuid,timestamp with time zone,jsonb,jsonb)','public.fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)','public.fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean)','public.fn_union_pnl_boundary(uuid,timestamp with time zone)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is browser-executable',f USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_function_privilege('service_role','public.fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)','EXECUTE') OR has_function_privilege('service_role','public.fn_union_pnl_boundary(uuid,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'postimage: prover or boundary is service-executable' USING ERRCODE='55000';
  END IF;
  IF has_table_privilege('anon','public.union_pnl_opening_registration_resolutions','SELECT')
     OR has_table_privilege('authenticated','public.union_pnl_opening_registration_resolutions','SELECT')
     OR has_table_privilege('service_role','public.union_pnl_opening_registration_resolutions','INSERT')
     OR has_table_privilege('service_role','public.union_pnl_opening_registration_resolutions','UPDATE') THEN
    RAISE EXCEPTION 'postimage: opening resolutions are writable or browser-readable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.union_pnl_opening_registration_resolutions'::regclass AND tgname='original_pnl_immutable') THEN
    RAISE EXCEPTION 'postimage: opening resolutions are not immutable' USING ERRCODE='55000';
  END IF;
  -- No balance column is written here (the money-RPC registry guard's own test).
  IF EXISTS(
     SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.fn_union_pnl_resolve_opening_registrations(uuid,timestamp with time zone,text,boolean)'::regprocedure,'public.fn_union_pnl_boundary(uuid,timestamp with time zone)'::regprocedure)
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN
    RAISE EXCEPTION 'postimage: a resolution function writes balances' USING ERRCODE='55000';
  END IF;
END $post$;

COMMIT;
