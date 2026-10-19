-- Reserved by scripts/new-migration.mjs. Follow-up to PR7472.
-- A satellite seat's posted ledger belongs to its source satellite, while
-- entitlement, registration and destination liability belong to the target.
-- Preserve every amount, from/to identity, historical term and replay check.
-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_qualify_owner_direct_fee(uuid)'::regprocedure))='d120e3c6216bc8a4a715bc5b96a2fc3e'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_qualify_owner_direct_fee(uuid)'::regprocedure))<>'5ba3e7c498a79fd41e403a6d83fb6bc7' THEN
 RAISE EXCEPTION 'OWNER_FEE_SATELLITE_PREIMAGE_REQUIRED'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.fn_accounting_qualify_owner_direct_fee(p_rake_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET TimeZone TO 'UTC'
AS $function$
DECLARE
 r public.rake_records%ROWTYPE; t record; previous record; cutoff timestamptz;
 manifest jsonb; item jsonb; contributors jsonb:='[]'; contract jsonb;
 e record; l record; tp record; source_type text; expected_kind text;
 player uuid; club uuid; registration uuid; ledger_id uuid; entitlement_id uuid;
 actual_union uuid; charged_at timestamptz; weight numeric; total_weight numeric:=0;
 total_cents bigint; floor_total bigint; remainder_cents bigint; credit numeric;
 allocated numeric:=0; seen_players uuid[]:='{}'; seen_entitlements uuid[]:='{}';
 missing_owner boolean:=false; missing_reason text; incident public.accounting_owner_direct_fee_incident%ROWTYPE;
 fingerprint text; result_ids uuid[]:='{}'; new_id uuid; n integer; row_plan record;
BEGIN
 -- Private EXECUTE grants are the boundary: this owner-only helper also runs
 -- inside a legitimate authenticated human's original charge transaction.
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 IF NOT FOUND OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL
  OR r.hand_id IS NOT NULL OR r.rake_amount IS NULL OR r.rake_amount<=0
  OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text,0));
 fingerprint:=public.fn_accounting_tournament_fee_fingerprint(r);
 IF public.fn_accounting_owner_direct_fee_proof_valid(r.id) THEN
  RETURN jsonb_build_object('status','captured','rake_record_id',r.id,'replayed',true,'payable',false);
 END IF;
 SELECT * INTO previous FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 SELECT * INTO incident FROM public.accounting_owner_direct_fee_incident WHERE singleton;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF previous.rake_record_id IS NULL OR incident.singleton IS DISTINCT FROM true
  OR previous.status IS DISTINCT FROM 'legacy_unverified'
  OR previous.source_version IS DISTINCT FROM 2
  OR previous.source_manifest->>'capture_reason' IS DISTINCT FROM 'accounting_terms_not_observed'
  OR previous.source_fingerprint IS DISTINCT FROM fingerprint
  OR previous.tournament_id IS DISTINCT FROM r.tournament_id
  OR previous.rake_amount IS DISTINCT FROM r.rake_amount
  OR r.created_at<incident.starts_at OR r.created_at>=incident.ends_at
  OR cutoff IS NULL OR r.created_at<cutoff
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_owner_direct_fee_proofs WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=r.tournament_id)
 THEN RAISE EXCEPTION 'owner_fee_original_batch_unproven' USING ERRCODE='55000'; END IF;
 SELECT id,club_id,union_id,is_private,tournament_type,status INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR upper(t.status) IS DISTINCT FROM 'COMPLETING' OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514';
 END IF;
 actual_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 manifest:=previous.source_manifest-'capture_reason';
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'object'
  OR NOT(manifest ? 'union_id')
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
 THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(manifest->'contributors');
 IF (r.source='fn_spin_book_entry' AND n<>3) OR (r.source<>'fn_spin_book_entry' AND n<>1) THEN
  RAISE EXCEPTION 'tournament_fee_contributor_count_invalid' USING ERRCODE='23514';
 END IF;
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
   OR l.tournament_id IS DISTINCT FROM (CASE WHEN r.source='fn_award_satellite_seat' THEN e.source_satellite_id ELSE r.tournament_id END)
   OR l.status IS DISTINCT FROM 'posted'
  THEN RAISE EXCEPTION 'tournament_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  IF r.source='fn_spin_book_entry' THEN
   -- A Spin has one aggregate fee, three exact paid entries, and one immutable
   -- reserve contribution. Weights are paid entry amounts, never mutable rebuys.
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
  contributors:=contributors||jsonb_build_array(item);total_weight:=total_weight+weight;
 END LOOP;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
   OR (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(contributors)x)<>1
   OR NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger s
      WHERE s.id=(manifest->>'spin_reserve_id')::uuid AND s.tournament_id=r.tournament_id
       AND s.kind='contribution' AND s.seats=3 AND s.house_rake=r.rake_amount
       AND s.amount=total_weight-r.rake_amount AND s.buy_in=total_weight/3)
  THEN RAISE EXCEPTION 'spin_fee_reserve_evidence_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 total_cents:=(r.rake_amount*100)::bigint;
 SELECT sum(floor(total_cents*(x->>'weight')::numeric/total_weight)) INTO floor_total FROM jsonb_array_elements(contributors)x;
 remainder_cents:=total_cents-floor_total;
 -- Largest remainder; UUID order breaks exact fractional ties reproducibly.
 FOR row_plan IN
  SELECT x, floor(total_cents*(x->>'weight')::numeric/total_weight)
    +CASE WHEN row_number() OVER(ORDER BY total_cents*(x->>'weight')::numeric/total_weight
       -floor(total_cents*(x->>'weight')::numeric/total_weight) DESC,x->>'player_id')<=remainder_cents THEN 1 ELSE 0 END cents
   FROM jsonb_array_elements(contributors)x ORDER BY x->>'player_id'
 LOOP
  item:=row_plan.x;credit:=row_plan.cents/100.0;
  contract:=public.fn_accounting_earning_contract((item->>'club_id')::uuid,(item->>'player_id')::uuid,
    credit,actual_union,(item->>'charged_at')::timestamptz);
  IF contract->>'player_id' IS DISTINCT FROM item->>'player_id' OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
   OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
   OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
   OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
  THEN RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE='23514'; END IF;
  -- At least one historical contributor must prove this exact owner-agreement
  -- defect, rather than converting an unrelated missing agreement into success.
  IF EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=(item->>'club_id')::uuid
    AND owner_club.owner_id=NULLIF(contract#>>'{membership,terms,agent_id}','')::uuid) THEN
   missing_reason:=NULL;
   BEGIN PERFORM public.fn_accounting_agent_terms_at((item->>'club_id')::uuid,
     (contract#>>'{membership,terms,agent_id}')::uuid,(item->>'charged_at')::timestamptz);
   EXCEPTION WHEN SQLSTATE '55000' THEN missing_reason:=SQLERRM; END;
   IF missing_reason='accounting_terms_not_observed' AND contract->'tiers'='[]'::jsonb THEN missing_owner:=true; END IF;
  END IF;
  INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,
   coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
  VALUES(r.id,r.tournament_id,(item->>'player_id')::uuid,(item->>'club_id')::uuid,actual_union,
   NULLIF(contract->>'coordinator_union_id','')::uuid,manifest->>'game_type',(item->>'registration_id')::uuid,
   (item->>'charge_ledger_id')::uuid,(item->>'entitlement_id')::uuid,(item->>'charged_at')::timestamptz,credit,contract)
  RETURNING id INTO new_id;
  result_ids:=array_append(result_ids,new_id);allocated:=allocated+credit;
 END LOOP;
 IF allocated IS DISTINCT FROM r.rake_amount THEN RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
 IF NOT missing_owner THEN RAISE EXCEPTION 'owner_fee_missing_original_owner_agreement_unproven' USING ERRCODE='55000'; END IF;
 INSERT INTO public.accounting_owner_direct_fee_proofs(rake_record_id,tournament_id,original_batch,source_manifest,canonical_sources)
 SELECT r.id,r.tournament_id,to_jsonb(previous),manifest,jsonb_agg(to_jsonb(s) ORDER BY s.player_id)
 FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id;
 IF NOT public.fn_accounting_owner_direct_fee_proof_valid(r.id) THEN RAISE EXCEPTION 'owner_fee_proof_not_conserved' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
  'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',false,'payable',false);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_accounting_qualify_owner_direct_fee(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $post$ BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_qualify_owner_direct_fee(uuid)'::regprocedure))<>'d120e3c6216bc8a4a715bc5b96a2fc3e' THEN RAISE EXCEPTION 'OWNER_FEE_SATELLITE_POSTIMAGE_REQUIRED'; END IF;
END $post$;
COMMIT;
