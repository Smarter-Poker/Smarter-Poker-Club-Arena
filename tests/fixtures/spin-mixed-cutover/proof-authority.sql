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
