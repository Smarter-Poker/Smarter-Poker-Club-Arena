-- CANDIDATE ONLY: one charge/recognition authority for all chip tournament fees.
-- Requires shared cash contract/posting components and durable period queue.
-- Roll out the server v2 completion receipt parser BEFORE activating this SQL.
-- Commission formula is inherited unchanged; no historical rates are invented.
-- Full production-schema lifecycle replay and payout-model signoff remain gates.
DO $tournament_preimages$ BEGIN
 IF to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)'))) IS DISTINCT FROM '6dac23baee41ff69ee0e1243f0a26c8e' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.atomic_cancel_tournament(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_attribute_tournament_rake(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_attribute_tournament_rake(uuid)'))) IS DISTINCT FROM 'c4bfeb1900bd57a4d0c1d4543f651431' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_attribute_tournament_rake(uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_backpay_tournament_rake_attribution(integer)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_backpay_tournament_rake_attribution(integer)'))) IS DISTINCT FROM '93211a9b37aeb8e4af8d308c6248163c' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_backpay_tournament_rake_attribution(integer)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_ca_satellite_settlement_receipt(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'))) IS DISTINCT FROM '706ce8ee53b87a2a5547443b460ceb93' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_ca_satellite_settlement_receipt(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_ca_tournament_terminal_receipt(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'))) IS DISTINCT FROM '317b582f72d120c745a5b7073d9b559a' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'))) IS DISTINCT FROM '062c9a1314f33a5c8af4fdf5e00a046d' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_repair_tournament_rake_attribution(integer)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_repair_tournament_rake_attribution(integer)'))) IS DISTINCT FROM '1d2d9c8212bca8d0e9ab0984c425e815' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_repair_tournament_rake_attribution(integer)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'))) IS DISTINCT FROM 'b36386009f2b3f568fc648efbccaf7b4' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_settle_tournament_rake(uuid,text)'))) IS DISTINCT FROM '46128439ae7a46e4fd8ea2889a7dddf8' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_settle_tournament_rake(uuid,text)' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_settle_tournament_rake(uuid,text)')
  AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
  RAISE EXCEPTION 'tournament_settlement_permissions_changed' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)'))) IS DISTINCT FROM '6361f556eac2ff2940e3f49f485176d0' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_tournament_finish_readiness(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_tournament_rake_settlement_check(integer,integer)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_tournament_rake_settlement_check(integer,integer)'))) IS DISTINCT FROM '65dc8a03543053bec16f78b78c513b9b' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_tournament_rake_settlement_check(integer,integer)' USING ERRCODE='55000'; END IF;
END $tournament_preimages$;

DO $tournament_dependencies$ BEGIN
 IF to_regprocedure('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)') IS NULL
  OR to_regprocedure('public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb)') IS NULL
  OR to_regclass('public.accounting_period_recompute_requests') IS NULL
  OR to_regclass('public.accounting_routed_settlement_runs') IS NULL THEN
  RAISE EXCEPTION 'canonical_accounting_dependencies_missing' USING ERRCODE='55000'; END IF;
END $tournament_dependencies$;

-- BEGIN tournament-fee-receipts-draft.sql
-- DRAFT ONLY. Not a deployable migration: producer stamps, terminal adapter,
-- shared commission INSERT guard, R1/R3 and source quality gates must land together.
-- This is a source receipt capture authority, not a second settlement scheduler.
CREATE TABLE public.accounting_tournament_fee_cutover (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), starts_at timestamptz NOT NULL
);
INSERT INTO public.accounting_tournament_fee_cutover VALUES(true,transaction_timestamp());
CREATE TABLE public.accounting_tournament_fee_batches (
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 tournament_id uuid NOT NULL, source_fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'captured' CHECK(status IN('captured','legacy_unverified')),
 source_version integer NOT NULL DEFAULT 2 CHECK(source_version=2), source_manifest jsonb,
 CHECK(status='legacy_unverified' OR jsonb_typeof(source_manifest)='object'),
 rake_amount numeric NOT NULL CHECK(rake_amount>0 AND rake_amount=round(rake_amount,2)
   AND rake_amount::text NOT IN('NaN','Infinity','-Infinity')),
 captured_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE public.accounting_tournament_fee_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rake_record_id uuid NOT NULL REFERENCES public.accounting_tournament_fee_batches(rake_record_id),
 tournament_id uuid NOT NULL, player_id uuid NOT NULL, club_id uuid NOT NULL,
 union_id uuid, coordinator_union_id uuid, game_type text NOT NULL,
 registration_id uuid NOT NULL, source_charge_ledger_id uuid NOT NULL,
 source_entitlement_id uuid NOT NULL, charged_at timestamptz NOT NULL,
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2)
   AND rake_credit::text NOT IN('NaN','Infinity','-Infinity')),
 contract jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(rake_record_id,player_id), UNIQUE(source_entitlement_id)
);
CREATE INDEX accounting_tournament_fee_sources_event ON public.accounting_tournament_fee_sources(tournament_id,rake_record_id);
ALTER TABLE public.accounting_tournament_fee_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_cutover,public.accounting_tournament_fee_batches,
 public.accounting_tournament_fee_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_tournament_fee_cutover,public.accounting_tournament_fee_batches,
 public.accounting_tournament_fee_sources TO service_role;

CREATE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row public.rake_records)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)::text)
 FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
  'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
  'rake_method','returned_uncalled']::text[])field
$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_fingerprint(public.rake_records)
 FROM PUBLIC,anon,authenticated,service_role;

-- Called by the original producer AFTER its charge/roster/entitlement receipts
-- exist, in the SAME transaction. A deferred constraint trigger must additionally
-- require a captured batch for every new supported positive chip fee at COMMIT.
-- Required producer metadata.accounting_fee_source is versioned, exact-ID linkage;
-- it is never inferred from today's membership or the remaining tournament field.
CREATE FUNCTION public.fn_capture_accounting_tournament_fee(p_rake_record_id uuid,p_manifest jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE
 r public.rake_records%ROWTYPE; t record; previous record; cutoff timestamptz;
 manifest jsonb; item jsonb; contributors jsonb:='[]'; contract jsonb;
 e record; l record; tp record; source_type text; expected_kind text;
 player uuid; club uuid; registration uuid; ledger_id uuid; entitlement_id uuid;
 actual_union uuid; charged_at timestamptz; weight numeric; total_weight numeric:=0;
 total_cents bigint; floor_total bigint; remainder_cents bigint; credit numeric;
 allocated numeric:=0; seen_players uuid[]:='{}'; seen_entitlements uuid[]:='{}';
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
 SELECT * INTO previous FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 IF FOUND THEN
  IF previous.source_fingerprint IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'captured_tournament_fee_source_changed' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(id ORDER BY player_id),count(*),sum(rake_credit)
   INTO result_ids,n,allocated FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id;
  IF n=0 OR allocated IS DISTINCT FROM previous.rake_amount THEN
   RAISE EXCEPTION 'captured_tournament_fee_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
   'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',true,'payable',false);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF cutoff IS NULL OR r.created_at<cutoff OR r.created_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000';
 END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514';
 END IF;
 actual_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 manifest:=COALESCE(p_manifest,r.metadata->'accounting_fee_source');
 IF (p_manifest IS NULL AND r.metadata->>'accounting_source_version' IS DISTINCT FROM '2')
  OR jsonb_typeof(manifest) IS DISTINCT FROM 'object'
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
 INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,source_manifest)
  VALUES(r.id,r.tournament_id,fingerprint,r.rake_amount,manifest);
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
  INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,
   coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
  VALUES(r.id,r.tournament_id,(item->>'player_id')::uuid,(item->>'club_id')::uuid,actual_union,
   NULLIF(contract->>'coordinator_union_id','')::uuid,manifest->>'game_type',(item->>'registration_id')::uuid,
   (item->>'charge_ledger_id')::uuid,(item->>'entitlement_id')::uuid,(item->>'charged_at')::timestamptz,credit,contract)
  RETURNING id INTO new_id;
  result_ids:=array_append(result_ids,new_id);allocated:=allocated+credit;
 END LOOP;
 IF allocated IS DISTINCT FROM r.rake_amount THEN RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
  'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',false,'payable',false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Receipt immutability/COMMIT coverage are deliberately specified in the handoff
-- pending integration with existing cancelled/terminal evidence guards. No test
-- of this draft is a claim that an uncaptured live producer is now safe.

-- END tournament-fee-receipts-draft.sql

-- BEGIN tournament-fee-producer-adapter-draft.sql
-- DRAFT. Installs one common source capture hook for every chip fee producer.
-- The hook runs after original atomic receipts exist. No membership is guessed:
-- the immutable funding entitlement names the club, user, charge and timestamp.
CREATE FUNCTION public.fn_stamp_accounting_tournament_fee(p_rake_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r public.rake_records%ROWTYPE;t record;e record;tp record;item record;reserve_id uuid;
 manifest jsonb;contributors jsonb:='[]';game_union uuid;expected_entitlement text;
 expected_category text;uid uuid;reg uuid;count_rows int;cutoff timestamptz;legacy boolean:=false;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR UPDATE;
 IF NOT FOUND OR NOT r.is_tournament OR r.rake_amount<=0 THEN
  RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id) THEN
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id AND status='legacy_unverified') THEN
   RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
  END IF;
  RETURN public.fn_capture_accounting_tournament_fee(r.id);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF r.created_at IS DISTINCT FROM transaction_timestamp() OR cutoff IS NULL OR r.created_at<cutoff THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000'; END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 game_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3 THEN
   RAISE EXCEPTION 'spin_fee_exact_paid_contributors_required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
   SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=item.player_id;
   IF NOT FOUND OR tp.club_id IS NULL THEN RAISE EXCEPTION 'spin_fee_entry_club_missing' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
   SELECT * INTO e FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   contributors:=contributors||jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
    'registration_id',tp.id,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',item.weight));
   legacy:=legacy OR e.created_at<cutoff;
  END LOOP;
  SELECT count(*) INTO count_rows FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
  IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_reserve_required' USING ERRCODE='23514'; END IF;
  SELECT id INTO reserve_id FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
 ELSE
  IF NOT COALESCE(r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false) THEN
   RAISE EXCEPTION 'tournament_fee_exact_player_required' USING ERRCODE='23514'; END IF;
  uid:=(r.metadata->>'user_id')::uuid;
  expected_entitlement:=CASE r.source WHEN 'fn_register_for_tournament' THEN 'wallet_charge'
   WHEN 'fn_register_horse_for_tournament' THEN 'wallet_charge' WHEN 'process_tournament_rebuy' THEN 'wallet_charge'
   WHEN 'fn_award_satellite_seat' THEN 'satellite_seat' WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket' END;
  expected_category:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
  IF expected_entitlement IS NULL THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
  reg:=NULLIF(r.metadata->>'registration_id','')::uuid;
  IF reg IS NULL AND r.source='process_tournament_rebuy' THEN
   SELECT id INTO reg FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=uid;
  END IF;
  IF reg IS NULL THEN RAISE EXCEPTION 'tournament_fee_exact_registration_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  IF count_rows<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  contributors:=jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
   'registration_id',reg,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',r.rake_amount));
 END IF;
 IF legacy THEN
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified');
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
 END IF;
 manifest:=jsonb_build_object('union_id',game_union,'game_type',lower(t.tournament_type),'contributors',contributors,'spin_reserve_id',reserve_id);
 -- Original tournament evidence may already be sealed by a satellite receipt.
 -- Capture its manifest on the accounting batch; never rewrite that raw row.
 BEGIN
  RETURN public.fn_capture_accounting_tournament_fee(r.id,manifest);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  -- Missing observed agreement may not destroy a proved original fee charge.
  -- This subtransaction rolls back every contributor receipt before recording
  -- the entire batch as unavailable. No partial commission can become payable.
  IF SQLERRM NOT IN('accounting_terms_not_observed','accounting_terms_not_active') THEN RAISE; END IF;
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status,source_manifest)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified',
    manifest||jsonb_build_object('capture_reason',SQLERRM));
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false,'reason',SQLERRM);
 END;
END $function$;
REVOKE ALL ON FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_tournament_fee_commit_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN
 PERFORM public.fn_stamp_accounting_tournament_fee(NEW.id);RETURN NULL;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_commit_capture() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER accounting_tournament_fee_commit_capture AFTER INSERT ON public.rake_records
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.is_tournament IS TRUE AND NEW.rake_amount>0)
 EXECUTE FUNCTION public.fn_accounting_tournament_fee_commit_capture();

CREATE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN
 RAISE EXCEPTION 'accounting_tournament_fee_receipt_is_immutable' USING ERRCODE='55000';
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();

CREATE FUNCTION public.fn_accounting_tournament_fee_source_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=OLD.id)
  AND (TG_OP='DELETE' OR public.fn_accounting_tournament_fee_fingerprint(OLD) IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(NEW)) THEN
  RAISE EXCEPTION 'captured_tournament_fee_source_is_immutable' USING ERRCODE='55000';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_source_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_fee_source_immutable BEFORE UPDATE OR DELETE ON public.rake_records
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_source_immutable();

-- END tournament-fee-producer-adapter-draft.sql

-- BEGIN tournament-fee-recognition-draft.sql
-- DRAFT source-net proof. Whole source-fee reversals only: no invented partial
-- allocation or current membership/rate lookup. The known unregister/cancel
-- producers name complete original fee rows. Dependencies are resolved by ID,
-- including cancellation after an earlier unregister and re-entry.
CREATE FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE refund_row record;raw_total numeric;positive_total numeric;refunded_total numeric:=0;expected numeric;raw_reference_sum numeric;
 positive_ids uuid[];negative_ids uuid[];processed uuid[]:='{}';refunded uuid[]:='{}';refs uuid[];direct_positive uuid[];
 pending uuid[];new_refunds uuid[];nested uuid[];covered uuid[];ref uuid;covered_ref uuid;
 refund_map jsonb:='{}';progress boolean;actual_union uuid;scope_count int;active_ids uuid[];refunded_ids uuid[];fingerprint text;
BEGIN
 IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'tournament_required' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
   AND (r.rake_amount IS NULL OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.hand_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'tournament_fee_source_invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount>0),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount<0),'{}'),COALESCE(sum(rake_amount),0),COALESCE(sum(rake_amount) FILTER(WHERE rake_amount>0),0)
 INTO positive_ids,negative_ids,raw_total,positive_total FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF raw_total<0 THEN RAISE EXCEPTION 'tournament_fee_net_negative' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   WHERE r.id=ANY(positive_ids) AND (b.status IS DISTINCT FROM 'captured' OR b.tournament_id IS DISTINCT FROM p_tournament_id
    OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
    OR b.rake_amount IS DISTINCT FROM r.rake_amount
    OR b.rake_amount IS DISTINCT FROM (SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id))) THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=p_tournament_id AND NOT(s.rake_record_id=ANY(positive_ids))) THEN
  RAISE EXCEPTION 'tournament_fee_source_scope_changed' USING ERRCODE='23514'; END IF;
 SELECT count(DISTINCT COALESCE(union_id::text,'private')),(array_agg(union_id))[1] INTO scope_count,actual_union
  FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 IF scope_count>1 THEN RAISE EXCEPTION 'tournament_fee_game_scope_changed' USING ERRCODE='23514'; END IF;
 pending:=negative_ids;
 WHILE cardinality(pending)>0 LOOP
  progress:=false;
  FOR refund_row IN SELECT * FROM public.rake_records WHERE id=ANY(pending) ORDER BY created_at,id LOOP
   IF refund_row.source NOT IN('fn_unregister_from_tournament','atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_unsupported' USING ERRCODE='55000'; END IF;
   IF refund_row.metadata ? 'original_rake_record_ids' AND jsonb_typeof(refund_row.metadata->'original_rake_record_ids')='array' THEN
    SELECT array_agg(value::uuid ORDER BY value) INTO refs FROM jsonb_array_elements_text(refund_row.metadata->'original_rake_record_ids');
   ELSIF refund_row.metadata ? 'original_rake_record_id' THEN refs:=ARRAY[(refund_row.metadata->>'original_rake_record_id')::uuid];
   ELSE RAISE EXCEPTION 'tournament_fee_refund_source_ids_missing' USING ERRCODE='23514'; END IF;
   IF refs IS NULL OR cardinality(refs)=0 OR cardinality(refs)<>(SELECT count(DISTINCT x) FROM unnest(refs)x)
    OR refund_row.id=ANY(refs) OR EXISTS(SELECT 1 FROM unnest(refs)x WHERE NOT(x=ANY(positive_ids||negative_ids))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_ids_invalid' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(id) FILTER(WHERE rake_amount>0),'{}'),COALESCE(array_agg(id) FILTER(WHERE rake_amount<0),'{}'),sum(rake_amount)
    INTO direct_positive,nested,raw_reference_sum FROM public.rake_records WHERE id=ANY(refs);
   IF NOT(nested<@processed) THEN CONTINUE; END IF;
   covered:='{}';
   FOREACH ref IN ARRAY nested LOOP
    FOR covered_ref IN SELECT value::uuid FROM jsonb_array_elements_text(refund_map->ref::text) LOOP
     covered:=array_append(covered,covered_ref);
    END LOOP;
   END LOOP;
   IF NOT(covered<@direct_positive) THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_incomplete' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM unnest(direct_positive)x WHERE x=ANY(refunded) AND NOT(x=ANY(covered))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_duplicates_prior_refund' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO new_refunds FROM unnest(direct_positive)x WHERE NOT(x=ANY(refunded));
   SELECT COALESCE(sum(rake_amount),0) INTO expected FROM public.rake_records WHERE id=ANY(new_refunds);
   IF expected<=0 OR expected IS DISTINCT FROM -refund_row.rake_amount OR raw_reference_sum IS DISTINCT FROM expected
    OR EXISTS(SELECT 1 FROM public.rake_records q WHERE q.id=ANY(refs) AND (q.club_id IS DISTINCT FROM refund_row.club_id
      OR (q.metadata->>'user_id' IS DISTINCT FROM refund_row.metadata->>'user_id')
      OR q.created_at>refund_row.created_at)) THEN
    RAISE EXCEPTION 'tournament_fee_refund_not_exact_full_sources' USING ERRCODE='23514'; END IF;
   -- A player refund needs its immutable unregistration or cancellation witness.
   -- Spin unwind uses the cancellation's exact reversal-id list and zero net.
   IF refund_row.source='fn_unregister_from_tournament' THEN
    IF NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u WHERE u.tournament_id=p_tournament_id
      AND refund_row.id=ANY(u.fee_reversal_ids) AND refs<@u.fee_source_rake_record_ids
      AND u.user_id::text=refund_row.metadata->>'user_id') THEN
     RAISE EXCEPTION 'tournament_fee_refund_receipt_missing' USING ERRCODE='23514'; END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id=p_tournament_id
      AND refund_row.id=ANY(c.fee_reversal_ids) AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before) THEN
     RAISE EXCEPTION 'tournament_fee_cancellation_receipt_missing' USING ERRCODE='23514'; END IF;
   END IF;
   refunded:=refunded||new_refunds;refunded_total:=refunded_total+expected;
   refund_map:=refund_map||jsonb_build_object(refund_row.id::text,to_jsonb(direct_positive));
   processed:=array_append(processed,refund_row.id);pending:=array_remove(pending,refund_row.id);progress:=true;
  END LOOP;
  IF NOT progress THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_cycle' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF positive_total-refunded_total IS DISTINCT FROM raw_total THEN
  RAISE EXCEPTION 'tournament_fee_net_not_conserved' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE NOT(rake_record_id=ANY(refunded))),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_record_id=ANY(refunded)),'{}')
 INTO active_ids,refunded_ids FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')) INTO fingerprint
  FROM public.rake_records r WHERE tournament_id=p_tournament_id AND is_tournament;
 RETURN jsonb_build_object('accounting_version',2,'status','proven','tournament_id',p_tournament_id,
  'source_fingerprint',fingerprint,'union_id',actual_union,'gross_fee',positive_total,'refunded_fee',refunded_total,
  'net_fee',raw_total,'active_source_ids',active_ids,'refunded_source_ids',refunded_ids,'payable',false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.accounting_tournament_fee_recognitions (
 tournament_id uuid PRIMARY KEY, recognized_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('recognized','cancelled','banked_accrual_deferred')),
 net_rake numeric NOT NULL CHECK(net_rake>=0 AND net_rake=round(net_rake,2) AND net_rake::text NOT IN('NaN','Infinity','-Infinity')),
 union_id uuid,bank_club_id uuid,union_wallet_transaction_id uuid UNIQUE REFERENCES public.union_wallet_transactions(id),
 bank_journal_id uuid UNIQUE REFERENCES public.chip_ledger(id),source_fingerprint text NOT NULL,plan jsonb NOT NULL,
 CHECK(net_rake=0 OR bank_club_id IS NOT NULL),
 CHECK((net_rake=0 AND union_wallet_transaction_id IS NULL AND bank_journal_id IS NULL)
  OR (net_rake>0 AND ((union_wallet_transaction_id IS NOT NULL)::int+(bank_journal_id IS NOT NULL)::int)=1))
);
CREATE TABLE public.accounting_tournament_recognized_sources (
 source_id uuid PRIMARY KEY REFERENCES public.accounting_tournament_fee_sources(id),
 tournament_id uuid NOT NULL REFERENCES public.accounting_tournament_fee_recognitions(tournament_id),
 recognized_at timestamptz NOT NULL, disposition text NOT NULL CHECK(disposition IN('earned','refunded')),
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2) AND rake_credit::text NOT IN('NaN','Infinity','-Infinity'))
);
CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources(recognized_at,tournament_id);
ALTER TABLE public.accounting_tournament_fee_recognitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_recognized_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_recognitions,public.accounting_tournament_recognized_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_tournament_fee_recognitions,public.accounting_tournament_recognized_sources TO service_role;
CREATE TRIGGER accounting_tournament_fee_recognitions_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_recognitions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_recognized_sources FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_recognitions_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_recognitions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_recognized_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();

-- Bank IDs are actual receipts read immediately after the existing fee transfer.
-- The whole caller transaction (fee bank, recognition, all commission rows,
-- stats, queue requests, terminal evidence) must roll back on any refusal.
CREATE FUNCTION public.fn_recognize_accounting_tournament_fees(p_tournament_id uuid,p_recognized_at timestamptz,
 p_bank_club_id uuid,p_union_wallet_transaction_id uuid,p_bank_journal_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE plan jsonb;prior record;source record;bank record;active_ids uuid[];refunded_ids uuid[];
 net_fee numeric;game_union uuid;rows_written int:=0;users_count int;source_count int;vip record;week_date date;
BEGIN
 IF p_recognized_at IS NULL OR p_recognized_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_original_recognition_transaction_required' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:'||p_tournament_id::text,0));
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,p_recognized_at);
 plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 SELECT * INTO prior FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.source_fingerprint IS DISTINCT FROM plan->>'source_fingerprint' THEN
   RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
  RETURN prior.plan||jsonb_build_object('status',prior.status,'payable',prior.status='recognized','replayed',true,'recognized_at',prior.recognized_at);
 END IF;
 net_fee:=(plan->>'net_fee')::numeric;game_union:=NULLIF(plan->>'union_id','')::uuid;
 IF p_bank_club_id IS NULL AND net_fee>0 THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
 PERFORM public.fn_accounting_tournament_bank_proof(p_tournament_id,p_recognized_at,p_bank_club_id,game_union,net_fee,p_union_wallet_transaction_id,p_bank_journal_id);
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(plan->'active_source_ids');
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(plan->'refunded_source_ids');
 INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,
  union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
 VALUES(p_tournament_id,p_recognized_at,CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,net_fee,game_union,p_bank_club_id,
  p_union_wallet_transaction_id,p_bank_journal_id,plan->>'source_fingerprint',plan);
 INSERT INTO public.accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit)
 SELECT s.id,p_tournament_id,p_recognized_at,CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END,
  CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
 FROM public.accounting_tournament_fee_sources s WHERE s.id=ANY(active_ids||refunded_ids);
 FOR source IN SELECT * FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids) ORDER BY club_id,player_id,id LOOP
  rows_written:=rows_written+public.fn_post_accounting_commission_source(source.id,'tournament_fee_accrual',p_recognized_at,source.contract);
  -- Statistics use the real source record/player pair. The source credit is
  -- recognized once; a retry is guarded by the terminal recognition row above.
  PERFORM public.apply_rakeback_player_stats(source.rake_record_id,source.player_id,source.club_id,0,source.rake_credit);
 END LOOP;
 -- VIP already has a unique event/player source key. Preserve its original
 -- settlement-time grouping while giving it exact conserved contributor cents.
 FOR vip IN SELECT player_id,sum(rake_credit) credit FROM public.accounting_tournament_fee_sources
  WHERE id=ANY(active_ids) GROUP BY player_id ORDER BY player_id LOOP
  IF vip.credit>0 THEN PERFORM public.fn_award_vip_credit(vip.player_id,vip.credit,'tournament_rake',p_tournament_id,'Tournament rake generated'); END IF;
 END LOOP;
 week_date:=(public.fn_union_week_start(p_recognized_at) AT TIME ZONE 'America/Los_Angeles')::date;
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end,status)
 SELECT DISTINCT club_id,week_date,week_date+6,'pending' FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids)
 ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET status='pending',reason=NULL,last_result='{}'::jsonb,last_requested_at=transaction_timestamp();
 SELECT count(DISTINCT player_id),count(*) INTO users_count,source_count FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids);
 RETURN plan||jsonb_build_object('status',CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,
  'recognized_at',p_recognized_at,'payable',net_fee>0,'replayed',false,'commission_rows',rows_written,
  'attributed_users',users_count,'source_count',source_count,'attributed_chips',net_fee);
END $function$;
REVOKE ALL ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- END tournament-fee-recognition-draft.sql

-- BEGIN tournament-fee-terminal-common-draft.sql
CREATE FUNCTION public.fn_accounting_tournament_bank_proof(p_tournament_id uuid,p_recognized_at timestamptz,
 p_bank_club_id uuid,p_union_id uuid,p_net_fee numeric,p_union_wallet_transaction_id uuid,p_bank_journal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$DECLARE bank record;BEGIN
 IF (p_bank_club_id IS NULL AND p_net_fee>0) OR p_recognized_at IS NULL OR NOT isfinite(p_recognized_at)
  OR p_net_fee IS NULL OR p_net_fee<0 OR p_net_fee<>round(p_net_fee,2) OR p_net_fee::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_bank_proof_invalid' USING ERRCODE='23514'; END IF;
 IF p_net_fee=0 THEN
  IF p_union_wallet_transaction_id IS NOT NULL OR p_bank_journal_id IS NOT NULL THEN
   RAISE EXCEPTION 'zero_tournament_fee_has_no_bank_credit' USING ERRCODE='23514'; END IF;
 ELSIF p_union_id IS NOT NULL THEN
  SELECT * INTO bank FROM public.union_wallet_transactions WHERE id=p_union_wallet_transaction_id;
  IF p_bank_journal_id IS NOT NULL OR bank.id IS NULL OR bank.union_id IS DISTINCT FROM p_union_id
   OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.wallet IS DISTINCT FROM 'rake_wallet'
   OR bank.direction IS DISTINCT FROM 'credit' OR bank.tx_type IS DISTINCT FROM 'rake' OR bank.amount IS DISTINCT FROM p_net_fee
   OR bank.created_at IS DISTINCT FROM p_recognized_at
   OR position('[tournament '||p_tournament_id::text||']' IN COALESCE(bank.notes,''))=0 THEN
   RAISE EXCEPTION 'tournament_fee_union_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO bank FROM public.chip_ledger WHERE id=p_bank_journal_id;
  IF p_union_wallet_transaction_id IS NOT NULL OR bank.id IS NULL OR bank.from_type IS DISTINCT FROM 'prize_liability'
   OR bank.from_entity_id IS DISTINCT FROM p_tournament_id OR bank.to_type IS DISTINCT FROM 'chip_retirement'
   OR bank.to_entity_id IS NOT NULL OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.category IS DISTINCT FROM 'burn'
   OR bank.amount IS DISTINCT FROM p_net_fee OR bank.created_at IS DISTINCT FROM p_recognized_at THEN
   RAISE EXCEPTION 'tournament_fee_club_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN jsonb_build_object('bank_amount',p_net_fee,'banked_at',p_recognized_at,'bank_club_id',p_bank_club_id,'bank_union_id',p_union_id,
  'bank_receipt_kind',CASE WHEN p_net_fee=0 THEN 'none' WHEN p_union_id IS NULL THEN 'chip_ledger' ELSE 'union_wallet_transaction' END,
  'bank_receipt_id',COALESCE(p_union_wallet_transaction_id,p_bank_journal_id));
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_bank_proof(uuid,timestamptz,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_lock_accounting_tournament_recognition_week(p_tournament_id uuid,p_recognized_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE scope record;week_start timestamptz;week_end timestamptz;BEGIN
 week_start:=public.fn_union_week_start(p_recognized_at);
 week_end:=((week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 FOR scope IN
  WITH scopes AS (
   SELECT coordinator_union_id,club_id FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id
   UNION
   -- The actual bank also participates in the same close order. A legacy event
   -- may have no captured contributor; this names its game bank, never guesses
   -- a contributor's historical membership or commission agreement.
   SELECT f.union_id,t.club_id FROM public.tournaments t
    JOIN public.accounting_tournament_fee_sources f ON f.tournament_id=t.id WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
   UNION
   SELECT CASE WHEN t.is_private THEN NULL ELSE t.union_id END,t.club_id FROM public.tournaments t
    WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=t.id)
  ) SELECT DISTINCT coordinator_union_id,club_id,
   CASE WHEN coordinator_union_id IS NULL THEN 'club-accounting:'||club_id::text ELSE 'union-accounting:'||coordinator_union_id::text END
    ||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text lock_key
  FROM scopes ORDER BY lock_key
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(scope.lock_key,0));
  IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start<=p_recognized_at AND r.period_end>p_recognized_at
   AND ((r.union_id IS NOT NULL AND r.union_id=scope.coordinator_union_id)
     OR (r.standalone_club_id IS NOT NULL AND scope.coordinator_union_id IS NULL AND r.standalone_club_id=scope.club_id))) THEN
   RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 END LOOP;
END$$;
REVOKE ALL ON FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_defer_accounting_tournament_fees(p_tournament_id uuid,p_recognized_at timestamptz,
 p_bank_club_id uuid,p_union_id uuid,p_union_wallet_transaction_id uuid,p_bank_journal_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE net_fee numeric;fp text;proof jsonb;plan jsonb;prior record;BEGIN
 IF p_recognized_at IS DISTINCT FROM transaction_timestamp() OR p_reason IS NULL
  OR p_reason NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN
  RAISE EXCEPTION 'tournament_fee_deferral_reason_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
   AND (r.rake_amount IS NULL OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'tournament_fee_source_invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(rake_amount),0),md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY id),'')) INTO net_fee,fp
  FROM public.rake_records r WHERE tournament_id=p_tournament_id AND is_tournament;
 -- Historical deferred receipts stay readable; no new positive fee may use
 -- deferral to commit banking without complete attribution. Zero-fee
 -- cancellation evidence remains available to its existing authority.
 IF net_fee>0 THEN RAISE EXCEPTION 'tournament_fee_positive_deferral_retired' USING ERRCODE='P0404'; END IF;
 proof:=public.fn_accounting_tournament_bank_proof(p_tournament_id,p_recognized_at,p_bank_club_id,p_union_id,net_fee,p_union_wallet_transaction_id,p_bank_journal_id);
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:'||p_tournament_id::text,0));
 SELECT * INTO prior FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.status IS DISTINCT FROM 'banked_accrual_deferred' OR prior.source_fingerprint IS DISTINCT FROM fp OR prior.net_rake IS DISTINCT FROM net_fee THEN
   RAISE EXCEPTION 'tournament_fee_recognition_conflict' USING ERRCODE='23514'; END IF;
  RETURN prior.plan||jsonb_build_object('replayed',true);
 END IF;
 plan:=proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status','banked_accrual_deferred',
  'reason',p_reason,'source_fingerprint',fp,'net_fee',net_fee,'payable',false,'commission_rows',0,'attributed_users',0,'recognized_source_count',0);
 INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,
  union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
 VALUES(p_tournament_id,p_recognized_at,'banked_accrual_deferred',net_fee,p_union_id,p_bank_club_id,p_union_wallet_transaction_id,p_bank_journal_id,fp,plan);
 RETURN plan||jsonb_build_object('replayed',false);
END$$;
REVOKE ALL ON FUNCTION public.fn_defer_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$DECLARE r record;proof jsonb;fp text;credits numeric;n int;BEGIN
 SELECT * INTO r FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(q),':' ORDER BY q.id),'')) INTO fp
  FROM public.rake_records q WHERE q.tournament_id=p_tournament_id AND q.is_tournament;
 IF r.source_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
 proof:=public.fn_accounting_tournament_bank_proof(r.tournament_id,r.recognized_at,r.bank_club_id,r.union_id,r.net_rake,r.union_wallet_transaction_id,r.bank_journal_id);
 SELECT COALESCE(sum(x.rake_credit),0),count(*) INTO credits,n FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=p_tournament_id;
 IF (r.status='banked_accrual_deferred' AND (n<>0 OR r.plan->>'payable' IS DISTINCT FROM 'false' OR NULLIF(r.plan->>'reason','') IS NULL))
  OR (r.status<>'banked_accrual_deferred' AND (credits IS DISTINCT FROM r.net_rake
    OR n<>(SELECT count(*) FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=p_tournament_id)
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f LEFT JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id
      WHERE f.tournament_id=p_tournament_id AND (x.source_id IS NULL OR x.tournament_id IS DISTINCT FROM p_tournament_id
        OR x.recognized_at IS DISTINCT FROM r.recognized_at OR x.rake_credit IS DISTINCT FROM CASE WHEN x.disposition='earned' THEN f.rake_credit ELSE 0 END))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
      JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id AND x.disposition='earned'
      CROSS JOIN LATERAL jsonb_array_elements(f.contract->'tiers')tier
      WHERE f.tournament_id=p_tournament_id AND (tier->>'amount')::numeric>0 AND NOT EXISTS(
       SELECT 1 FROM public.agent_commissions c WHERE c.source_type='tournament_fee_accrual' AND c.source_id=f.id
        AND c.user_id::text=tier->>'user_id' AND c.club_id=f.club_id AND c.created_at=r.recognized_at
        AND c.amount=(tier->>'amount')::numeric AND c.commission_rate=(tier->>'rate')::numeric)))) THEN
  RAISE EXCEPTION 'tournament_fee_recognition_source_receipt_incomplete' USING ERRCODE='23514'; END IF;
 RETURN proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status',r.status,
  'source_fingerprint',fp,'reason',r.plan->>'reason','payable',r.status='recognized','recognized_source_count',n);
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_record_accounting_tournament_cancellation(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE t record;raw record;reason text;result jsonb;BEGIN
 SELECT id,club_id,union_id,is_private INTO t FROM public.tournaments WHERE id=p_tournament_id;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(p_tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_cancellation_required' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id=p_tournament_id
   AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before)
  OR (SELECT COALESCE(sum(rake_amount),0) FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament)<>0 THEN
  RAISE EXCEPTION 'tournament_cancellation_exact_zero_receipt_required' USING ERRCODE='23514'; END IF;
 -- A registration and cancellation can share one transaction. Its deferred
 -- capture hook has not fired yet; capture the original immutable charge now.
 -- This does not rewrite the raw fee sealed by the cancellation receipt.
 FOR raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(raw.id);
 END LOOP;
 BEGIN
  result:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),t.club_id,NULL,NULL);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  reason:=SQLERRM;
  IF reason NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  result:=public.fn_defer_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),t.club_id,
   CASE WHEN t.is_private THEN NULL ELSE t.union_id END,NULL,NULL,reason);
 END;
 RETURN result;
END$$;
REVOKE ALL ON FUNCTION public.fn_record_accounting_tournament_cancellation(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_tournament_commission_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE s record;matches int;BEGIN
 IF NEW.source_type='tournament_fee_accrual' THEN
  SELECT f.*,r.recognized_at,r.disposition,b.status accounting_status INTO s FROM public.accounting_tournament_fee_sources f
   JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
   JOIN public.accounting_tournament_fee_recognitions b ON b.tournament_id=r.tournament_id WHERE f.id=NEW.source_id;
  IF NOT FOUND OR s.disposition IS DISTINCT FROM 'earned' OR s.accounting_status IS DISTINCT FROM 'recognized'
   OR NEW.club_id IS DISTINCT FROM s.club_id OR NEW.created_at IS DISTINCT FROM s.recognized_at THEN
   RAISE EXCEPTION 'tournament_commission_recognized_source_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(s.contract->'tiers')t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'tournament_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('tournament_fee','tournament_rake_settlement') THEN
  RAISE EXCEPTION 'tournament_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_commission_source_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_commission_source_guard BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_commission_source_guard();

CREATE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE event uuid;BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  event:=CASE WHEN TG_OP='INSERT' THEN NEW.tournament_id ELSE OLD.tournament_id END;
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=event)
   AND (TG_OP<>'UPDATE' OR public.fn_accounting_tournament_fee_fingerprint(OLD) IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(NEW)) THEN
   RAISE EXCEPTION 'recognized_tournament_fee_evidence_is_immutable' USING ERRCODE='55000'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE
   (TG_TABLE_NAME='chip_ledger' AND bank_journal_id=OLD.id) OR (TG_TABLE_NAME='union_wallet_transactions' AND union_wallet_transaction_id=OLD.id)) THEN
   RAISE EXCEPTION 'recognized_tournament_fee_bank_receipt_is_immutable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_recognized_evidence_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable();
CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE UPDATE OR DELETE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable();
CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE UPDATE OR DELETE ON public.union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable();

-- END tournament-fee-terminal-common-draft.sql

-- BEGIN tournament-fee-settle-adapter-draft.sql
-- Current captured predecessor46128439ae7a46e4fd8ea2889a7dddf8. Preserve its
-- complete-attribution transaction and replay rules through canonical sources;
-- Diamond custody remains verbatim. Native current-predecessor overlay required.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
 v_t record;v_prior record;v_claimed int;v_plan jsonb;v_att jsonb;v_res jsonb;
 v_net numeric;v_union uuid;v_dest text;v_reason text;v_raw record;v_bank_id uuid;v_journal_id uuid;v_matches int;
 v_week_start timestamptz;v_week_end timestamptz;v_lock_key text;v_attempt int:=0;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT t.id,t.status,t.club_id,t.union_id,t.is_private,t.name,t.current_players INTO v_t
  FROM public.tournaments t WHERE t.id=p_tournament_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF upper(COALESCE(v_t.status,'')) NOT IN('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN jsonb_build_object('ok',false,'reason','not_terminal','status',v_t.status); END IF;
 INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)
 VALUES(p_tournament_id,v_t.club_id,0,'pending',COALESCE(p_source,'engine')) ON CONFLICT(tournament_id) DO NOTHING;
 GET DIAGNOSTICS v_claimed=ROW_COUNT;
 IF v_claimed=0 THEN
  SELECT * INTO v_prior FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id;
  -- Historical claims do not authorize another fee transfer or a success
  -- claim unless their stored attribution actually completed.
  IF v_prior.settled_at IS NULL OR v_prior.attributed_at IS NULL
   OR v_prior.attributed_users IS NULL OR v_prior.attributed_users<0
   OR v_prior.attribution_error IS NOT NULL
   OR NULLIF(v_prior.destination,'') IS NULL OR v_prior.destination='pending' THEN
   RETURN jsonb_build_object('ok',false,'already_settled',true,
    'reason','settlement_attribution_incomplete','amount',v_prior.amount,
    'destination',v_prior.destination,'settled_at',v_prior.settled_at,'attributed',false);
  END IF;
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id)
   AND v_prior.destination IS DISTINCT FROM 'chip_retirement:'||v_prior.club_id::text THEN
   RAISE EXCEPTION 'tournament_fee_legacy_treasury_leg_requires_adjustment' USING ERRCODE='55000'; END IF;
  v_att:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND v_att IS NULL THEN
   RAISE EXCEPTION 'tournament_fee_disposition_receipt_missing' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',v_prior.amount,'destination',v_prior.destination,
    'settled_at',v_prior.settled_at,'attributed',true,'attributed_users',v_prior.attributed_users,
    'no_attribution_due',v_prior.amount=0,'accounting',v_att);
 END IF;
  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
  END IF;

 -- Deferred capture is normally already committed. A same-transaction Spin
 -- close still captures the original exact charge before it can be recognized.
 FOR v_raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
 SELECT COALESCE(sum(r.rake_amount),0) INTO v_net FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 IF v_net<0 OR v_net<>round(v_net,2) OR v_net::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_net_invalid' USING ERRCODE='23514'; END IF;
 BEGIN
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  v_reason:=SQLERRM;
  -- A new positive fee cannot leave custody before its exact attribution is
  -- available. Throw: direct callers must also roll back the inserted claim.
  IF v_net>0 THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: %',p_tournament_id,v_reason USING ERRCODE='P0404';
  END IF;
  -- Exact zero owes no new attribution. Preserve the predecessor's zero-fee
  -- completion without inventing a source, bank, commission or paid receipt.
 END;
 v_union:=CASE WHEN v_reason IS NULL THEN NULLIF(v_plan->>'union_id','')::uuid
  WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
 -- A legacy event may have no captured contributor scope. Its actual bank
 -- still takes the exact same close lock, before either wallet is touched.
 v_week_start:=public.fn_union_week_start(transaction_timestamp());
 v_week_end:=((v_week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 v_lock_key:=CASE WHEN v_union IS NULL THEN 'club-accounting:'||v_t.club_id::text ELSE 'union-accounting:'||v_union::text END
  ||':'||extract(epoch FROM v_week_start)::text||':'||extract(epoch FROM v_week_end)::text;
 IF v_lock_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key,0)); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start<=transaction_timestamp() AND x.period_end>transaction_timestamp()
   AND ((v_union IS NOT NULL AND x.union_id=v_union) OR(v_union IS NULL AND x.standalone_club_id=v_t.club_id))) THEN
  RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 IF v_net>0 THEN
  IF v_t.club_id IS NULL THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.club_wallets WHERE club_id=v_t.club_id FOR NO KEY UPDATE;
  PERFORM set_config('app.ledger_category','rake',true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_tournament_id::text,true);
  IF v_union IS NOT NULL THEN
   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,
    'Tournament rake: '||COALESCE(v_t.name,'tournament')||' [tournament '||p_tournament_id::text||']');
   IF COALESCE((v_res->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'tournament_fee_union_credit_failed' USING ERRCODE='23514'; END IF;
   SELECT count(*),(array_agg(id))[1] INTO v_matches,v_bank_id FROM public.union_wallet_transactions
    WHERE union_id=v_union AND club_id=v_t.club_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake'
     AND amount=v_net AND created_at=transaction_timestamp() AND position('[tournament '||p_tournament_id::text||']' IN COALESCE(notes,''))>0;
   v_dest:='union:'||v_union::text;
  ELSE
   -- The original settlement-row trigger removes this exact fee from escrow.
   -- Retire that liability in the canonical journal; never debit a treasury or
   -- call fn_ca_burn, which would take these same chips from a wallet again.
   UPDATE public.clubs SET total_rake=COALESCE(total_rake,0)+v_net,updated_at=now()
    WHERE id=v_t.club_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_missing' USING ERRCODE='23514'; END IF;
   INSERT INTO public.chip_ledger
    (performed_by,from_type,from_entity_id,to_type,to_entity_id,club_id,tournament_id,category,amount,description)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'prize_liability',p_tournament_id,'chip_retirement',NULL,v_t.club_id,p_tournament_id,'burn',v_net,
    'Standalone tournament fee retired (fn_settle_tournament_rake)') RETURNING id INTO v_journal_id;
   v_matches:=1;
   v_dest:='chip_retirement:'||v_t.club_id::text;
  END IF;
  IF v_matches<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_bank_receipt_required' USING ERRCODE='23514'; END IF;
  UPDATE public.club_wallets SET period_rake_collected=COALESCE(period_rake_collected,0)+v_net,
   lifetime_rake_collected=COALESCE(lifetime_rake_collected,0)+v_net,updated_at=now() WHERE club_id=v_t.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_wallet_missing' USING ERRCODE='23514'; END IF;
 ELSE v_dest:='none'; END IF;
 IF v_reason IS NULL THEN
  -- Preserve the installed bounded retry contract, now around the sole
  -- canonical recognition writer. Exhaustion and permanent errors escape the
  -- whole settlement; rolled-back attempts cannot retain partial attribution.
  LOOP
   v_attempt:=v_attempt+1;
   BEGIN
    v_att:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),v_t.club_id,v_bank_id,v_journal_id);
    EXIT;
   EXCEPTION WHEN deadlock_detected OR lock_not_available THEN
    IF v_attempt>=4 THEN RAISE; END IF;
    PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
   END;
  END LOOP;
  IF v_att->>'status' IS DISTINCT FROM CASE WHEN v_net>0 THEN 'recognized' ELSE 'cancelled' END
   OR (v_att->>'attributed_chips')::numeric IS DISTINCT FROM v_net
   OR (v_net>0 AND COALESCE((v_att->>'attributed_users')::int,0)<1) THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: canonical source receipt',p_tournament_id USING ERRCODE='P0404';
  END IF;
 END IF;
 UPDATE public.tournament_rake_settlements SET amount=v_net,union_id=v_union,destination=v_dest,settled_at=transaction_timestamp(),
  attributed_at=transaction_timestamp(),attributed_users=COALESCE((v_att->>'attributed_users')::int,0),
  attribution_error=NULL WHERE tournament_id=p_tournament_id;
 RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,
  'attributed_users',COALESCE((v_att->>'attributed_users')::int,0),'attribution_attempts',v_attempt,
  'no_attribution_due',v_net=0,'accounting',public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id));
END;
$function$;

-- END tournament-fee-settle-adapter-draft.sql

-- BEGIN tournament-fee-terminal-gates-draft.sql
-- DRAFT. New v2 terminal receipts retain truthful NULL attribution while
-- their durable accounting deferral is explicit. Existing v1 receipts stay valid.
DO $terminal_version_preimage$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_terminal_settlements'::regclass
  AND conname='tournament_terminal_settlements_receipt_version_check'
  AND pg_get_constraintdef(oid)='CHECK ((receipt_version = 1))') THEN
  RAISE EXCEPTION 'terminal_receipt_version_constraint_changed' USING ERRCODE='55000';
 END IF;
END $terminal_version_preimage$;
ALTER TABLE public.tournament_terminal_settlements
 ADD COLUMN accounting_state text NOT NULL DEFAULT 'legacy'
  CHECK(accounting_state IN('legacy','recognized','cancelled','banked_accrual_deferred')),
 DROP CONSTRAINT tournament_terminal_settlements_receipt_version_check,
 ADD CONSTRAINT terminal_receipt_version_matches_accounting_state CHECK(
  receipt_version=CASE WHEN accounting_state='legacy' THEN 1 ELSE 2 END),
 ALTER COLUMN rake_attributed_at DROP NOT NULL,
 ADD CONSTRAINT terminal_rake_attribution_matches_accounting_state CHECK(
  (accounting_state='banked_accrual_deferred' AND rake_attributed_at IS NULL AND rake_attributed_users=0)
  OR(accounting_state<>'banked_accrual_deferred' AND rake_attributed_at IS NOT NULL));

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_diamond boolean := false;  -- DIAMOND PHASE 8
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_cash jsonb;
  v_mystery jsonb;
  v_mystery_evidence jsonb;
  v_bounty jsonb;
  v_rake_result jsonb;
  v_rake record;
  v_prior_rake record;
  v_winner_id uuid;
  v_winner_count integer;
  v_is_bounty boolean;
  v_mystery_active boolean := false;
  v_mystery_stage text := 'pending';
  v_mystery_pool_cents bigint := 0;
  v_inventory_cents bigint := 0;
  v_cash_count integer;
  v_bubble_line_count integer;
  v_cash_total numeric(15,2);
  v_cash_before numeric(15,2);
  v_bounty_before numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_expected_fee numeric(15,2);
  v_started_status text;
  v_completed_at timestamptz;
  v_rows integer;
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_event_union_id uuid;
  v_current_union_id uuid;
  v_locked_current_union_id uuid;
  v_deal_shares jsonb := '[]'::jsonb;
  v_full_payouts jsonb := '[]'::jsonb;
  v_cash_bubble jsonb := 'null'::jsonb;
  v_full_winner_amount numeric(15,2);
BEGIN
  -- All satellite and non-satellite terminal money commits use this exact
  -- first lock. It eliminates cross-event cycles on shared club, union and
  -- recipient wallets without weakening any event-local row proof.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal completion requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal settlement mode %', p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'places' AND p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'places completion requires an observed winner id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 8

  -- Receipt first is the replay boundary. No money authority appears above it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = p_tournament_id
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_terminal_settlements h
       WHERE h.tournament_id = p_tournament_id
         AND h.settlement_mode = v_mode
         AND (p_observed_winner_id IS NULL
              OR h.winner_id = p_observed_winner_id)
    ) THEN
      RAISE EXCEPTION 'terminal replay parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    RETURN public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite; use its whole-pool authority',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  v_started_status := upper(COALESCE(v_t.status::text,''));
  IF v_started_status NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % cannot complete from status % without a receipt',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2)
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.bounty_pool < 0
     OR v_t.bounty_pool IS DISTINCT FROM round(v_t.bounty_pool,2) THEN
    RAISE EXCEPTION 'tournament % has malformed cash or bounty pools',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  IF NOT v_diamond THEN PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp()); END IF;

  -- Cross-event bank order is tournament -> club_wallets -> union_wallets
  -- (sorted) -> clubs, before a cash authority can apply an overlay. Rake uses
  -- club_wallets before its union/club destination; guarantee funding uses the
  -- union/club destination. Pre-owning both paths prevents two same-scope
  -- finishes from taking those shared banks in opposite order.
  v_event_union_id := CASE WHEN COALESCE(v_t.is_private,false)
                           THEN NULL ELSE v_t.union_id END;
  IF v_t.club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_current_union_id
      FROM public.clubs c WHERE c.id = v_t.club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % refers to missing club %',
        p_tournament_id,v_t.club_id USING ERRCODE = 'P0404';
    END IF;
    PERFORM 1 FROM public.club_wallets cw
     WHERE cw.club_id = v_t.club_id
     ORDER BY cw.club_id FOR NO KEY UPDATE;
    PERFORM 1 FROM public.union_wallets uw
     WHERE uw.union_id IN (
       SELECT DISTINCT x.union_id
         FROM unnest(ARRAY[v_event_union_id,v_current_union_id]::uuid[]) x(union_id)
        WHERE x.union_id IS NOT NULL)
     ORDER BY uw.union_id FOR NO KEY UPDATE;
    SELECT c.union_id INTO v_locked_current_union_id
      FROM public.clubs c
     WHERE c.id = v_t.club_id
     FOR NO KEY UPDATE;
    IF v_locked_current_union_id IS DISTINCT FROM v_current_union_id THEN
      RAISE EXCEPTION 'club % changed union while tournament % claimed terminal banks',
        v_t.club_id,p_tournament_id USING ERRCODE = '40001';
    END IF;
  END IF;

  -- Freeze every tournament-owned evidence set before the first payer. The
  -- canonical payers reacquire only rows already owned by this transaction.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id = p_tournament_id
   ORDER BY g.tournament_id FOR UPDATE;
  -- The final-table deal authority uses this same order after its money sets.
  -- Holding these locks before any bounty or rake row prevents a reversed
  -- terminal lock chain while retaining the tournament row as the root lock.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  v_closed_table_count := cardinality(v_closed_table_ids);
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_seat_count := cardinality(v_source_seat_ids);
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
   ORDER BY w.id FOR SHARE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM 1 FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament
   ORDER BY rr.id FOR SHARE;
  PERFORM 1 FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;

  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF v_diamond THEN
    SELECT e.bounty_out INTO v_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND lower(w.category) = 'bounty'
       AND (lower(w.type) <> 'credit' OR w.amount <= 0
         OR w.amount::text IN ('NaN','Infinity','-Infinity')
         OR w.amount IS DISTINCT FROM round(w.amount,2))
  ) OR v_bounty_before < 0 OR v_bounty_before > v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_bounty_before THEN
    RAISE EXCEPTION 'tournament % has overpaid or contradictory bounty evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_is_bounty THEN
    IF v_t.bounty_pool <= 0 THEN
      RAISE EXCEPTION 'funded bounty tournament % has no positive bounty pool',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_t.bounty_pool <> 0 OR v_bounty_before <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery_stage := COALESCE(v_t.mystery_bounty_stage,'');
    IF v_mystery_stage NOT IN ('pending','active','complete') THEN
      RAISE EXCEPTION 'tournament % has ambiguous mystery stage % without a receipt',
        p_tournament_id,v_t.mystery_bounty_stage USING ERRCODE = '55000';
    END IF;
    -- A rolling cutover may meet an event whose old finish path already
    -- completed the mystery inventory but never completed cash, rake or the
    -- lifecycle. Treat both active and complete as a funded mystery branch.
    -- Active is settled below; complete must already prove the entire mystery
    -- obligation and every inventory row before the wrapper can continue.
    v_mystery_active := v_mystery_stage IN ('active','complete');
    IF v_mystery_active THEN
      v_mystery_pool_cents := COALESCE(v_t.mystery_bounty_pool_cents,0);
      SELECT COALESCE(sum(c.amount_cents),0) INTO v_inventory_cents
        FROM public.tournament_bounty_chests c
       WHERE c.tournament_id = p_tournament_id;
      IF v_mystery_pool_cents <= 0
         OR v_inventory_cents IS DISTINCT FROM v_mystery_pool_cents
         OR v_mystery_pool_cents > round(v_t.bounty_pool * 100)::bigint
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id
              AND (c.amount_cents <= 0 OR c.status NOT IN
                   ('available','reserved','revealed','paid','void')))
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_awards a
            WHERE a.tournament_id = p_tournament_id
              AND (a.amount_cents <= 0 OR a.status NOT IN
                   ('reserved','revealed','paid','completed','void'))) THEN
        RAISE EXCEPTION 'tournament % mystery bounty inventory is not exactly funded',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;
    ELSIF COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'pending mystery tournament % already carries inventory',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'non-mystery tournament % carries mystery bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_cash_before
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_before < 0 OR v_cash_before > v_t.prize_pool
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source IN
                     ('satellite_seat','satellite_ticket','satellite_remainder')) THEN
    RAISE EXCEPTION 'tournament % has invalid pre-terminal cash evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 8: the fee of a Diamond event is its fee bank (what came
    -- in as fee, less what was refunded), held in custody until it settles.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_rake_total < 0 OR v_rake_total::text IN ('NaN','Infinity','-Infinity')
     OR v_rake_total IS DISTINCT FROM round(v_rake_total,2) THEN
    RAISE EXCEPTION 'tournament % has malformed rake records',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_prior_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_prior_rake.amount IS DISTINCT FROM v_rake_total
       OR v_prior_rake.settled_at IS NULL
       OR (v_prior_rake.attributed_at IS NULL AND NOT v_deferred)
       OR v_prior_rake.attributed_users IS NULL
       OR v_prior_rake.attributed_users < 0
       OR (v_prior_rake.attribution_error IS NOT NULL AND NOT v_deferred)
       OR lower(v_prior_rake.destination) IN ('pending','')
       OR (v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
           AND (v_prior_rake.attributed_users < 1
             OR (v_prior_rake.destination NOT LIKE 'union:%'
                 AND v_prior_rake.destination NOT LIKE 'chip_retirement:%'))) THEN
      RAISE EXCEPTION 'tournament % has a partial or unattributed prior rake row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_expected_fee := 0;
  ELSE
    v_expected_fee := v_rake_total;
  END IF;

  IF v_diamond THEN
    -- DIAMOND PHASE 8: the escrow shadow of a Diamond event opens here, from
    -- its ledger with its exact parts, so every apply below moves it as a chip
    -- event's evidence moves it and the exact-zero close is the same close.
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)
     OR v_e.bounty_balance IS DISTINCT FROM round(v_t.bounty_pool-v_bounty_before,2)
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee
     OR v_e.prize_balance < 0 OR v_e.bounty_balance < 0
     OR v_e.fee_balance < 0
     OR v_e.closed_at IS NOT NULL
     OR v_e.close_note IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % escrow does not exactly fund its remaining obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Exactly one branch calls exactly one cash authority.
  IF v_mode = 'places' THEN
    v_cash := public.fn_settle_tournament_places(
      p_tournament_id,p_observed_winner_id);
  ELSE
    v_cash := public.fn_settle_tournament_final_table_deal(p_tournament_id);
  END IF;
  IF COALESCE((v_cash->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_cash->>'status','')) <> 'COMPLETING'
     OR jsonb_typeof(v_cash->'payouts') <> 'array'
     OR jsonb_array_length(v_cash->'payouts') < 1
     OR v_cash->>'winner_amount' IS NULL
     OR (v_cash->>'winner_amount')::numeric < 0
     OR (v_cash->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_cash->>'winner_amount')::numeric,2)
     OR (v_mode = 'final_table_deal'
         AND v_cash->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % cash authority returned a partial result: %',
      p_tournament_id,v_cash USING ERRCODE = 'P0404';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) <> 'COMPLETING'
     OR COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2) THEN
    RAISE EXCEPTION 'tournament % cash authority did not claim one finalized pool',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  SELECT tp.user_id INTO v_winner_id
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  IF v_winner_count <> 1 OR v_winner_id IS NULL
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_winner_id
          AND (tp.eliminated_at IS NOT NULL
            OR tp.elimination_sequence IS NOT NULL))
     OR (p_observed_winner_id IS NOT NULL
         AND v_winner_id IS DISTINCT FROM p_observed_winner_id)
     OR (SELECT count(*) FROM jsonb_array_elements(v_cash->'payouts') p
          WHERE (p->>'place')::integer = 1
            AND (p->>'user_id')::uuid = v_winner_id
            AND (p->>'amount')::numeric =
                (v_cash->>'winner_amount')::numeric) <> 1 THEN
    RAISE EXCEPTION 'tournament % cash authority left an ambiguous winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_total IS DISTINCT FROM v_t.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash pool did not settle exactly',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  -- The deal authority returns only the still-live chop shares. That is the
  -- right presentation input for the table animation, but it is not the full
  -- prize-pool receipt when eliminated fixed places were already earned.
  -- Store both contracts explicitly: deal_shares is exactly the live chop;
  -- payouts is every non-bubble cash entitlement reconstructed from durable
  -- payout evidence and final standings. Bubble protection remains a distinct
  -- line, so sum(payouts.amount) + bubble_protection.amount is the full pool.
  IF v_mode = 'final_table_deal' THEN
    v_deal_shares := v_cash->'payouts';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_full_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_t.prize_pool = 0 AND v_full_payouts = '[]'::jsonb THEN
    -- The cash authority returns the derived zero-dollar winner line, but a
    -- zero payment correctly creates no tournament_payouts row.
    v_full_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_winner_id,'amount',0));
  END IF;
  -- A partly paid obligation has several immutable credit intervals, but
  -- exactly one Bubble recipient. Reconstruct that recipient's total from
  -- the durable payouts already verified against their exact credit keys.
  SELECT count(DISTINCT p.user_id) INTO v_bubble_line_count
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_bubble_line_count > 1 THEN
    RAISE EXCEPTION 'tournament % has more than one durable bubble payout recipient',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_cash_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_cash_bubble := COALESCE(v_cash_bubble,'null'::jsonb);
  SELECT (p->>'amount')::numeric INTO v_full_winner_amount
    FROM jsonb_array_elements(v_full_payouts) p
   WHERE (p->>'place')::integer = 1;
  IF v_full_winner_amount IS NULL THEN
    RAISE EXCEPTION 'tournament % has no durable winner cash line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_cash := v_cash || jsonb_build_object(
    'payouts',v_full_payouts,
    'deal_shares',v_deal_shares,
    'bubble_protection',v_cash_bubble,
    'winner_amount',v_full_winner_amount);

  IF v_mystery_stage = 'active' THEN
    v_mystery := public.fn_mystery_bounty_settle(
      p_tournament_id,v_winner_id);
    IF COALESCE((v_mystery->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'variance_cents')::bigint,1) <> 0 THEN
      RAISE EXCEPTION 'tournament % mystery bounty close was partial: %',
        p_tournament_id,v_mystery USING ERRCODE = 'P0404';
    END IF;
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := v_mystery || jsonb_build_object(
      'payment_evidence',v_mystery_evidence,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint);
  ELSIF v_mystery_stage = 'complete' THEN
    -- No payer is rerun for an already-complete inventory. The preflight
    -- proved exact terminal chests, awards and mystery obligations plus their
    -- immutable credit-key intervals while all rows were locked. Store that
    -- canonical replay result before the bounty-pool finalizer checks the
    -- mystery completion receipt; this is evidence capture, not a second pay.
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := jsonb_build_object(
      'ok',true,'reason','already_complete',
      'pool_cents',v_mystery_pool_cents,
      'settled_cents',v_mystery_pool_cents,
      'unclaimed_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'balanced',true,'variance_cents',0,
      'payment_evidence',v_mystery_evidence);
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
    VALUES (p_tournament_id,v_winner_id,now(),v_mystery,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET mystery_settled_at=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_settled_at,
            EXCLUDED.mystery_settled_at),
          mystery_result=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_result,
            EXCLUDED.mystery_result),
          winner_user_id=COALESCE(
            public.tournament_bounty_completion_receipts.winner_user_id,
            EXCLUDED.winner_user_id),
          updated_at=now();
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_completion_receipts r
       WHERE r.tournament_id=p_tournament_id
         AND r.winner_user_id=v_winner_id
         AND r.mystery_settled_at IS NOT NULL
         AND r.mystery_result IS NOT DISTINCT FROM v_mystery
    ) THEN
      RAISE EXCEPTION
        'tournament % completed mystery evidence receipt conflicts with canonical proof',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
  ELSIF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery := jsonb_build_object(
      'ok',true,'reason','never_activated','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  ELSE
    v_mystery := jsonb_build_object(
      'ok',true,'reason','not_a_mystery_tournament','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  END IF;

  IF v_is_bounty THEN
    v_bounty := public.fn_finalize_bounty_pool(p_tournament_id,v_winner_id);
    IF COALESCE((v_bounty->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_bounty->>'funded')::boolean,false) IS NOT TRUE
       OR v_bounty->>'residual' IS NULL
       OR (v_bounty->>'residual')::numeric < 0 THEN
      RAISE EXCEPTION 'tournament % bounty pool close was partial: %',
        p_tournament_id,v_bounty USING ERRCODE = 'P0404';
    END IF;
  ELSE
    v_bounty := jsonb_build_object(
      'ok',true,'funded',true,'residual',0,
      'reason','not_a_bounty_tournament');
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: the same reading after the close.
  IF v_diamond THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_t.bounty_pool
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                 WHERE w.related_entity_id = p_tournament_id
                   AND lower(w.category) = 'bounty'
                   AND (lower(w.type) <> 'credit' OR w.amount <= 0
                     OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND (o.amount_paid IS DISTINCT FROM o.amount_owed
                     OR o.settled_at IS NULL))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id
                   AND c.status NOT IN ('paid','void'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id
                   AND a.status NOT IN ('completed','void'))
     OR (v_mystery_active AND (
          v_mystery_evidence IS NULL
          OR COALESCE((v_mystery_evidence->>'pool_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents
          OR COALESCE((v_mystery_evidence->>'legacy_credit_cents')::bigint,-1)
             + COALESCE((v_mystery_evidence->>'obligation_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.status = 'completed'
          AND (a.paid_at IS NULL
            OR (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id = a.id) <> a.amount_cents
            OR EXISTS (SELECT 1
                         FROM public.tournament_bounty_award_recipients r
                        WHERE r.award_id = a.id
                          AND r.amount_cents > 0 AND r.paid_at IS NULL))) THEN
    RAISE EXCEPTION 'tournament % bounty obligations or chests remain open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- current_bounty is the live head/cache, not payment evidence. The older
  -- finalizer clears only the champion when it itself pays a positive ordinary
  -- residual; an already-exhausted pool or mystery residual can therefore
  -- leave a stale live head after every chip is durably paid. Once exact pool,
  -- obligation and inventory conservation is proved above, zero every head in
  -- this same terminal commit so no completed player advertises open value.
  IF v_is_bounty THEN
    UPDATE public.tournament_players
       SET current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND COALESCE(current_bounty,0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % still has a live bounty head after close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee THEN
    RAISE EXCEPTION 'tournament % cash/bounty close did not preserve fee escrow',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id,'engine.fn_complete_tournament_terminal');
  IF COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR (v_rake.attributed_at IS NULL AND NOT v_deferred)
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR (v_rake.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'chip_retirement:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Explicitly release every live seat and close every tournament table in
  -- this transaction. No timer, table manager or lifecycle watcher is part of
  -- the completion contract. IDs and counts are captured for immutable replay.
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at = v_completed_at,
           status = 'left',
           leave_pending = false,
           is_sitting_out = false,
           is_away = false,
           sit_out_at = NULL,
           scheduled_leave_hands = NULL
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = p_tournament_id
       AND s.left_at IS NULL
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_released_seat_ids
    FROM released r;
  v_released_seat_count := cardinality(v_released_seat_ids);

  -- Preserve an earlier departure time, but canonicalize every other mutable
  -- occupancy flag before the immutable source-seat snapshot is committed.
  UPDATE public.table_seats s
     SET status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE s.id = ANY(v_source_seat_ids)
     AND s.left_at IS NOT NULL
     AND (s.status IS DISTINCT FROM 'left'
       OR s.leave_pending IS DISTINCT FROM false
       OR s.is_sitting_out IS DISTINCT FROM false
       OR s.is_away IS DISTINCT FROM false
       OR s.sit_out_at IS NOT NULL
       OR s.scheduled_leave_hands IS NOT NULL);

  -- Publish terminal lifecycle after every seat is released but before table
  -- rows close. The managed table-status observer therefore sees a genuinely
  -- terminal parent and does not emit a false live-tournament incident. The
  -- deferred receipt constraint still requires the receipt later in this same
  -- transaction; any table or receipt failure rolls this update back too.
  UPDATE public.tournaments
     SET status = 'COMPLETED',
         ended_at = v_completed_at,
         on_break = false,
         break_started_at = NULL,
         break_ends_at = NULL,
         updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status::text,'')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its terminal lifecycle claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_completed_at,
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_closed_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % did not durably release every seat and close every table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tournament_terminal_settlements
    (tournament_id,winner_id,settlement_mode,started_status,
     prize_pool,bounty_pool,cash_payout_count,cash_payout_total,
     bounty_payout_total,mystery_was_active,mystery_pool_cents,
     cash_receipt,mystery_receipt,bounty_receipt,
     closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
     released_seat_count,released_seat_ids,
     rake_amount,rake_destination,rake_settled_at,rake_attributed_at,
     rake_attributed_users,escrow_closed_at,escrow_close_note,
     completed_at,settled_at,receipt_version,accounting_state)
  VALUES
    (p_tournament_id,v_winner_id,v_mode,v_started_status,
     v_t.prize_pool,v_t.bounty_pool,v_cash_count,v_cash_total,
     v_bounty_total,v_mystery_active,v_mystery_pool_cents,
     v_cash,v_mystery,v_bounty,
     v_closed_table_count,v_closed_table_ids,
     v_source_seat_count,v_source_seat_ids,
     v_released_seat_count,v_released_seat_ids,
     v_rake.amount,v_rake.destination,v_rake.settled_at,v_rake.attributed_at,
     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',
     v_completed_at,transaction_timestamp(),CASE WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));

  RETURN public.fn_ca_tournament_terminal_receipt(
    p_tournament_id,p_observed_winner_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(p_tournament_id uuid, p_observed_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_r record;
  v_cash_count integer;
  v_cash_total numeric(15,2);
  v_cash_obligation_total numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_roster_count integer;
  v_winner_count integer;
  v_raw_winner_id uuid;
  v_raw_winner_amount numeric(15,2);
  v_bubble jsonb;
  v_durable_payouts jsonb;
  v_durable_deal_shares jsonb;
  v_durable_bubble jsonb;
  v_durable_table_ids uuid[];
  v_durable_table_count integer;
  v_durable_seat_ids uuid[];
  v_durable_seat_count integer;
  v_durable_released_count integer;
  v_mystery_evidence jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_h.accounting_state IS DISTINCT FROM COALESCE(v_accounting->>'status','legacy')
     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>2) THEN
    RAISE EXCEPTION 'terminal accounting state has no exact durable receipt' USING ERRCODE='P0404';
  END IF;
  IF p_observed_winner_id IS NOT NULL
     AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'tournament % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;

  SELECT t.id,t.status,t.variant,t.tournament_type,t.satellite_target_id,
         t.satellite_target,t.prize_pool,t.bounty_pool,t.bounty_pool_paid,
         t.is_bounty,t.is_pko,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents,t.club_id,t.ended_at,t.on_break,
         t.break_started_at,t.break_ends_at
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt lost tournament %', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'terminal receipt % belongs to a satellite', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'
     OR v_t.ended_at IS DISTINCT FROM v_h.completed_at
     OR COALESCE(v_t.on_break, false)
     OR v_t.break_started_at IS NOT NULL
     OR v_t.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is not durably closed by its receipt',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Every mutable child carries the same tuple-owned close fact. This makes a
  -- replay prove the synchronous marker transition itself, while queued
  -- writers can reject from OLD after a row-lock wait without relying on a
  -- pre-wait statement snapshot of the parent or receipt.
  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=p_tournament_id
                AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=p_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at) THEN
    RAISE EXCEPTION 'tournament % mutable evidence lacks its exact terminal marker',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Table closure is money-adjacent terminal state, not an asynchronous UI
  -- cleanup. The immutable identities prove that no tournament table vanished,
  -- appeared or reopened after this receipt and that every seat released by
  -- the terminal transaction still has its exact terminal state.
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_table_ids,v_durable_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_seat_ids,v_durable_seat_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_durable_released_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.id = ANY(v_h.released_seat_ids)
     AND s.left_at IS NOT DISTINCT FROM v_h.completed_at
     AND COALESCE(s.status,'') = 'left'
     AND COALESCE(s.leave_pending,false) IS FALSE
     AND COALESCE(s.is_sitting_out,false) IS FALSE;
  IF v_durable_table_ids IS DISTINCT FROM v_h.closed_table_ids
     OR v_durable_table_count IS DISTINCT FROM v_h.closed_table_count
     OR v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR v_durable_seat_count IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.terminal_closed_at IS DISTINCT FROM v_h.completed_at
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % table or seat closure differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.prize_pool,2) IS DISTINCT FROM v_h.prize_pool
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.bounty_pool,2) IS DISTINCT FROM v_h.bounty_pool THEN
    RAISE EXCEPTION 'tournament % pools differ from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status::text = 'winner'
                            AND tp.position = 1)
    INTO v_roster_count,v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_roster_count < 1 OR v_winner_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.status::text = 'winner' AND tp.position = 1
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL)
     OR (SELECT count(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT min(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> 1
     OR (SELECT max(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text NOT IN ('winner','eliminated')) THEN
    RAISE EXCEPTION 'tournament % has ambiguous or incomplete final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF jsonb_typeof(v_h.cash_receipt->'payouts') <> 'array'
     OR COALESCE((v_h.cash_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_h.cash_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_h.cash_receipt->>'status','')) <> 'COMPLETING'
     OR v_h.cash_receipt->>'winner_amount' IS NULL
     OR (v_h.cash_receipt->>'winner_amount')::numeric < 0
     OR (v_h.cash_receipt->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_h.cash_receipt->>'winner_amount')::numeric,2)
     OR (v_h.settlement_mode = 'final_table_deal'
         AND v_h.cash_receipt->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % stored a malformed cash authority receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric
    INTO v_raw_winner_id,v_raw_winner_amount
    FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
   WHERE (p->>'place')::integer = 1;
  IF v_raw_winner_id IS DISTINCT FROM v_h.winner_id
     OR v_raw_winner_amount IS DISTINCT FROM
          (v_h.cash_receipt->>'winner_amount')::numeric
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
        WHERE p->>'place' IS NULL OR p->>'user_id' IS NULL
           OR p->>'amount' IS NULL
           OR (p->>'place')::integer < 1
           OR (p->>'amount')::numeric < 0
           OR (p->>'amount')::numeric IS DISTINCT FROM
                round((p->>'amount')::numeric,2)
           OR NOT EXISTS (
             SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.position = (p->>'place')::integer
                AND tp.user_id = (p->>'user_id')::uuid))
     OR (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) < 1
     OR (SELECT count(DISTINCT (p->>'place')::integer)
           FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p)
          <> (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) THEN
    RAISE EXCEPTION 'tournament % cash receipt does not name exact finishers',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Satellite and bounty records never consume the ordinary prize pool.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source IN ('satellite_seat','satellite_ticket','satellite_remainder')
  ) THEN
    RAISE EXCEPTION 'non-satellite tournament % carries satellite payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_count IS DISTINCT FROM v_h.cash_payout_count
     OR v_cash_total IS DISTINCT FROM v_h.cash_payout_total
     OR v_cash_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash payout evidence is incomplete or malformed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_h.prize_pool = 0 AND v_durable_payouts = '[]'::jsonb THEN
    -- A zero-cash event has a real winner and no wallet/payout mutation. Keep
    -- that explicit standings line in the receipt without inventing durable
    -- payment evidence.
    v_durable_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_h.winner_id,'amount',0));
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_deal_shares
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY tp.position,p.user_id
    ) q;
  -- Match the terminal writer's one-recipient receipt across every verified
  -- partial credit interval. The exact credit-key and total checks still apply.
  IF (SELECT count(DISTINCT p.user_id) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout recipients',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_durable_bubble := COALESCE(v_durable_bubble,'null'::jsonb);
  IF v_h.cash_receipt->'payouts' IS DISTINCT FROM v_durable_payouts
     OR jsonb_typeof(v_h.cash_receipt->'deal_shares') <> 'array'
     OR v_h.cash_receipt->'deal_shares' IS DISTINCT FROM
          (CASE WHEN v_h.settlement_mode = 'final_table_deal'
                THEN v_durable_deal_shares ELSE '[]'::jsonb END)
     OR COALESCE(v_h.cash_receipt->'bubble_protection','null'::jsonb)
          IS DISTINCT FROM v_durable_bubble
     OR ((SELECT round(COALESCE(sum((p->>'amount')::numeric),0),2)
            FROM jsonb_array_elements(v_durable_payouts) p)
         + (CASE WHEN v_durable_bubble = 'null'::jsonb THEN 0
                 ELSE (v_durable_bubble->>'amount')::numeric END))
          IS DISTINCT FROM v_h.cash_payout_total THEN
    RAISE EXCEPTION
      'tournament % stored cash lines differ from complete durable payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0),2)
    INTO v_cash_obligation_total
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place','bubble_protection','final_table_deal');
  IF v_cash_obligation_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND (o.amount_owed IS NULL OR o.amount_paid IS NULL
            OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_owed < 0 OR o.amount_paid < 0
            OR o.amount_owed IS DISTINCT FROM round(o.amount_owed,2)
            OR o.amount_paid IS DISTINCT FROM round(o.amount_paid,2)
            OR o.amount_paid IS DISTINCT FROM o.amount_owed
            OR o.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'tournament % has incomplete or malformed obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2)
    INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_h.bounty_payout_total
     OR v_bounty_total IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = p_tournament_id
          AND lower(w.category) = 'bounty'
          AND (lower(w.type) <> 'credit' OR w.amount <= 0
            OR w.amount::text IN ('NaN','Infinity','-Infinity')
            OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % bounty pool is underfunded, overfunded or still open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.bounty_pool > 0 THEN
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false))
       OR COALESCE((v_h.bounty_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.bounty_receipt->>'funded')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % bounty receipt is not a funded close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false)
        OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                    WHERE o.tournament_id = p_tournament_id
                      AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.tournament_id = p_tournament_id)
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                    WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.mystery_was_active THEN
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_h.winner_id);
    IF COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
       OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
       OR COALESCE(v_t.mystery_bounty_pool_cents,0)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR (SELECT COALESCE(sum(c.amount_cents),0)
             FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR v_h.mystery_receipt->'payment_evidence'
            IS DISTINCT FROM v_mystery_evidence
       OR COALESCE((v_h.mystery_receipt->>'residual_paid_cents')::bigint,-1)
            IS DISTINCT FROM
              COALESCE((v_mystery_evidence->>'void_chest_cents')::bigint,0)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id
                     AND c.status NOT IN ('paid','void'))
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id
                     AND a.status NOT IN ('completed','void'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.tournament_id = p_tournament_id
            AND ((a.status = 'completed' AND (
                  a.paid_at IS NULL OR
                  (SELECT COALESCE(sum(r.amount_cents),0)
                     FROM public.tournament_bounty_award_recipients r
                    WHERE r.award_id = a.id) <> a.amount_cents OR
                  EXISTS (SELECT 1
                            FROM public.tournament_bounty_award_recipients r
                           WHERE r.award_id = a.id
                             AND r.amount_cents > 0 AND r.paid_at IS NULL)))
              OR (a.status = 'void' AND EXISTS (
                  SELECT 1 FROM public.tournament_bounty_award_recipients r
                   WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))) THEN
      RAISE EXCEPTION 'tournament % has open or inconsistent mystery bounty evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_h.mystery_pool_cents <> 0
       OR COALESCE(v_h.mystery_receipt->>'reason','')
            NOT IN ('never_activated','not_a_mystery_tournament')
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'tournament % stored an invalid non-active mystery close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'tournament % escrow is not an exact durable zero close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    -- DIAMOND PHASE 8: a Diamond event's fee is its fee bank, settled to the house.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'chip_retirement:%'
              AND NOT (v_h.receipt_version=1 AND v_h.accounting_state='legacy'
                       AND v_r.destination LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_bubble := CASE WHEN v_h.cash_receipt ? 'bubble_protection'
                    THEN v_h.cash_receipt->'bubble_protection'
                   ELSE 'null'::jsonb END;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status','COMPLETED',
    'tournament_id',v_h.tournament_id,
    'winner_id',v_h.winner_id,
    'mode',v_h.settlement_mode,
    'settlement_mode',v_h.settlement_mode,
    'payouts',v_h.cash_receipt->'payouts',
    'deal_shares',v_h.cash_receipt->'deal_shares',
    'winner_amount',(v_h.cash_receipt->>'winner_amount')::numeric,
    'bubble_protection',v_bubble,
    'cash',v_h.cash_receipt,
    'mystery_bounty',v_h.mystery_receipt,
    'bounty',v_h.bounty_receipt,
    'closed_table_count',v_h.closed_table_count,
    'source_seat_count',v_h.source_seat_count,
    'released_seat_count',v_h.released_seat_count,
    'table_closure',jsonb_build_object(
      'closed_table_count',v_h.closed_table_count,
      'closed_table_ids',to_jsonb(v_h.closed_table_ids),
      'source_seat_count',v_h.source_seat_count,
      'source_seat_ids',to_jsonb(v_h.source_seat_ids),
      'released_seat_count',v_h.released_seat_count,
      'released_seat_ids',to_jsonb(v_h.released_seat_ids)),
    'rake',jsonb_build_object(
      'amount',v_h.rake_amount,
      'destination',v_h.rake_destination,
      'attributed',NOT v_deferred,
      'accounting',v_accounting,
      'attributed_users',v_h.rake_attributed_users,
      'settled_at',v_h.rake_settled_at,
      'attributed_at',v_h.rake_attributed_at),
    'escrow',jsonb_build_object(
      'prize_balance',v_e.prize_balance,
      'bounty_balance',v_e.bounty_balance,
      'fee_balance',v_e.fee_balance,
      'closed_at',v_h.escrow_closed_at,
      'close_note',v_h.escrow_close_note),
    'cash_payout_total',v_h.cash_payout_total,
    'bounty_payout_total',v_h.bounty_payout_total,
    'receipt_version',v_h.receipt_version,
    'settled_at',v_h.settled_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_finish_readiness(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_t public.tournaments%ROWTYPE;
  v_finish public.tournament_finish_receipts%ROWTYPE;
  v_kind text;
  v_failures jsonb := '[]'::jsonb;
  v_winner_count integer := 0;
  v_position_one_count integer := 0;
  v_canonical_winner uuid;
  v_position_one_winner uuid;
  v_open_players integer := 0;
  v_unranked integer := 0;
  v_duplicate_positions integer := 0;
  v_unsettled_obligations integer := 0;
  v_bad_place_evidence integer := 0;
  v_bad_player_prizes integer := 0;
  v_place_owed numeric := 0;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_escrow_found boolean := false;
  v_rake_expected numeric := 0;
  v_rake_recorded numeric;
  v_rake_destination text;
  v_rake_settled_at timestamptz;
  v_rake_attributed_at timestamptz;
  v_rake_found boolean := false;
  v_bounty public.tournament_bounty_completion_receipts%ROWTYPE;
  v_place_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_deal public.tournament_final_table_deal_batches%ROWTYPE;
  v_satellite public.tournament_satellite_settlement_batches%ROWTYPE;
  v_domain_check jsonb;
  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;
  v_bad_satellite_outcomes integer := 0;
  v_satellite_award_gaps integer := 0;
BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found',
      'failures',jsonb_build_array(jsonb_build_object('code','tournament_not_found')));
  END IF;
  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
  IF v_kind='normal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_place FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id=p_tournament_id;
  ELSIF v_kind='final_table_deal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_deal FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=p_tournament_id;
  END IF;
  v_modern_place:=COALESCE(v_modern_place,false);
  v_modern_deal:=COALESCE(v_modern_deal,false);


  SELECT * INTO v_finish FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_missing'));
  ELSIF v_finish.winner_user_id IS DISTINCT FROM p_winner_user_id
     OR v_finish.finish_kind IS DISTINCT FROM v_kind THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_conflict','claimed_winner',v_finish.winner_user_id,
      'claimed_kind',v_finish.finish_kind,'observed_kind',v_kind));
  END IF;

  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count, v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'winner' AND tp.position = 1;
  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_position_one_count, v_position_one_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.position = 1;
  IF v_winner_count <> 1 OR v_position_one_count <> 1
     OR v_canonical_winner IS DISTINCT FROM p_winner_user_id
     OR v_position_one_winner IS DISTINCT FROM p_winner_user_id THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','canonical_winner_not_proven','winner_rows',v_winner_count,
      'position_one_rows',v_position_one_count,'observed_winner',v_canonical_winner,
      'requested_winner',p_winner_user_id));
  END IF;

  SELECT count(*) FILTER (WHERE tp.status IN ('registered','playing')),
         count(*) FILTER (WHERE tp.position IS NULL)
    INTO v_open_players, v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_duplicate_positions
    FROM (
      SELECT tp.position FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL
       GROUP BY tp.position HAVING count(*) <> 1
    ) duplicates;
  IF v_open_players <> 0 OR v_unranked <> 0 OR v_duplicate_positions <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','standings_not_terminal','open_players',v_open_players,
      'unranked_players',v_unranked,'duplicate_positions',v_duplicate_positions));
  END IF;
  IF COALESCE(v_t.on_break,false) THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','terminal_break_flag_set'));
  END IF;

  SELECT count(*) INTO v_unsettled_obligations
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND abs(round(COALESCE(o.amount_paid,0),2)
           - round(COALESCE(o.amount_owed,0),2)) > 0.005;
  IF v_unsettled_obligations <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','unsettled_obligations','count',v_unsettled_obligations));
  END IF;

  -- Satellite prize history is one combined entitlement row (ticket value plus
  -- an optional cash remainder). Its format checker proves both constituent
  -- receipts exactly; comparing that cache to either receipt alone would
  -- falsely reject a short-field last-seat winner. The generic relation stays
  -- an independent certificate for every other format.
  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN
    SELECT count(*) INTO v_bad_place_evidence
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND o.amount_owed > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = o.tournament_id
            AND tp.position = o.place AND tp.user_id = o.user_id
            AND abs(round(COALESCE(tp.prize,0),2) - round(o.amount_owed,2)) <= 0.005
       );
    SELECT count(*) INTO v_bad_player_prizes
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND round(COALESCE(tp.prize,0),2) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
            AND o.place = tp.position AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'final_table_deal'
            AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       );
  END IF;
  IF v_bad_place_evidence <> 0 OR v_bad_player_prizes <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','prize_evidence_mismatch','place_obligations',v_bad_place_evidence,
      'player_prizes',v_bad_player_prizes));
  END IF;

  IF v_kind = 'normal' THEN
    SELECT * INTO v_place_batch
      FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_place_batch.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_place_batch_not_settled'));
    END IF;

    IF v_modern_place THEN
      BEGIN
        v_domain_check:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
        IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'canonical place proof refused';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'code','canonical_place_batch_not_proven','detail',SQLERRM));
      END;
    END IF;

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';
    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','prize_pool_not_fully_obligated','prize_pool',v_t.prize_pool,
        'place_obligations',v_place_owed));
    END IF;
    IF round(COALESCE(v_t.guaranteed_prize,0),2)
         > round(COALESCE(v_t.prize_pool,0),2) + 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','guarantee_not_funded','guarantee',v_t.guaranteed_prize,
        'prize_pool',v_t.prize_pool));
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id;
  v_escrow_found := FOUND;
  IF NOT v_escrow_found THEN
    IF COALESCE(v_t.prize_pool,0) <> 0 OR COALESCE(v_t.bounty_pool,0) <> 0
       OR COALESCE(v_t.total_rake,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_payouts po
                   WHERE po.tournament_id = p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','escrow_evidence_missing'));
    END IF;
  ELSIF abs(round(v_escrow.prize_balance,2)) > 0.005
     OR abs(round(v_escrow.bounty_balance,2)) > 0.005
     OR abs(round(v_escrow.fee_balance,2)) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','escrow_not_zero','prize_balance',v_escrow.prize_balance,
      'bounty_balance',v_escrow.bounty_balance,'fee_balance',v_escrow.fee_balance));
  END IF;

  SELECT GREATEST(round(COALESCE(sum(rr.rake_amount),0),2),0) INTO v_rake_expected
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT amount,destination,settled_at,attributed_at
    INTO v_rake_recorded,v_rake_destination,v_rake_settled_at,v_rake_attributed_at
    FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  v_rake_found := FOUND;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF NOT v_rake_found OR v_rake_settled_at IS NULL
     OR (v_rake_attributed_at IS NULL AND NOT v_deferred) OR v_rake_destination = 'pending'
     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','rake_not_settled','expected',v_rake_expected,
      'recorded',CASE WHEN v_rake_found THEN v_rake_recorded ELSE NULL END,
      'destination',CASE WHEN v_rake_found THEN v_rake_destination ELSE NULL END,
      'attributed_at',CASE WHEN v_rake_found THEN v_rake_attributed_at ELSE NULL END));
  END IF;

  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','pending_bounty_obligations'));
    END IF;
    SELECT * INTO v_bounty FROM public.tournament_bounty_completion_receipts
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_bounty.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_bounty.pool_finalized_at IS NULL
       OR COALESCE((v_bounty.pool_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','bounty_pool_not_certified'));
    END IF;
    IF COALESCE(v_t.is_mystery_bounty,false)
       AND COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
       AND (v_bounty.mystery_settled_at IS NULL
            OR COALESCE((v_bounty.mystery_result->>'ok')::boolean,false) IS NOT TRUE
            OR COALESCE((v_bounty.mystery_result->>'balanced')::boolean,false) IS NOT TRUE) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','mystery_bounty_not_certified'));
    END IF;
  END IF;

  IF v_kind = 'final_table_deal' THEN
    SELECT * INTO v_deal FROM public.tournament_final_table_deal_batches
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_deal.chip_leader IS DISTINCT FROM p_winner_user_id
       OR v_deal.settled_at IS NULL OR v_deal.escrow_prize_after IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_final_table_deal_batch_not_settled'));
    ELSE
      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_final_table_deal_not_proven','detail',v_domain_check));
      END IF;
    END IF;
  END IF;

  IF v_kind = 'satellite' THEN
    SELECT * INTO v_satellite
      FROM public.tournament_satellite_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_satellite.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_satellite.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_satellite_batch_not_settled'));
    ELSE
      v_domain_check := public.fn_check_atomic_satellite_finish(p_tournament_id);
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_satellite_finish_not_proven','detail',v_domain_check));
      END IF;
    END IF;

    SELECT count(*) INTO v_bad_satellite_seats
      FROM public.tournament_players target_seat
     WHERE target_seat.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts po
          WHERE po.tournament_id = p_tournament_id
            AND po.source = 'satellite_seat'
            AND po.user_id = target_seat.user_id
            AND po.metadata->>'registration_id' = target_seat.id::text
       );
    IF v_bad_satellite_seats <> 0 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_seat_evidence_missing','count',v_bad_satellite_seats));
    END IF;

    -- Every in-kind payout names the original finisher/place and the exact
    -- target registration it funded. A payout row by itself is not a seat,
    -- and a target seat by itself is not a durable payout record.
    SELECT count(*) INTO v_bad_satellite_outcomes
      FROM public.tournament_payouts po
     WHERE po.tournament_id = p_tournament_id AND po.source = 'satellite_seat'
       AND (po."position" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players finisher
               WHERE finisher.tournament_id = p_tournament_id
                 AND finisher.user_id = po.user_id
                 AND finisher.position = po."position"
            )
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players target_seat
               WHERE target_seat.id::text = po.metadata->>'registration_id'
                 AND target_seat.user_id = po.user_id
                 AND target_seat.source_satellite_id = p_tournament_id
            ));

    -- Seat awards and cash ticket fallbacks form a top-finisher prefix. A gap
    -- means a lower place was paid while a higher promised place was skipped.
    WITH awarded_positions AS (
      SELECT po."position" AS place
        FROM public.tournament_payouts po
       WHERE po.tournament_id = p_tournament_id
         AND po.source = 'satellite_seat' AND po."position" IS NOT NULL
      UNION
      SELECT o.place
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
         AND o.place IS NOT NULL AND round(o.amount_paid,2) > 0
         AND abs(round(o.amount_paid,2)-round(o.amount_owed,2)) <= 0.005
    ), bounds AS (SELECT max(place) AS max_place FROM awarded_positions)
    SELECT count(*) INTO v_satellite_award_gaps
      FROM bounds b
      CROSS JOIN LATERAL generate_series(1,b.max_place) expected(place)
     WHERE b.max_place IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM awarded_positions a WHERE a.place=expected.place);

    IF v_bad_satellite_outcomes <> 0 OR v_satellite_award_gaps <> 0
       OR EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'satellite_remainder'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_players tp
               WHERE tp.tournament_id=p_tournament_id AND tp.user_id=o.user_id
            )
       ) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_awards_not_certified',
        'invalid_outcomes',v_bad_satellite_outcomes,
        'award_gaps',v_satellite_award_gaps));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',jsonb_array_length(v_failures) = 0,
    'reason',CASE WHEN jsonb_array_length(v_failures) = 0 THEN NULL
                  ELSE v_failures->0->>'code' END,
    'tournament_id',p_tournament_id,'winner_user_id',p_winner_user_id,
    'finish_kind',v_kind,'failures',v_failures,
    'financials',jsonb_build_object(
      'unsettled_obligations',v_unsettled_obligations,
      'place_obligations',v_place_owed,
      'rake_expected',v_rake_expected,
      'prize_balance',CASE WHEN v_escrow_found THEN v_escrow.prize_balance ELSE NULL END,
      'bounty_balance',CASE WHEN v_escrow_found THEN v_escrow.bounty_balance ELSE NULL END,
      'fee_balance',CASE WHEN v_escrow_found THEN v_escrow.fee_balance ELSE NULL END));
END;
$function$;

-- END tournament-fee-terminal-gates-draft.sql

-- BEGIN tournament-fee-satellite-gates-draft.sql
-- DRAFT. Exact ticket/prize/escrow checks are preserved.
CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.position BETWEEN 1 AND v_ticket_award_count
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING id INTO v_registration_id;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_target.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_target_buy_in, 0, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'entry_prize', v_target_buy_in,
           'entry_bounty', 0,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND position BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  RETURN public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_settlement_receipt(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_winner_amount numeric := 0;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'satellite % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;
  IF v_h.receipt_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'satellite % has unsupported receipt version %',
      p_tournament_id, v_h.receipt_version USING ERRCODE = 'P0404';
  END IF;

  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR COALESCE(v_target.bounty_amount,0) <> 0
       OR COALESCE(v_target.is_bounty,false)
       OR COALESCE(v_target.is_pko,false)
       OR COALESCE(v_target.is_mystery_bounty,false)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  SELECT count(*), count(DISTINCT tp.position)
    INTO v_field_size, v_position_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size <> v_h.field_size
     OR v_position_count <> v_h.field_size
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.position IS NULL OR tp.position < 1 OR tp.position > v_h.field_size)
    ) OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.position = 1 AND tp.status::text = 'winner'
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1
          AND tp.status::text IS DISTINCT FROM 'eliminated'
     ) THEN
    RAISE EXCEPTION 'satellite % receipt has no exact final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'ticket')
          <> v_h.entry_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND tp.position = a.place
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR a.user_id IS DISTINCT FROM tp.user_id
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position BETWEEN 1 AND v_h.ticket_award_count
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.place = tp.position AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM a.place
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A cap-blocked full award remains the source pool's money but is held in a
  -- noncash, target-scoped ticket escrow. Prove the immutable award identity,
  -- exact issue journal and absence of a wallet credit on every replay.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id=a.payout_id
      LEFT JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key=a.idempotency_key||':ticket_escrow'
       AND l.to_type='escrow' AND l.to_entity_id=a.ticket_id
     WHERE a.tournament_id=p_tournament_id
       AND a.delivery_kind='ticket'
       AND (tk.id IS NULL
         OR tk.issued_by IS DISTINCT FROM
              '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
         OR tk.holder_id IS DISTINCT FROM a.user_id
         OR tk.value IS DISTINCT FROM a.amount
         OR tk.status NOT IN ('issued','redeemed')
         OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
         OR tk.source_tournament_id IS DISTINCT FROM v_h.target_id
         OR tk.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR tk.source_refund_entitlement_id IS NOT NULL
         OR tk.source_satellite_award_place IS DISTINCT FROM a.place
         OR tk.entry_prize IS DISTINCT FROM v_h.target_buy_in
         OR tk.entry_bounty IS DISTINCT FROM 0::numeric
         OR tk.entry_fee IS DISTINCT FROM v_h.target_fee
         OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR p.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR p.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR l.id IS NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'escrow'
         OR l.to_entity_id IS DISTINCT FROM tk.id
         OR l.amount IS DISTINCT FROM a.amount
         OR l.category IS DISTINCT FROM 'ticket_issue'
         OR l.club_id IS DISTINCT FROM tk.club_id
         OR l.tournament_id IS DISTINCT FROM p_tournament_id
         OR l.settlement_id IS DISTINCT FROM
              'satellite-ticket:'||tk.id::text
         OR l.actor_service IS DISTINCT FROM 'fn_settle_satellite_tournament'
         OR l.pre_from_balance IS DISTINCT FROM
              round(v_h.pool-(a.place-1)*v_h.ticket_cost,2)
         OR l.post_from_balance IS DISTINCT FROM
              round(v_h.pool-a.place*v_h.ticket_cost,2)
         OR l.pre_to_balance IS DISTINCT FROM 0::numeric
         OR l.post_to_balance IS DISTINCT FROM a.amount
         OR l.metadata->>'kind' IS DISTINCT FROM
              'direct_satellite_entry_ticket'
         OR l.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR l.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR l.metadata->>'payout_id' IS DISTINCT FROM a.payout_id::text
         OR l.metadata->>'satellite_id' IS DISTINCT FROM p_tournament_id::text
         OR l.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR l.metadata->>'user_id' IS DISTINCT FROM a.user_id::text
         OR l.metadata->>'position' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_h.target_buy_in
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM 0::numeric
         OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee
         OR l.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency wallet_key
            WHERE wallet_key.key=a.idempotency_key)
         OR (SELECT count(*)
               FROM public.chip_transactions issue_tx
              WHERE issue_tx.transaction_type='tournament_ticket_issue'
                AND issue_tx.club_id=tk.club_id
                AND issue_tx.from_user_id IS NULL
                AND issue_tx.to_user_id=a.user_id
                AND issue_tx.amount=a.amount
                AND issue_tx.metadata->>'ticket_id'=tk.id::text
                AND issue_tx.metadata->>'escrow_entity_id'=tk.id::text
                AND issue_tx.metadata->>'holder_id'=a.user_id::text
                AND (issue_tx.metadata->>'value')::numeric=a.amount
                AND issue_tx.metadata->>'redemption_mode'=
                      'tournament_entry_only'
                AND issue_tx.metadata->>'source_tournament_id'=
                      v_h.target_id::text
                AND issue_tx.metadata->>'source_satellite_id'=
                      p_tournament_id::text
                AND issue_tx.metadata->>'source_award_place'=a.place::text
                AND issue_tx.metadata->>'payout_id'=a.payout_id::text
                AND issue_tx.metadata->>'ledger_id'=l.id::text
                AND issue_tx.metadata->>'idempotency_key'=a.idempotency_key
                AND issue_tx.metadata->>'wallet_chips_credited'='0') <> 1)
  ) OR (SELECT count(*) FROM public.tournament_tickets tk
         WHERE tk.source_satellite_id=p_tournament_id
           AND tk.source_satellite_award_place IS NOT NULL)
       <> v_h.entry_ticket_count
    OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type='prize_liability'
           AND l.from_entity_id=p_tournament_id
           AND l.category='ticket_issue'
           AND l.metadata->>'kind'='direct_satellite_entry_ticket')
       <> v_h.entry_ticket_count THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN tp.position BETWEEN 1 AND v_h.ticket_award_count THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id,
           'ticket_id', a.ticket_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  v_winner_amount := CASE WHEN v_h.ticket_award_count > 0
                          THEN v_h.ticket_cost ELSE v_h.remainder END;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'winner_id', v_h.winner_id,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'entry_ticket_count', v_h.entry_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'winner_amount', v_winner_amount,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version,
    'accounting',v_accounting);
END;
$function$;

-- END tournament-fee-satellite-gates-draft.sql

-- BEGIN tournament-fee-cancellation-adapter-draft.sql
-- DRAFT. Original cancellation receipts stay intact; accounting records zero net.
CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(
    auth.uid(),p_admin_id,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE;
  v_stored public.tournament_cancellation_receipts%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_player record;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_fee record;
  v_contribution public.spin_reserve_ledger%ROWTYPE;
  v_draw public.spin_reserve_ledger%ROWTYPE;
  v_pool public.spin_bonus_pools%ROWTYPE;
  v_settle jsonb;
  v_receipt jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_ticket_returns jsonb := '[]'::jsonb;
  v_source_player_ids uuid[] := ARRAY[]::uuid[];
  v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_ticket_return_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_fee_reversal_ids uuid[] := ARRAY[]::uuid[];
  v_registration_id uuid;
  v_fee_reversal_id uuid;
  v_original_entry_journal_id uuid;
  v_original_draw_journal_id uuid;
  v_draw_reversal_id uuid;
  v_draw_reversal_journal_id uuid;
  v_contribution_reversal_id uuid;
  v_contribution_reversal_journal_id uuid;
  v_spin_unwind_id uuid;
  v_source_player_count integer := 0;
  v_refunded_count integer := 0;
  v_refund_line_count integer := 0;
  v_ticket_return_count integer := 0;
  v_zero_refund_count integer := 0;
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_total_refunded numeric := 0;
  v_total_ticket_returned numeric := 0;
  v_fees_reversed numeric := 0;
  v_total_rake_before numeric := 0;
  v_total_rake_after numeric := 0;
  v_total_owed numeric;
  v_draw_amount numeric := 0;
  v_pool_balance_before numeric;
  v_pool_balance_after numeric;
  v_rows integer;
  v_journal_count integer;
  v_cancelled_at timestamptz := transaction_timestamp();
  v_close_note constant text := 'atomic cancellation receipt: exact zero';
BEGIN
  -- Every terminal authority takes this lock before any row lock. Cancellation,
  -- satellite finish and cash finish can touch the same wallets and event rows.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament id is required' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;
  -- DIAMOND PHASE 8: a Diamond event is cancelled by its own authority, which
  -- returns every entry from custody and writes the same immutable receipt;
  -- the chip rails below never saw a Diamond entry.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_cancel(p_tournament_id, p_admin_id);
  END IF;
  IF v_uid IS NOT NULL
     AND NOT public.fn_can_create_games(v_t.club_id,v_uid) THEN
    RAISE EXCEPTION 'Only the governed game operator may cancel a tournament'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stored FROM public.tournament_cancellation_receipts h
   WHERE h.tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %',v_t.status USING ERRCODE='55000';
  END IF;

  -- A tournament that has started is resumed or settled, never voided.
  -- start_time is a schedule/fill deadline; it is not proof that play began.
  -- The stored receipt above remains replayable without another cancellation.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR COALESCE(v_t.spin_multiplier,0)>0
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                 WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw')
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb
                 JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind<>'refund' AND o.amount_paid>0) THEN
    RAISE EXCEPTION
      'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

  PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());

  -- Freeze every identity before any payer runs. Any concurrent registration,
  -- seat move or hand settlement either committed before these locks and is in
  -- the receipt, or waits behind this transaction and sees a terminal parent.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s
   JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
   ORDER BY s.table_id,s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[])
    INTO v_source_player_ids FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  v_source_player_count := cardinality(v_source_player_ids);
  v_closed_table_count := cardinality(v_closed_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'atomic cancellation escrow prelock');
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_t.prize_pool IS DISTINCT FROM v_e.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_e.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_e.fee_balance THEN
    RAISE EXCEPTION 'tournament % caches do not equal exact escrow before cancellation',
      p_tournament_id USING ERRCODE='P0404';
  END IF;

  -- A booked Spin first gives back its draw, then withdraws this event's own
  -- contribution. Each pool movement creates its strict journal before the
  -- matching immutable reversal row and all four ids are stored together.
  PERFORM 1 FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id ORDER BY r.created_at,r.id FOR UPDATE;
  SELECT * INTO v_contribution FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id AND r.kind='contribution';
  IF FOUND THEN
    IF (SELECT count(*) FROM public.spin_reserve_ledger r
         WHERE r.tournament_id=p_tournament_id AND r.kind='contribution') <> 1
       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind IN ('draw_reversal','contribution_reversal'))
       OR EXISTS (SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
                   WHERE u.tournament_id=p_tournament_id) THEN
      RAISE EXCEPTION 'Spin % has an ambiguous or partially unwound reserve contract',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_draw FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw';
    IF FOUND AND (SELECT count(*) FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind='jackpot_draw') <> 1 THEN
      RAISE EXCEPTION 'Spin % has more than one immutable draw',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_pool FROM public.spin_bonus_pools p
     WHERE p.club_id=v_contribution.club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % original reserve owner is missing',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    v_pool_balance_before := v_pool.balance;
    IF v_pool_balance_before IS NULL
       OR v_pool_balance_before::text IN ('NaN','Infinity','-Infinity')
       OR v_pool_balance_before<0 THEN
      RAISE EXCEPTION 'Spin % reserve balance is invalid',p_tournament_id
        USING ERRCODE='22003';
    END IF;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_original_entry_journal_id
      FROM public.chip_ledger l
     WHERE l.tournament_id=p_tournament_id
       AND l.category='spin_entry'
       AND l.from_type='prize_liability'
       AND l.from_entity_id=p_tournament_id
       AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 OR v_contribution.amount<=0 THEN
      RAISE EXCEPTION 'Spin % contribution has no single exact journal',p_tournament_id
        USING ERRCODE='P0404';
    END IF;

    IF v_draw.id IS NOT NULL THEN
      IF v_draw.club_id IS DISTINCT FROM v_contribution.club_id
         OR v_draw.amount>=0 THEN
        RAISE EXCEPTION 'Spin % draw disagrees with its contribution owner',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      v_draw_amount := round(-v_draw.amount,2);
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_original_draw_journal_id
        FROM public.chip_ledger l
       WHERE l.tournament_id=p_tournament_id
         AND l.category='spin_prize'
         AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      PERFORM public.fn_ca_declare_ledger(
        'reversal','prize_liability',p_tournament_id,NULL,
        'spin:'||p_tournament_id::text||':cancel:draw',NULL);
      UPDATE public.spin_bonus_pools
         SET balance=balance+v_draw_amount,updated_at=now()
       WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Spin % reserve vanished during draw reversal',p_tournament_id
          USING ERRCODE='40001';
      END IF;
      INSERT INTO public.spin_reserve_ledger
        (club_id,tournament_id,kind,amount,balance_after,multiplier,
         buy_in,seats,house_rake,note)
      VALUES
        (v_draw.club_id,p_tournament_id,'draw_reversal',v_draw_amount,
         v_pool_balance_after,v_draw.multiplier,v_draw.buy_in,v_draw.seats,
         v_draw.house_rake,'atomic cancellation reversed the exact reserve draw')
      RETURNING id INTO v_draw_reversal_id;
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_draw_reversal_journal_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:draw'
         AND l.tournament_id=p_tournament_id AND l.category='reversal'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_tournament_id
         AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw reversal has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
    ELSE
      v_pool_balance_after := v_pool_balance_before;
    END IF;

    IF v_pool_balance_after<v_contribution.amount THEN
      RAISE EXCEPTION 'Spin % reserve cannot return its own contribution',p_tournament_id
        USING ERRCODE='P0403';
    END IF;
    PERFORM public.fn_ca_declare_ledger(
      'reversal','prize_liability',p_tournament_id,NULL,
      'spin:'||p_tournament_id::text||':cancel:entry',NULL);
    UPDATE public.spin_bonus_pools
       SET balance=balance-v_contribution.amount,updated_at=now()
     WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % reserve vanished during contribution reversal',p_tournament_id
        USING ERRCODE='40001';
    END IF;
    INSERT INTO public.spin_reserve_ledger
      (club_id,tournament_id,kind,amount,balance_after,multiplier,
       buy_in,seats,house_rake,note)
    VALUES
      (v_contribution.club_id,p_tournament_id,'contribution_reversal',
       -v_contribution.amount,v_pool_balance_after,v_contribution.multiplier,
       v_contribution.buy_in,v_contribution.seats,v_contribution.house_rake,
       'atomic cancellation returned the exact entry contribution')
    RETURNING id INTO v_contribution_reversal_id;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_contribution_reversal_journal_id
      FROM public.chip_ledger l
     WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:entry'
       AND l.tournament_id=p_tournament_id AND l.category='reversal'
       AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
       AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 THEN
      RAISE EXCEPTION 'Spin % contribution reversal has no single exact journal',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.tournament_spin_cancellation_unwinds(
      tournament_id,pool_id,reserve_owner_id,
      original_contribution_id,original_draw_id,
      original_entry_journal_id,original_draw_journal_id,
      draw_reversal_id,draw_reversal_journal_id,
      contribution_reversal_id,contribution_reversal_journal_id,
      contribution_amount,draw_amount,pool_balance_before,pool_balance_after,
      settled_at)
    VALUES(
      p_tournament_id,v_pool.id,v_contribution.club_id,
      v_contribution.id,v_draw.id,
      v_original_entry_journal_id,v_original_draw_journal_id,
      v_draw_reversal_id,v_draw_reversal_journal_id,
      v_contribution_reversal_id,v_contribution_reversal_journal_id,
      v_contribution.amount,v_draw_amount,v_pool_balance_before,
      v_pool_balance_after,v_cancelled_at)
    RETURNING tournament_id INTO v_spin_unwind_id;
  ELSIF EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('jackpot_draw','draw_reversal','contribution_reversal')) THEN
    RAISE EXCEPTION 'Spin % has reserve evidence without its contribution',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  -- Return each unconsumed funded entitlement as cash to its recorded club.
  -- The exact refund payer proves wallet, satellite transfer or redeemed-ticket
  -- funding and excludes value already returned as a ticket. Stored historical
  -- cancellation receipts continue to replay through their original evidence.
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
    JOIN public.tournament_tickets tk
      ON tk.source_refund_entitlement_id=e.id
   WHERE e.tournament_id=p_tournament_id
     AND tp.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'active qualifier roster already has an unreceipted return ticket'
      USING ERRCODE='P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id
   WHERE e.tournament_id=p_tournament_id
     AND (tp.id IS NULL OR (e.entitlement_kind IN (
            'satellite_seat','tournament_ticket')
          AND e.registration_id IS DISTINCT FROM tp.id))) THEN
    RAISE EXCEPTION 'refund entitlement is detached from the frozen roster'
      USING ERRCODE='P0404';
  END IF;
  FOR v_player IN
    SELECT DISTINCT ON (tp.user_id) tp.id,tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
     ORDER BY tp.user_id,tp.id
  LOOP
    -- The owner-only plan validates every source ledger, wallet debit and
    -- escrow rail. Identity comes from the locked entitlement table below.
    PERFORM 1 FROM public.fn_ca_tournament_refund_plan(
      p_tournament_id,v_player.user_id);
    LOOP
      SELECT e.* INTO v_entitlement
        FROM public.tournament_refund_entitlements e
       WHERE e.tournament_id=p_tournament_id
         AND e.user_id=v_player.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_tranches tr
            WHERE tr.entitlement_id=e.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_tickets tk
            WHERE tk.source_refund_entitlement_id=e.id)
       ORDER BY e.entitlement_kind,e.id
       LIMIT 1 FOR UPDATE OF e;
      EXIT WHEN NOT FOUND;
      v_registration_id:=COALESCE(v_entitlement.registration_id,v_player.id);
      IF v_entitlement.entitlement_kind IN (
          'wallet_charge','satellite_seat','tournament_ticket') THEN
        SELECT COALESCE(o.amount_paid,0)+v_entitlement.gross
          INTO v_total_owed FROM public.tournament_obligations o
         WHERE o.tournament_id=p_tournament_id AND o.kind='refund'
           AND o.place IS NULL AND o.user_id=v_player.user_id FOR UPDATE;
        IF NOT FOUND THEN v_total_owed:=v_entitlement.gross; END IF;
        v_settle:=public.fn_settle_tournament_refund_exact(
          p_tournament_id,v_player.user_id,
          v_entitlement.refund_wallet_club_id,v_total_owed,
          v_entitlement.refund_prize,v_entitlement.refund_bounty,
          v_entitlement.refund_fee,'atomic_cancel_tournament',
          'Tournament cancellation refund: '||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'fully_settled')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'remaining')::numeric,-1)<>0
           OR (v_settle->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR v_settle->>'entitlement_kind' IS DISTINCT FROM v_entitlement.entitlement_kind
           OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_settle->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_settle->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_settle->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee THEN
          RAISE EXCEPTION 'exact cancellation refund refused entitlement %: %',
            v_entitlement.id,v_settle USING ERRCODE='55000';
        END IF;
        v_refunds:=v_refunds||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'gross_paid',v_entitlement.gross,
          'amount_paid_before',(v_settle->>'already_paid')::numeric,
          'amount_paid_now',(v_settle->>'paid')::numeric,
          'refund_prize',(v_settle->>'refund_prize')::numeric,
          'refund_bounty',(v_settle->>'refund_bounty')::numeric,
          'refund_fee',(v_settle->>'refund_fee')::numeric,
          'obligation_id',(v_settle->>'obligation_id')::uuid,
          'idempotency_key',v_settle->>'idempotency_key',
          'credit_ledger_id',(v_settle->>'credit_ledger_id')::uuid,
          'wallet_transaction_id',(v_settle->>'wallet_transaction_id')::uuid));
        v_refund_line_count:=v_refund_line_count+1;
        v_total_refunded:=round(
          v_total_refunded+(v_settle->>'paid')::numeric,2);
      ELSE
        RAISE EXCEPTION 'unknown cancellation entitlement kind %',
          v_entitlement.entitlement_kind USING ERRCODE='P0404';
      END IF;
      IF NOT v_registration_id=ANY(v_refunded_registration_ids) THEN
        v_refunded_registration_ids:=array_append(
          v_refunded_registration_ids,v_registration_id);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_refunded_registration_ids
    FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_zero_refund_registration_ids
    FROM unnest(v_source_player_ids) ids(id)
   WHERE NOT id=ANY(v_refunded_registration_ids);
  v_refunded_count:=cardinality(v_refunded_registration_ids);
  v_zero_refund_count:=cardinality(v_zero_refund_registration_ids);

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.fn_ca_tournament_refund_plan(
                    p_tournament_id,tp.user_id))) THEN
    RAISE EXCEPTION 'cancellation left a refundable entitlement unpaid'
      USING ERRCODE='55000';
  END IF;

  -- Rake reversal is attribution only: the exact refund payer already returned
  -- the fee component from escrow. Reverse each current player's net fee and
  -- each aggregate Spin source exactly once, retaining immutable source ids.
  IF EXISTS (SELECT 1 FROM public.rake_records r
              WHERE r.tournament_id=p_tournament_id
                AND r.source='atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'unreceipted cancellation rake evidence already exists'
      USING ERRCODE='P0404';
  END IF;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_before FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_before<0
     OR v_total_rake_before::text IN ('NaN','Infinity','-Infinity')
     OR round(COALESCE(v_t.total_rake,0),2) IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % rake cache and evidence disagree',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  FOR v_fee IN
    SELECT tp.user_id,r.club_id,
           round(sum(r.rake_amount),2) AS amount,
           jsonb_agg(r.id ORDER BY r.id) AS source_ids
      FROM (SELECT DISTINCT p.user_id FROM public.tournament_players p
             WHERE p.tournament_id=p_tournament_id AND p.user_id IS NOT NULL) tp
      JOIN public.rake_records r
        ON r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.metadata->>'user_id'=tp.user_id::text
     GROUP BY tp.user_id,r.club_id HAVING round(sum(r.rake_amount),2)>0
     ORDER BY tp.user_id,r.club_id
  LOOP
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.amount,1,0,true,
      p_tournament_id,'atomic_cancel_tournament',jsonb_build_object(
        'kind','tournament_fee_refund','user_id',v_fee.user_id,
        'original_rake_record_ids',v_fee.source_ids))
    RETURNING id INTO v_fee_reversal_id;
    v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
    v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
  END LOOP;
  FOR v_fee IN
    SELECT r.*,round(r.rake_amount+COALESCE((SELECT sum(rr.rake_amount)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id
       AND rr.source='atomic_cancel_tournament'
       AND rr.metadata->>'original_rake_record_id'=r.id::text),0),2) AS amount
      FROM public.rake_records r
     WHERE r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.source IN ('fn_spin_book_entry','fn_spin_settle_game')
       AND r.rake_amount>0 AND NULLIF(r.metadata->>'user_id','') IS NULL
     ORDER BY r.id FOR UPDATE
  LOOP
    IF v_fee.amount>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,
        player_contributions,metadata)
      VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.pot_size,
        v_fee.num_players,0,true,p_tournament_id,'atomic_cancel_tournament',
        v_fee.player_contributions,jsonb_build_object(
          'kind','spin_rake_refund','original_source',v_fee.source,
          'original_rake_record_id',v_fee.id))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
    END IF;
  END LOOP;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_after FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_after IS DISTINCT FROM 0::numeric
     OR v_fees_reversed IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % fee reversal did not close exactly',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % cancellation did not close all escrow banks',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  UPDATE public.tournament_escrow
     SET closed_at=v_cancelled_at,close_note=v_close_note,updated_at=now()
   WHERE tournament_id=p_tournament_id AND closed_at IS NULL
     AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its exact-zero escrow close',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,
         chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at=v_cancelled_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.left_at IS NULL RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_released_seat_ids FROM released;
  v_released_seat_count:=cardinality(v_released_seat_ids);
  UPDATE public.table_seats s
     SET status='left',leave_pending=false,is_sitting_out=false,is_away=false,
         sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.id=ANY(v_source_seat_ids) AND s.left_at IS NOT NULL;

  UPDATE public.tournaments
     SET status='CANCELLED',ended_at=v_cancelled_at,updated_at=now(),
         prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,
         on_break=false,break_started_at=NULL,break_ends_at=NULL
   WHERE id=p_tournament_id
     AND upper(COALESCE(status::text,'')) NOT IN
         ('COMPLETED','CANCELLED','CANCELED','COMPLETING');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim',
      p_tournament_id USING ERRCODE='40001';
  END IF;
  UPDATE public.tables
     SET status='closed',lifecycle='closed',current_players=0,
         terminal_closed_at=v_cancelled_at,updated_at=now()
   WHERE tournament_id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>v_closed_table_count THEN
    RAISE EXCEPTION 'tournament % did not close every table',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids FROM unnest(v_fee_reversal_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_ticket_return_ids FROM unnest(v_ticket_return_ids) ids(id);
  v_receipt:=jsonb_build_object(
    'ok',true,'success',true,'fully_settled',true,'receipt_version',2,
    'tournament_id',p_tournament_id,'actor_id',v_actor,'status','CANCELLED',
    'source_player_count',v_source_player_count,
    'refunded_count',v_refunded_count,'refund_line_count',v_refund_line_count,
    'ticket_return_count',v_ticket_return_count,
    'total_ticket_returned',v_total_ticket_returned,
    'total_refunded',v_total_refunded,'fees_reversed',v_fees_reversed,
    'closed_table_count',v_closed_table_count,
    'source_seat_count',v_source_seat_count,
    'released_seat_count',v_released_seat_count,
    'refunds',v_refunds,'ticket_returns',v_ticket_returns,
    'settled_at',v_cancelled_at);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id,actor_id,receipt_version,
    source_player_count,source_player_ids,
    refunded_count,refunded_registration_ids,refund_line_count,
    ticket_return_count,ticket_return_ids,total_ticket_returned,
    zero_refund_count,zero_refund_registration_ids,
    total_refunded,fees_reversed,total_rake_before,total_rake_after,
    closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
    released_seat_count,released_seat_ids,fee_reversal_ids,
    escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,
    receipt,settled_at)
  VALUES(
    p_tournament_id,v_actor,2,
    v_source_player_count,v_source_player_ids,
    v_refunded_count,v_refunded_registration_ids,v_refund_line_count,
    v_ticket_return_count,v_ticket_return_ids,v_total_ticket_returned,
    v_zero_refund_count,v_zero_refund_registration_ids,
    v_total_refunded,v_fees_reversed,v_total_rake_before,v_total_rake_after,
    v_closed_table_count,v_closed_table_ids,v_source_seat_count,v_source_seat_ids,
    v_released_seat_count,v_released_seat_ids,v_fee_reversal_ids,
    v_cancelled_at,v_close_note,v_spin_unwind_id,v_receipt,v_cancelled_at);

  PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);
  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,v_actor);
END;
$function$;

-- END tournament-fee-cancellation-adapter-draft.sql

-- BEGIN tournament-fee-legacy-adapters-draft.sql
-- The original attribution RPC is now a read-only compatibility receipt. The
-- single fee settlement authority owns source posting; this door cannot post a
-- second synthetic tournament/user commission or repeat player/VIP statistics.
CREATE OR REPLACE FUNCTION public.fn_attribute_tournament_rake(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$DECLARE receipt jsonb;n int;amount numeric;BEGIN
 receipt:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
 IF receipt IS NULL OR receipt->>'status'='banked_accrual_deferred' THEN
  -- Raising also protects old callers that ignored a returned ok:false.
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000'; END IF;
 SELECT count(DISTINCT f.player_id),COALESCE(sum(r.rake_credit),0) INTO n,amount
  FROM public.accounting_tournament_fee_sources f JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
  WHERE r.tournament_id=p_tournament_id AND r.disposition='earned';
 RETURN jsonb_build_object('ok',true,'accounting_version',2,'already_attributed',true,'attributed_users',n,'members',n,'attributed_chips',amount,'accounting',receipt);
END$$;
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_attribute_tournament_rake(uuid) TO service_role;

-- Existing repair RPC names remain compatible observations. They cannot bypass
-- the one source/recognition path or stamp a deferred event attributed-complete.
CREATE OR REPLACE FUNCTION public.fn_backpay_tournament_rake_attribution(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('ok',true,'authority','fn_process_weekly_accounting','scanned',0,'paid',0,'chips',0,
  'remaining',count(*),'requires_reconciliation',count(*)) FROM public.tournament_rake_settlements r
  WHERE r.settled_at IS NOT NULL AND r.amount>0 AND (r.attributed_at IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_tournament_fee_recognitions a WHERE a.tournament_id=r.tournament_id AND a.status='recognized'))
$$;
CREATE OR REPLACE FUNCTION public.fn_repair_tournament_rake_attribution(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('ok',true,'authority','fn_process_weekly_accounting','repaired',0,'still_failing',count(*))
 FROM public.tournament_rake_settlements r WHERE r.settled_at IS NOT NULL AND r.amount>0 AND r.attributed_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer),public.fn_repair_tournament_rake_attribution(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer),public.fn_repair_tournament_rake_attribution(integer) TO service_role;

-- END tournament-fee-legacy-adapters-draft.sql

-- BEGIN tournament-fee-monitor-draft.sql
-- DRAFT. Exact preimage md5 65dc8a03543053bec16f78b78c513b9b. One existing monitor; no second payment authority.
CREATE OR REPLACE FUNCTION public.fn_tournament_rake_settlement_check(p_grace_minutes integer DEFAULT 30, p_since_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_grace    integer := GREATEST(COALESCE(p_grace_minutes, 30), 1);
  v_days     integer := GREATEST(COALESCE(p_since_days, 7), 1);
  v_missing  integer := 0;
  v_owed     numeric := 0;
  v_oldest   timestamptz;
  v_ids      uuid[];
  v_verdict  text := 'pass';
  v_severity text;
  v_message  text;
  v_context  jsonb;
  v_alerts   integer := 0;
BEGIN
  WITH unsettled AS (
    SELECT t.id,
           t.ended_at,
           (SELECT COALESCE(sum(r.rake_amount), 0) FROM public.rake_records r
             WHERE r.tournament_id = t.id AND r.is_tournament) AS banked
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND t.ended_at IS NOT NULL
       AND t.ended_at > now() - make_interval(days => v_days)
       AND t.ended_at < now() - make_interval(mins => v_grace)
       AND EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.tournament_id = t.id AND r.is_tournament)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements s
                        WHERE s.tournament_id = t.id AND s.settled_at IS NOT NULL)
       -- A fully refunded cancellation has no fee-bank movement to make.
       -- Its independent exact-zero accounting receipt is still mandatory.
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_cancellation_receipts c
         JOIN public.accounting_tournament_fee_recognitions a ON a.tournament_id=c.tournament_id
         WHERE c.tournament_id=t.id AND c.total_rake_after=0
           AND c.fees_reversed=c.total_rake_before AND a.net_rake=0
           AND a.status IN('cancelled','banked_accrual_deferred')
           AND public.fn_accounting_tournament_terminal_fee_receipt(t.id)->>'bank_receipt_kind'='none')
  )
  SELECT count(*),
         COALESCE(sum(banked), 0),
         min(ended_at),
         COALESCE((array_agg(id ORDER BY ended_at))[1:20], ARRAY[]::uuid[])
    INTO v_missing, v_owed, v_oldest, v_ids
    FROM unsettled;

  IF v_missing > 0 THEN
    v_verdict  := 'rake_never_settled';
    v_severity := CASE WHEN v_missing >= 5 OR v_owed >= 50 THEN 'critical' ELSE 'warning' END;
    v_message  := format(
      '%s terminal tournament(s) have fee evidence and no completed bank or exact-zero cancellation receipt after '
      '%s minutes; their net fee evidence totals %s. Oldest finished %s. ',
      v_missing, v_grace, round(v_owed, 2), v_oldest);
  END IF;

  v_context := jsonb_build_object(
    'grace_minutes',  v_grace,
    'window_days',    v_days,
    'missing_count',  v_missing,
    'rake_unpaid',    round(v_owed, 2),
    'oldest_ended_at', v_oldest,
    'sample_games',   to_jsonb(v_ids),
    'verdict',        v_verdict,
    'detail',         'the canonical tournament terminal authority owns fee banking and recognition; this detector only reports missing custody receipts. Deferred accrual remains blocked by weekly source-quality checks');

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_tournament_rake_settlement_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_rake_settlement_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

-- END tournament-fee-monitor-draft.sql
