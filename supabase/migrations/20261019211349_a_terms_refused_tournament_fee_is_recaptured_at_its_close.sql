-- 20261019211349_a_terms_refused_tournament_fee_is_recaptured_at_its_close.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-10-19 incident, settled under CLAUDE.md 10.9):
--
-- At 15:43:07 UTC 1,717 horse memberships were moved under KingFish, the
-- owner of their clubs, as plain players. KingFish had no agent agreement in
-- those clubs, so fn_accounting_earning_contract refused every contributor
-- reporting to him with accounting_terms_not_observed (55000). The original
-- producer, fn_stamp_accounting_tournament_fee, is written not to destroy a
-- proved fee charge on that refusal: it records the whole batch as
-- 'legacy_unverified' with the exact contributor manifest it had already
-- proved and the refusal in `capture_reason`. Between 15:43:16 and 19:07:16,
-- 1,167 fee records of 1,011 tournaments were saved that way. The producer
-- fix (#7458, installed 19:07) stopped new ones, but nothing could ever make
-- the saved ones payable again: the batch is immutable, the net plan refuses
-- any batch that is not 'captured', the legacy-custody hold refuses a
-- post-cutover fee, and so every one of those tournaments, though decided,
-- could not finish. Their winners were not paid. This is the defect: a
-- refusal that was correct at the charge instant, once its cause is gone,
-- stranded the prize for ever.
--
-- THE ROOT FIX. The tournament's own close now re-runs the producer's capture
-- for such a batch, in the close transaction itself, from the batch's own
-- recorded manifest. fn_accounting_recapture_terms_refused_tournament_fee
-- verifies every piece of evidence fn_capture_accounting_tournament_fee
-- verifies (byte for byte the same checks), allocates with the same largest-
-- remainder arithmetic, and prices each contributor through the SAME
-- fn_accounting_earning_contract at the SAME charge instant. It writes the
-- ordinary accounting_tournament_fee_sources rows and one immutable receipt
-- in accounting_tournament_fee_terms_recaptures holding the untouched
-- original batch and the canonical sources. This is the exact shape of the
-- existing mixed-cutover Spin qualification (accounting_mixed_cutover_spin_
-- fee_proofs); the net plan and the week-quality reader accept this receipt
-- exactly where they already accept that one. The original batch row is
-- never updated or deleted. If the terms are still unobservable at the
-- close, the recapture refuses with the same 55000 the close already
-- handles, and nothing changes. It is not a sweep and has no schedule: it
-- runs only inside the close of the event that owns the fee.
--
-- Prize payment, places and amounts are not touched here. The engine's own
-- terminal path (fn_complete_tournament_terminal) pays them through the
-- canonical idempotent payers once the fee proves. Horses and humans are the
-- same: no branch here reads the horse flag.
--
-- The five live definitions this patches are pinned by md5, and each anchor
-- must occur exactly once, or the whole transaction refuses.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: to_regclass('public.accounting_tournament_fee_terms_recaptures') IS NOT NULL
-- @live-proof: position('fn_accounting_terms_recapture_valid' in pg_get_functiondef('public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure))>0
-- @live-proof: position('fn_accounting_terms_recapture_valid' in pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))>0
-- @live-proof: position('fn_accounting_recapture_terms_refused_tournament_fee' in pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure))>0

BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- The board this was proved against. If the backlog moved, refuse and re-probe.
DO $board$
DECLARE n bigint; amt numeric; tn bigint;
BEGIN
 SELECT count(*),COALESCE(sum(b.rake_amount),0),count(DISTINCT b.tournament_id) INTO n,amt,tn
  FROM public.accounting_tournament_fee_batches b JOIN public.rake_records r ON r.id=b.rake_record_id
  WHERE b.status='legacy_unverified' AND r.created_at>='2026-10-19T15:43:00Z' AND r.created_at<'2026-10-19T19:10:00Z'
   AND b.source_manifest->>'capture_reason' IN('accounting_terms_not_observed','accounting_terms_not_active');
 IF n<>1167 OR amt<>4753.55 OR tn<>1011 THEN
  RAISE EXCEPTION 'terms-refused fee board moved: % batches, % chips, % tournaments (expected 1167, 4753.55, 1011)',n,amt,tn;
 END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b JOIN public.rake_records r ON r.id=b.rake_record_id
   WHERE b.status='legacy_unverified' AND r.created_at>='2026-10-19T19:10:00Z') THEN
  RAISE EXCEPTION 'a terms-refused fee was saved after the producer fix; investigate before installing';
 END IF;
END $board$;

CREATE FUNCTION pg_temp.recapture_patch(sig text, expected text, old_parts text[], new_parts text[])
RETURNS void LANGUAGE plpgsql AS $patch$
DECLARE def text; i int;
BEGIN
 def:=pg_get_functiondef(sig::regprocedure);
 IF md5(def)<>expected THEN RAISE EXCEPTION 'definition drift: %',sig; END IF;
 FOR i IN 1..array_length(old_parts,1) LOOP
  IF (length(def)-length(replace(def,old_parts[i],'')))/length(old_parts[i])<>1 THEN
   RAISE EXCEPTION 'patch anchor drift: % part %',sig,i;
  END IF;
  def:=replace(def,old_parts[i],new_parts[i]);
 END LOOP;
 EXECUTE def;
END $patch$;

-- 1. The receipt. No foreign key (CLAUDE.md section 2 rule 7): the batch and
--    tournament tables are hot, and the validity reader joins both anyway.
CREATE TABLE public.accounting_tournament_fee_terms_recaptures(
 rake_record_id uuid PRIMARY KEY,
 tournament_id uuid NOT NULL,
 refusal text NOT NULL CHECK(refusal IN('accounting_terms_not_observed','accounting_terms_not_active')),
 original_batch jsonb NOT NULL CHECK(jsonb_typeof(original_batch)='object'),
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
 canonical_sources jsonb NOT NULL CHECK(jsonb_typeof(canonical_sources)='array' AND jsonb_array_length(canonical_sources) BETWEEN 1 AND 3),
 qualified_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(qualified_at)),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX accounting_tournament_fee_terms_recaptures_tournament_idx
 ON public.accounting_tournament_fee_terms_recaptures(tournament_id);
ALTER TABLE public.accounting_tournament_fee_terms_recaptures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_tournament_fee_terms_recaptures FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.accounting_tournament_fee_terms_recaptures TO service_role;
CREATE TRIGGER accounting_tournament_fee_terms_recaptures_immutable
 BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_terms_recaptures
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_terms_recaptures_no_truncate
 BEFORE TRUNCATE ON public.accounting_tournament_fee_terms_recaptures
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
COMMENT ON TABLE public.accounting_tournament_fee_terms_recaptures IS
 'One immutable receipt per legacy_unverified tournament fee batch whose original capture was refused only for unobserved/inactive accounting terms and was recaptured, at its tournament''s own close, through the producer''s evidence and contract. The original batch is kept verbatim. 20261019211349.';

-- 2. Is this batch's recapture exactly what is stored? Same shape as
--    fn_accounting_mixed_cutover_spin_proof_valid.
CREATE FUNCTION public.fn_accounting_terms_recapture_valid(p_rake_record_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp' SET "TimeZone" TO 'UTC'
AS $fn$
 SELECT EXISTS(
  SELECT 1 FROM public.accounting_tournament_fee_terms_recaptures p
   JOIN public.accounting_tournament_fee_batches b USING(rake_record_id)
   JOIN public.rake_records r ON r.id=b.rake_record_id
  WHERE p.rake_record_id=p_rake_record_id AND p.tournament_id=r.tournament_id AND b.tournament_id=r.tournament_id
   AND b.status='legacy_unverified' AND p.original_batch=to_jsonb(b)
   AND b.source_manifest->>'capture_reason'=p.refusal
   AND p.source_manifest=(b.source_manifest-'capture_reason')
   AND b.source_fingerprint=public.fn_accounting_tournament_fee_fingerprint(r)
   AND b.rake_amount=r.rake_amount
   AND p.canonical_sources=(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.player_id)
    FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=p_rake_record_id)
 );
$fn$;
REVOKE ALL ON FUNCTION public.fn_accounting_terms_recapture_valid(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- 3. The recapture. Every evidence check below is fn_capture_accounting_tournament_fee's,
--    in its order. The two provenance rules it applies that cannot hold for a
--    batch written in an earlier transaction are the only ones absent: the
--    record need not be created in this transaction, and the batch already
--    exists (it must be this exact legacy batch instead).
CREATE FUNCTION public.fn_accounting_recapture_terms_refused_tournament_fee(p_rake_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp' SET "TimeZone" TO 'UTC'
AS $fn$
DECLARE r public.rake_records%ROWTYPE; b public.accounting_tournament_fee_batches%ROWTYPE; t record;
 cutoff timestamptz; manifest jsonb; item jsonb; row_plan record; contract jsonb; e record; l record; tp record;
 actual_union uuid; source_type text; expected_kind text; player uuid; club uuid; registration uuid;
 ledger_id uuid; entitlement_id uuid; charged_at timestamptz; weight numeric; total_weight numeric:=0;
 total_cents bigint; floor_total bigint; remainder_cents bigint; credit numeric; allocated numeric:=0;
 seen_players uuid[]:='{}'; seen_entitlements uuid[]:='{}'; n integer; result_ids uuid[]:='{}'; new_id uuid;
 refusal text; refusal_state text;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='terms recapture: fee record missing'; END IF;
 -- The producer's own lock, so this can never race a live capture.
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text,0));
 IF public.fn_accounting_terms_recapture_valid(r.id) THEN
  RETURN jsonb_build_object('status','recaptured_after_terms_refusal','rake_record_id',r.id,'replayed',true,'payable',false);
 END IF;
 SELECT * INTO b FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'legacy_unverified'
  OR jsonb_typeof(b.source_manifest) IS DISTINCT FROM 'object'
  OR COALESCE(b.source_manifest->>'capture_reason','') NOT IN('accounting_terms_not_observed','accounting_terms_not_active')
  OR b.source_version<>2 OR b.tournament_id IS DISTINCT FROM r.tournament_id
  OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
  OR b.rake_amount IS DISTINCT FROM r.rake_amount OR cutoff IS NULL OR NOT isfinite(cutoff)
  OR r.created_at<cutoff OR NOT isfinite(r.created_at) OR r.created_at>clock_timestamp()
  OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL OR r.hand_id IS NOT NULL
  OR r.rake_amount IS NULL OR r.rake_amount<=0 OR r.rake_amount<>round(r.rake_amount,2)
  OR r.rake_amount::text IN('NaN','Infinity','-Infinity')
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_terms_recaptures WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=r.tournament_id)
 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',
   DETAIL='terms recapture: original batch eligibility failed'; END IF;
 BEGIN
  SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
  IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
   RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
  actual_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
  manifest:=b.source_manifest-'capture_reason';
  IF NOT(manifest ? 'union_id')
   OR NULLIF(manifest->>'union_id','')::uuid IS DISTINCT FROM actual_union
   OR manifest->>'game_type' IS DISTINCT FROM lower(t.tournament_type)
   OR jsonb_typeof(manifest->'contributors') IS DISTINCT FROM 'array'
   OR jsonb_array_length(manifest->'contributors')=0
  THEN RAISE EXCEPTION 'tournament_fee_producer_manifest_required' USING ERRCODE='23514'; END IF;
  expected_kind:=CASE r.source
   WHEN 'fn_register_for_tournament' THEN 'tournament_entry_fee'
   WHEN 'fn_register_horse_for_tournament' THEN 'tournament_entry_fee'
   WHEN 'fn_award_satellite_seat' THEN 'satellite_seat_entry_fee'
   WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket_entry_fee'
   WHEN 'fn_spin_book_entry' THEN 'spin_rake'
   WHEN 'process_tournament_rebuy' THEN r.metadata->>'kind' END;
  IF expected_kind IS NULL OR r.metadata->>'kind' IS DISTINCT FROM expected_kind
   OR (r.source='process_tournament_rebuy' AND expected_kind NOT IN('tournament_rebuy_fee','tournament_reentry_fee'))
  THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='23514'; END IF;
  n:=jsonb_array_length(manifest->'contributors');
  IF (r.source='fn_spin_book_entry' AND n<>3) OR (r.source<>'fn_spin_book_entry' AND n<>1) THEN
   RAISE EXCEPTION 'tournament_fee_contributor_count_invalid' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(manifest->'contributors') LOOP
   player:=(item->>'player_id')::uuid;club:=(item->>'club_id')::uuid;
   registration:=(item->>'registration_id')::uuid;ledger_id:=(item->>'charge_ledger_id')::uuid;
   entitlement_id:=(item->>'entitlement_id')::uuid;charged_at:=(item->>'charged_at')::timestamptz;
   weight:=(item->>'weight')::numeric;
   IF player IS NULL OR club IS NULL OR registration IS NULL OR ledger_id IS NULL OR entitlement_id IS NULL
    OR charged_at IS NULL OR NOT isfinite(charged_at) OR charged_at<cutoff OR charged_at>r.created_at
    OR weight IS NULL OR weight<=0 OR weight<>round(weight,2) OR weight::text IN('NaN','Infinity','-Infinity')
    OR player=ANY(seen_players) OR entitlement_id=ANY(seen_entitlements)
   THEN RAISE EXCEPTION 'tournament_fee_contributor_invalid' USING ERRCODE='23514'; END IF;
   seen_players:=array_append(seen_players,player);seen_entitlements:=array_append(seen_entitlements,entitlement_id);
   SELECT * INTO e FROM public.tournament_refund_entitlements WHERE id=entitlement_id;
   SELECT * INTO l FROM public.chip_ledger WHERE id=ledger_id;
   SELECT * INTO tp FROM public.tournament_players WHERE id=registration;
   IF e.id IS NULL OR l.id IS NULL OR tp.id IS NULL OR e.tournament_id IS DISTINCT FROM r.tournament_id
    OR e.user_id IS DISTINCT FROM player OR e.refund_wallet_club_id IS DISTINCT FROM club
    OR e.source_ledger_id IS DISTINCT FROM ledger_id OR e.created_at IS DISTINCT FROM charged_at
    OR tp.tournament_id IS DISTINCT FROM r.tournament_id OR tp.user_id IS DISTINCT FROM player OR tp.club_id IS DISTINCT FROM club
    OR l.created_at IS DISTINCT FROM charged_at OR l.amount IS DISTINCT FROM e.gross
   THEN RAISE EXCEPTION 'tournament_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
   IF r.source='fn_spin_book_entry' THEN
    IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM 'tournament_buyin'
     OR e.gross IS DISTINCT FROM weight OR l.from_type IS DISTINCT FROM 'player_wallet'
     OR l.from_entity_id IS DISTINCT FROM player OR l.to_type IS DISTINCT FROM 'prize_liability'
     OR l.to_entity_id IS DISTINCT FROM r.tournament_id OR l.club_id IS DISTINCT FROM club
     OR l.category IS DISTINCT FROM 'tournament_buyin'
     OR (r.player_contributions->>player::text)::numeric IS DISTINCT FROM weight
    THEN RAISE EXCEPTION 'spin_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSE
    IF e.refund_fee IS DISTINCT FROM r.rake_amount OR weight IS DISTINCT FROM r.rake_amount
     OR r.metadata->>'user_id' IS DISTINCT FROM player::text
    THEN RAISE EXCEPTION 'tournament_fee_amount_evidence_mismatch' USING ERRCODE='23514'; END IF;
    IF r.source IN('fn_register_for_tournament','fn_register_horse_for_tournament','process_tournament_rebuy') THEN
     source_type:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
     IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM source_type
      OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM player
      OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
      OR l.club_id IS DISTINCT FROM club OR l.category IS DISTINCT FROM source_type
      OR (r.source<>'process_tournament_rebuy' AND r.metadata->>'registration_id' IS DISTINCT FROM registration::text)
     THEN RAISE EXCEPTION 'tournament_fee_wallet_evidence_mismatch' USING ERRCODE='23514'; END IF;
    ELSIF r.source='fn_register_for_tournament_with_ticket' THEN
     IF e.entitlement_kind IS DISTINCT FROM 'tournament_ticket' OR e.registration_id IS DISTINCT FROM registration
      OR e.source_ticket_id IS NULL OR r.metadata->>'ticket_id' IS DISTINCT FROM e.source_ticket_id::text
      OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
      OR l.from_type IS DISTINCT FROM 'escrow' OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
      OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
      OR l.category IS DISTINCT FROM 'ticket_redeem'
     THEN RAISE EXCEPTION 'tournament_fee_ticket_evidence_mismatch' USING ERRCODE='23514'; END IF;
    ELSE
     IF e.entitlement_kind IS DISTINCT FROM 'satellite_seat' OR e.registration_id IS DISTINCT FROM registration
      OR e.source_satellite_id IS NULL OR r.metadata->>'satellite_id' IS DISTINCT FROM e.source_satellite_id::text
      OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
      OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
      OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
      OR l.category IS DISTINCT FROM 'tournament_buyin'
     THEN RAISE EXCEPTION 'tournament_fee_satellite_evidence_mismatch' USING ERRCODE='23514'; END IF;
    END IF;
   END IF;
   total_weight:=total_weight+weight;
  END LOOP;
  IF r.source='fn_spin_book_entry' THEN
   IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
    OR (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(manifest->'contributors')x)<>1
    OR NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger s
       WHERE s.id=(manifest->>'spin_reserve_id')::uuid AND s.tournament_id=r.tournament_id
        AND s.kind='contribution' AND s.seats=3 AND s.house_rake=r.rake_amount
        AND s.amount=total_weight-r.rake_amount AND s.buy_in=total_weight/3)
   THEN RAISE EXCEPTION 'spin_fee_reserve_evidence_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  -- Largest remainder; UUID order breaks exact fractional ties reproducibly.
  total_cents:=(r.rake_amount*100)::bigint;
  SELECT sum(floor(total_cents*(x->>'weight')::numeric/total_weight)) INTO floor_total
   FROM jsonb_array_elements(manifest->'contributors')x;
  remainder_cents:=total_cents-floor_total;
  FOR row_plan IN
   SELECT x,floor(total_cents*(x->>'weight')::numeric/total_weight)
     +CASE WHEN row_number() OVER(ORDER BY total_cents*(x->>'weight')::numeric/total_weight
        -floor(total_cents*(x->>'weight')::numeric/total_weight) DESC,x->>'player_id')<=remainder_cents THEN 1 ELSE 0 END cents
    FROM jsonb_array_elements(manifest->'contributors')x ORDER BY x->>'player_id'
  LOOP
   item:=row_plan.x;credit:=row_plan.cents/100.0;
   contract:=public.fn_accounting_earning_contract((item->>'club_id')::uuid,(item->>'player_id')::uuid,
     credit,actual_union,(item->>'charged_at')::timestamptz);
   IF contract->>'player_id' IS DISTINCT FROM item->>'player_id' OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
    OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
    OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
    OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
   THEN RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE='23514'; END IF;
   INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,
    coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
   VALUES(r.id,r.tournament_id,(item->>'player_id')::uuid,(item->>'club_id')::uuid,actual_union,
    NULLIF(contract->>'coordinator_union_id','')::uuid,manifest->>'game_type',(item->>'registration_id')::uuid,
    (item->>'charge_ledger_id')::uuid,(item->>'entitlement_id')::uuid,(item->>'charged_at')::timestamptz,credit,contract)
   RETURNING id INTO new_id;
   result_ids:=array_append(result_ids,new_id);allocated:=allocated+credit;
  END LOOP;
  IF allocated IS DISTINCT FROM r.rake_amount THEN
   RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_tournament_fee_terms_recaptures
   (rake_record_id,tournament_id,refusal,original_batch,source_manifest,canonical_sources)
  SELECT r.id,r.tournament_id,b.source_manifest->>'capture_reason',to_jsonb(b),manifest,
   jsonb_agg(to_jsonb(s) ORDER BY s.player_id)
   FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id;
  IF NOT public.fn_accounting_terms_recapture_valid(r.id) THEN
   RAISE EXCEPTION 'terms_recapture_receipt_not_conserved' USING ERRCODE='23514'; END IF;
 EXCEPTION WHEN OTHERS THEN
  -- One failed proof rolls back every source row and the receipt together.
  -- A lock or cancel keeps its own state; a refusal of the terms keeps its
  -- own words, which the close already handles; any other unproven evidence
  -- answers in the words the close already gives for an unproven fee, so a
  -- fee this cannot prove refuses exactly as it did before it existed.
  GET STACKED DIAGNOSTICS refusal=MESSAGE_TEXT,refusal_state=RETURNED_SQLSTATE;
  IF refusal_state IN('40P01','55P03','40001','57014')
   OR (refusal_state='55000' AND refusal IN('accounting_terms_not_observed','accounting_terms_not_active')) THEN
   RAISE EXCEPTION USING MESSAGE=refusal,ERRCODE=refusal_state;
  END IF;
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',
   DETAIL='terms recapture: '||refusal||' ('||refusal_state||')';
 END;
 RETURN jsonb_build_object('status','recaptured_after_terms_refusal','rake_record_id',r.id,
  'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',false,'payable',false);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_accounting_recapture_terms_refused_tournament_fee(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- 4. The net plan accepts the receipt exactly where it accepts a mixed-cutover Spin proof.
SELECT pg_temp.recapture_patch('public.fn_accounting_tournament_fee_net_plan(uuid)','0708c0296e82262735aea1fd626d5ada',
 ARRAY['(b.status IS DISTINCT FROM ''captured'' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(b.rake_record_id))'],
 ARRAY['(b.status IS DISTINCT FROM ''captured'' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(b.rake_record_id) AND NOT public.fn_accounting_terms_recapture_valid(b.rake_record_id))']);

-- 5. So does the week-quality reader's fast path (its slow path already calls the net plan).
SELECT pg_temp.recapture_patch('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)','506dc1f10ee2c9a6cfdef17db555de43',
 ARRAY['(b.status IS DISTINCT FROM ''captured'' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))'],
 ARRAY['(b.status IS DISTINCT FROM ''captured'' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id) AND NOT public.fn_accounting_terms_recapture_valid(rr.id))']);

-- 6. The close recaptures its own terms-refused fees, inside the same
--    subtransaction as the mixed-cutover qualification and the net plan, so a
--    failure anywhere rolls the recapture, claim, bank transfer and
--    recognition back together.
SELECT pg_temp.recapture_patch('public.fn_settle_tournament_rake(uuid,text)','15acb041213e75e30cefdff37e04179b',
 ARRAY['   PERFORM public.fn_accounting_qualify_mixed_cutover_spin_fee(v_raw.id);
  END LOOP;
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);'],
 ARRAY['   PERFORM public.fn_accounting_qualify_mixed_cutover_spin_fee(v_raw.id);
  END LOOP;
  -- 20261019211349: a fee whose original capture was refused only because its
  -- accounting terms were not yet observable is recaptured here, at its own
  -- close, through the producer''s evidence and contract. Still unobservable
  -- terms refuse in the same words handled below.
  FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament AND r.rake_amount>0
    AND b.status=''legacy_unverified''
    AND b.source_manifest->>''capture_reason'' IN(''accounting_terms_not_observed'',''accounting_terms_not_active'')
   ORDER BY r.id LOOP
   PERFORM public.fn_accounting_recapture_terms_refused_tournament_fee(v_raw.id);
  END LOOP;
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);']);

COMMIT;
