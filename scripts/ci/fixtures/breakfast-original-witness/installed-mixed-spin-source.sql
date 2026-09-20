-- Original mixed-cutover Spins retain their legacy batch unchanged. Their
-- existing close can qualify exact original paid entries and historical terms,
-- then use the same canonical recognition and bank transaction once.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preconditions$
BEGIN
 IF to_regclass('public.accounting_mixed_cutover_spin_fee_proofs') IS NOT NULL THEN
  RAISE EXCEPTION 'mixed_spin_proof_contract_already_exists'; END IF;
 IF md5(pg_get_functiondef('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'df9bfbca2abf9f596921ad60363abafe' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'mixed_spin_proof_preimage_changed:fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)'; END IF;
 IF md5(pg_get_functiondef('public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure)) IS DISTINCT FROM 'd8231a3f9219ecacb5ae68ee3aebe435' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'mixed_spin_proof_preimage_changed:fn_accounting_tournament_fee_net_plan(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_accounting_tournament_fee_receipt_immutable()'::regprocedure)) IS DISTINCT FROM 'bdc4ee4b75e3471cd33a5ed4b250ec0f' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_tournament_fee_receipt_immutable()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_accounting_tournament_fee_receipt_immutable()'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'mixed_spin_proof_preimage_changed:fn_accounting_tournament_fee_receipt_immutable()'; END IF;
 IF md5(pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure)) IS DISTINCT FROM '0492f5a78bc3c84d54c24fd45549a0be' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'mixed_spin_proof_preimage_changed:fn_settle_tournament_rake(uuid,text)'; END IF;
 IF md5(pg_get_functiondef('public.fn_stamp_accounting_tournament_fee(uuid)'::regprocedure)) IS DISTINCT FROM '7e7495ff6800996d72b5ab27008a33a6' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_stamp_accounting_tournament_fee(uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.fn_stamp_accounting_tournament_fee(uuid)'::regprocedure) IS DISTINCT FROM 'postgres' THEN RAISE EXCEPTION 'mixed_spin_proof_preimage_changed:fn_stamp_accounting_tournament_fee(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_managed_game_contract_hash(jsonb)'::regprocedure)) IS DISTINCT FROM '1aa2f356d6d3b17135cf5505ec4166f5'
  OR md5(pg_get_functiondef('public.fn_guard_managed_game_contract_version()'::regprocedure)) IS DISTINCT FROM '95b0c11437e95b3862558a4d27434ccf'
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.managed_game_contract_versions'::regclass
   AND tgname='trg_managed_game_contract_version_immutable' AND tgenabled IN('O','A')
   AND tgfoid='public.fn_guard_managed_game_contract_version()'::regprocedure) THEN
  RAISE EXCEPTION 'mixed_spin_original_scope_authority_changed'; END IF;
END $preconditions$;

-- A later proof of immutable original facts, never a rewritten original batch.
CREATE TABLE public.accounting_mixed_cutover_spin_fee_proofs(
 rake_record_id uuid PRIMARY KEY REFERENCES public.accounting_tournament_fee_batches(rake_record_id),
 tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
 cutover_at timestamptz NOT NULL CHECK(isfinite(cutover_at)),
 original_batch jsonb NOT NULL CHECK(jsonb_typeof(original_batch)='object'),
 source_manifest jsonb NOT NULL CHECK(jsonb_typeof(source_manifest)='object'),
 original_evidence jsonb NOT NULL CHECK(jsonb_typeof(original_evidence)='object'),
 canonical_sources jsonb NOT NULL CHECK(jsonb_typeof(canonical_sources)='array' AND jsonb_array_length(canonical_sources)=3),
 qualified_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(qualified_at)),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE public.accounting_mixed_cutover_spin_fee_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_mixed_cutover_spin_fee_proofs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_mixed_cutover_spin_fee_proofs TO service_role;
CREATE TRIGGER mixed_cutover_spin_proof_immutable BEFORE UPDATE OR DELETE ON public.accounting_mixed_cutover_spin_fee_proofs
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER mixed_cutover_spin_proof_no_truncate BEFORE TRUNCATE ON public.accounting_mixed_cutover_spin_fee_proofs
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();

CREATE FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(p_rake_record_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs p
   JOIN public.accounting_tournament_fee_batches b USING(rake_record_id)
   JOIN public.rake_records r ON r.id=b.rake_record_id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
  WHERE p.rake_record_id=p_rake_record_id AND p.tournament_id=r.tournament_id
   AND b.status='legacy_unverified' AND b.source_manifest IS NULL
   AND p.original_batch=to_jsonb(b) AND p.cutover_at=c.starts_at
   AND r.created_at>=c.starts_at AND b.source_fingerprint=public.fn_accounting_tournament_fee_fingerprint(r)
   AND r.source='fn_spin_book_entry' AND r.metadata->>'kind'='spin_rake'
   AND p.canonical_sources=(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.player_id)
    FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=p_rake_record_id)
 );
$$;
REVOKE ALL ON FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_qualify_mixed_cutover_spin_fee(p_rake_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE r public.rake_records%ROWTYPE; b public.accounting_tournament_fee_batches%ROWTYPE;
 e public.tournament_refund_entitlements%ROWTYPE; l public.chip_ledger%ROWTYPE;
 tp public.tournament_players%ROWTYPE; reserve public.spin_reserve_ledger%ROWTYPE;
 item record; plan record; n integer; cutoff timestamptz; total_weight numeric:=0; early integer:=0;
 contributors jsonb:='[]'; evidence jsonb:='[]'; scope jsonb; manifest jsonb; contract jsonb;
 original_scope public.managed_game_contract_versions%ROWTYPE; v_scope public.managed_game_contract_versions%ROWTYPE;
 witnessed_scopes jsonb:='[]'; earliest timestamptz; at_time timestamptz; t public.tournaments%ROWTYPE;
 game_union uuid; total_cents bigint; remainder_cents bigint; credit numeric; allocated numeric:=0;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original fee missing'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text,0));
 IF public.fn_accounting_mixed_cutover_spin_proof_valid(r.id) THEN
  RETURN jsonb_build_object('status','proven_original_mixed_cutover','rake_record_id',r.id,'replayed',true,'payable',false);
 END IF;
 SELECT * INTO b FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'legacy_unverified' OR b.source_manifest IS NOT NULL
  OR b.source_version<>2 OR b.tournament_id IS DISTINCT FROM r.tournament_id
  OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
  OR b.rake_amount IS DISTINCT FROM r.rake_amount OR cutoff IS NULL OR NOT isfinite(cutoff)
  OR r.created_at<cutoff OR NOT isfinite(r.created_at) OR r.created_at>clock_timestamp()
  OR r.source IS DISTINCT FROM 'fn_spin_book_entry' OR r.metadata->>'kind' IS DISTINCT FROM 'spin_rake'
  OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL OR r.hand_id IS NOT NULL
  OR r.rake_amount IS NULL OR r.rake_amount<=0 OR r.rake_amount<>round(r.rake_amount,2)
  OR r.rake_amount::text IN('NaN','Infinity','-Infinity')
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE rake_record_id=r.id)
  OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=r.tournament_id)
 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original batch eligibility failed'; END IF;
 IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3 THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin exact three paid contributors required'; END IF;
 FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
  SELECT count(*) INTO n FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=item.player_id;
  IF n<>1 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original registration ambiguous'; END IF;
  SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=item.player_id;
  SELECT count(*) INTO n FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
    AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
  IF n<>1 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original charge ambiguous'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
    AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
  SELECT * INTO l FROM public.chip_ledger WHERE id=e.source_ledger_id;
  IF l.id IS NULL OR tp.club_id IS NULL OR e.refund_wallet_club_id IS DISTINCT FROM tp.club_id
   OR e.created_at IS NULL OR NOT isfinite(e.created_at) OR e.created_at>r.created_at
   OR item.weight IS NULL OR item.weight<=0 OR item.weight<>round(item.weight,2)
   OR item.weight::text IN('NaN','Infinity','-Infinity') OR l.amount IS DISTINCT FROM e.gross
   OR l.created_at IS DISTINCT FROM e.created_at OR l.from_type IS DISTINCT FROM 'player_wallet'
   OR l.from_entity_id IS DISTINCT FROM item.player_id OR l.to_type IS DISTINCT FROM 'prize_liability'
   OR l.to_entity_id IS DISTINCT FROM r.tournament_id OR l.tournament_id IS DISTINCT FROM r.tournament_id
   OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id OR l.category IS DISTINCT FROM 'tournament_buyin'
   OR l.status IS DISTINCT FROM 'posted'
  THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original debit identity mismatch'; END IF;
  IF e.created_at<cutoff THEN early:=early+1; END IF;
  total_weight:=total_weight+item.weight;
  contributors:=contributors||jsonb_build_array(jsonb_build_object('player_id',item.player_id,'club_id',e.refund_wallet_club_id,
   'registration_id',tp.id,'charge_ledger_id',l.id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',item.weight));
  evidence:=evidence||jsonb_build_array(jsonb_build_object('registration',jsonb_build_object('id',tp.id,'tournament_id',tp.tournament_id,
   'user_id',tp.user_id,'club_id',tp.club_id,'registered_at',tp.registered_at),'entitlement',to_jsonb(e),'ledger',to_jsonb(l)));
 END LOOP;
 IF early NOT IN(1,2) OR (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(contributors)x)<>1 THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin charge cutoff or equal original entries unproven'; END IF;
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=r.tournament_id AND kind='contribution';
 IF n<>1 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original reserve ambiguous'; END IF;
 SELECT * INTO reserve FROM public.spin_reserve_ledger WHERE tournament_id=r.tournament_id AND kind='contribution';
 IF reserve.seats IS DISTINCT FROM 3 OR reserve.house_rake IS DISTINCT FROM r.rake_amount
  OR reserve.amount IS DISTINCT FROM total_weight-r.rake_amount OR reserve.buy_in IS DISTINCT FROM total_weight/3
  OR reserve.created_at IS DISTINCT FROM r.created_at OR reserve.club_id::text IS DISTINCT FROM r.metadata->>'reserve_owner'
 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original reserve mismatch'; END IF;
 -- Original published contracts witness the economic scope. The actual chip
 -- debit above establishes the asset; today's editable scope cannot do so.
 SELECT min((x->>'charged_at')::timestamptz) INTO earliest FROM jsonb_array_elements(contributors)x;
 SELECT * INTO original_scope FROM public.managed_game_contract_versions
  WHERE game_kind='tournament' AND game_id=r.tournament_id AND version=1 AND change_reason='created';
 IF NOT FOUND OR original_scope.published_at>earliest OR NOT isfinite(original_scope.published_at)
  OR original_scope.club_id IS DISTINCT FROM r.club_id
  OR original_scope.contract->>'id' IS DISTINCT FROM r.tournament_id::text
  OR original_scope.contract->>'club_id' IS DISTINCT FROM original_scope.club_id::text
  OR NULLIF(original_scope.contract->>'union_id','')::uuid IS DISTINCT FROM original_scope.union_id
  OR original_scope.contract->'is_private' IS DISTINCT FROM 'false'::jsonb
  OR original_scope.contract->>'tournament_type' IS DISTINCT FROM 'SPIN'
  OR original_scope.contract->>'variant' IS DISTINCT FROM 'spin'
  OR (original_scope.contract->>'buy_in_amount')::numeric IS DISTINCT FROM total_weight/3
  OR (original_scope.contract->>'max_players')::integer IS DISTINCT FROM 3
  OR original_scope.contract_hash IS DISTINCT FROM public.fn_managed_game_contract_hash(original_scope.contract)
 THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original created scope unproven'; END IF;
 scope:=jsonb_build_object('club_id',original_scope.club_id,'union_id',original_scope.union_id,'is_private',false,
  'game_type','spin','asset','chips','created_contract',to_jsonb(original_scope));
 -- Refuse any contradictory observed revision through original fee creation.
 FOR v_scope IN SELECT * FROM public.managed_game_contract_versions
  WHERE game_kind='tournament' AND game_id=r.tournament_id AND published_at<=r.created_at ORDER BY version LOOP
  IF v_scope.published_at<original_scope.published_at OR NOT isfinite(v_scope.published_at)
   OR v_scope.club_id IS DISTINCT FROM original_scope.club_id OR v_scope.union_id IS DISTINCT FROM original_scope.union_id
   OR v_scope.contract->>'id' IS DISTINCT FROM r.tournament_id::text
   OR v_scope.contract->>'club_id' IS DISTINCT FROM v_scope.club_id::text
   OR NULLIF(v_scope.contract->>'union_id','')::uuid IS DISTINCT FROM v_scope.union_id
   OR v_scope.contract->'is_private' IS DISTINCT FROM 'false'::jsonb
   OR v_scope.contract->>'tournament_type' IS DISTINCT FROM 'SPIN' OR v_scope.contract->>'variant' IS DISTINCT FROM 'spin'
   OR (v_scope.contract->>'buy_in_amount')::numeric IS DISTINCT FROM total_weight/3
   OR (v_scope.contract->>'max_players')::integer IS DISTINCT FROM 3
   OR v_scope.contract_hash IS DISTINCT FROM public.fn_managed_game_contract_hash(v_scope.contract)
  THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin original scope revision disagrees'; END IF;
 END LOOP;
 FOR at_time IN SELECT (x->>'charged_at')::timestamptz FROM jsonb_array_elements(contributors)x UNION SELECT r.created_at LOOP
  SELECT * INTO v_scope FROM public.managed_game_contract_versions
   WHERE game_kind='tournament' AND game_id=r.tournament_id AND published_at<=at_time
   ORDER BY published_at DESC,version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin earning-time game scope missing'; END IF;
  witnessed_scopes:=witnessed_scopes||jsonb_build_array(jsonb_build_object('at',at_time,'version',to_jsonb(v_scope)));
 END LOOP;
 scope:=scope||jsonb_build_object('earning_time_contracts',witnessed_scopes);
 -- Original settlement still owns the current destination. Refuse drift from
 -- witnessed scope instead of rewriting or choosing a different payer.
 SELECT * INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR t.club_id IS DISTINCT FROM original_scope.club_id OR t.union_id IS DISTINCT FROM original_scope.union_id
  OR t.is_private IS DISTINCT FROM false OR t.tournament_type IS DISTINCT FROM 'SPIN'
  OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000',DETAIL='mixed Spin current settlement scope contradicts original'; END IF;
 game_union:=NULLIF(scope->>'union_id','')::uuid;
 manifest:=jsonb_build_object('union_id',game_union,'game_type','spin','contributors',contributors,'spin_reserve_id',reserve.id);
 total_cents:=(r.rake_amount*100)::bigint;
 SELECT total_cents-sum(floor(total_cents*(x->>'weight')::numeric/total_weight)) INTO remainder_cents FROM jsonb_array_elements(contributors)x;
 FOR plan IN SELECT x,floor(total_cents*(x->>'weight')::numeric/total_weight)
   +CASE WHEN row_number() OVER(ORDER BY total_cents*(x->>'weight')::numeric/total_weight
     -floor(total_cents*(x->>'weight')::numeric/total_weight) DESC,x->>'player_id')<=remainder_cents THEN 1 ELSE 0 END cents
  FROM jsonb_array_elements(contributors)x ORDER BY x->>'player_id' LOOP
  credit:=plan.cents/100.0;
  contract:=public.fn_accounting_earning_contract((plan.x->>'club_id')::uuid,(plan.x->>'player_id')::uuid,credit,game_union,(plan.x->>'charged_at')::timestamptz);
  IF contract->>'player_id' IS DISTINCT FROM plan.x->>'player_id' OR contract->>'club_id' IS DISTINCT FROM plan.x->>'club_id'
   OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM game_union
   OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (plan.x->>'charged_at')::timestamptz THEN
   RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,coordinator_union_id,
   game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
  VALUES(r.id,r.tournament_id,(plan.x->>'player_id')::uuid,(plan.x->>'club_id')::uuid,game_union,
   NULLIF(contract->>'coordinator_union_id','')::uuid,'spin',(plan.x->>'registration_id')::uuid,
   (plan.x->>'charge_ledger_id')::uuid,(plan.x->>'entitlement_id')::uuid,(plan.x->>'charged_at')::timestamptz,credit,contract);
  allocated:=allocated+credit;
 END LOOP;
 IF allocated IS DISTINCT FROM r.rake_amount THEN RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
 INSERT INTO public.accounting_mixed_cutover_spin_fee_proofs(rake_record_id,tournament_id,cutover_at,original_batch,
  source_manifest,original_evidence,canonical_sources)
 SELECT r.id,r.tournament_id,cutoff,to_jsonb(b),manifest,
  jsonb_build_object('charges',evidence,'reserve',to_jsonb(reserve),'scope',scope),
  jsonb_agg(to_jsonb(s) ORDER BY s.player_id) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id;
 IF NOT public.fn_accounting_mixed_cutover_spin_proof_valid(r.id) THEN RAISE EXCEPTION 'mixed_spin_proof_not_conserved' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('status','proven_original_mixed_cutover','rake_record_id',r.id,'replayed',false,'payable',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_accounting_qualify_mixed_cutover_spin_fee(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
   WHERE r.id=ANY(positive_ids) AND ((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(b.rake_record_id)) OR b.tournament_id IS DISTINCT FROM p_tournament_id
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
END $function$
;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) FROM PUBLIC,anon,authenticated,service_role;

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
  -- Qualify only this owning close's complete original mixed-cutover Spin
  -- receipts. The original batch remains unchanged; any failure below rolls
  -- proof, source rows, claim, bank transfer and recognition back together.
  FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament AND r.rake_amount>0
    AND r.source='fn_spin_book_entry' AND r.created_at>=c.starts_at
    AND b.status='legacy_unverified' AND b.source_manifest IS NULL ORDER BY r.id LOOP
   PERFORM public.fn_accounting_qualify_mixed_cutover_spin_fee(v_raw.id);
  END LOOP;
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
  IF v_att->>'status' IS DISTINCT FROM (CASE WHEN v_net>0 THEN 'recognized' ELSE 'cancelled' END)
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
$function$
;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text) TO service_role;

COMMIT;
