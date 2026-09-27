BEGIN; SET LOCAL timezone='UTC'; SET LOCAL search_path=public,extensions,pg_temp; SET LOCAL check_function_bodies=off;
DO $$ BEGIN IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$' OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>'' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_ISOLATION_REQUIRED'; END IF; END $$;
CREATE TABLE public.accounting_tournament_fee_custody_resolutions("tournament_id" uuid NOT NULL,"obligation_id" uuid NOT NULL,"amount" numeric NOT NULL,"source_fingerprint" text NOT NULL,"original_plan" jsonb NOT NULL,"resolved_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,"transaction_id" bigint DEFAULT txid_current() NOT NULL);
ALTER TABLE public.accounting_tournament_fee_custody_resolutions OWNER TO postgres; ALTER TABLE public.accounting_tournament_fee_custody_resolutions ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.accounting_tournament_fee_custody_resolutions FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT "accounting_tournament_fee_custody_reso_source_fingerprint_check" CHECK ((source_fingerprint ~ '^[0-9a-f]{32}$'::text));
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT "accounting_tournament_fee_custody_resolutio_original_plan_check" CHECK ((jsonb_typeof(original_plan) = 'object'::text));
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT "accounting_tournament_fee_custody_resolutions_amount_check" CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2))));
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT "accounting_tournament_fee_custody_resolutions_obligation_id_key" UNIQUE (obligation_id);
ALTER TABLE public.accounting_tournament_fee_custody_resolutions ADD CONSTRAINT "accounting_tournament_fee_custody_resolutions_pkey" PRIMARY KEY (tournament_id);
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(p_table text, p_operation text, p_old jsonb, p_new jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t uuid:=NULLIF(p_new->>'tournament_id','')::uuid;r public.accounting_tournament_fee_custody_resolutions%ROWTYPE;
 o public.accounting_tournament_fee_custody_obligations%ROWTYPE;h public.tournament_terminal_settlements%ROWTYPE;
BEGIN
 -- The installed Union wallet autoledger identifies its source by the typed
 -- original prize liability and deliberately leaves tournament_id NULL.
 IF t IS NULL AND p_table='chip_ledger' AND p_operation='INSERT'
  AND p_new->>'from_type'='prize_liability'
  AND public.fn_ca_sep8_spin_original_fee_proof(NULLIF(p_new->>'from_entity_id','')::uuid) IS NOT NULL THEN
  t:=NULLIF(p_new->>'from_entity_id','')::uuid;
 END IF;
 IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;
 SELECT * INTO r FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=t AND transaction_id=txid_current();
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE id=r.obligation_id AND tournament_id=t;
 SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=t AND accounting_state='fee_custody_unresolved' AND receipt_version=3;
 IF o.id IS NULL OR h.tournament_id IS NULL OR r.amount IS DISTINCT FROM o.amount
  OR r.source_fingerprint IS DISTINCT FROM o.source_fingerprint
  OR r.original_plan IS DISTINCT FROM public.fn_accounting_tournament_fee_net_plan(t)
 THEN RETURN false; END IF;
 IF p_table='tournament_rake_settlements' THEN
  IF p_operation='INSERT' THEN
   RETURN (p_new->>'amount')::numeric=0 AND p_new->>'destination'='pending'
    AND p_new->>'settled_at' IS NULL AND p_new->>'attributed_at' IS NULL
    AND p_new->>'terminal_closed_at' IS NULL;
  END IF;
  RETURN p_operation='UPDATE' AND p_old->>'terminal_closed_at' IS NULL
   AND (p_old-ARRAY['amount','union_id','destination','settled_at','attributed_at','attributed_users','attribution_error'])
    IS NOT DISTINCT FROM (p_new-ARRAY['amount','union_id','destination','settled_at','attributed_at','attributed_users','attribution_error'])
   AND p_old->>'destination'='pending' AND (p_old->>'amount')::numeric=0
   AND (p_new->>'amount')::numeric=r.amount
   AND (p_new->>'settled_at')::timestamptz=r.resolved_at
   AND (p_new->>'attributed_at')::timestamptz=r.resolved_at
   AND (p_new->>'attributed_users')::integer>0
   AND p_new->>'attribution_error' IS NULL
   AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions q WHERE q.tournament_id=t
    AND q.status='recognized' AND q.net_rake=r.amount AND q.recognized_at=r.resolved_at
    AND q.source_fingerprint=r.source_fingerprint);
 ELSIF p_table='chip_ledger' THEN
  IF p_operation='INSERT' AND r.original_plan->>'union_id' IS NOT NULL
   AND public.fn_ca_sep8_spin_original_fee_proof(t) IS NOT NULL THEN
   RETURN p_new->>'from_type'='prize_liability' AND p_new->>'from_entity_id'=t::text
    AND (p_new->>'tournament_id' IS NULL OR p_new->>'tournament_id'=t::text)
    AND p_new->>'to_type'='union_wallet' AND p_new->>'to_label'='union_wallets.rake_wallet'
    AND p_new->>'union_id'=r.original_plan->>'union_id' AND p_new->>'category'='rake'
    AND (p_new->>'amount')::numeric=r.amount
    AND p_new->>'description'='auto-ledgered union_wallets.rake_wallet delta '||round(r.amount,2)::text
    AND p_new->>'from_label' IS NULL AND p_new->>'club_id' IS NULL
    AND p_new->>'table_id' IS NULL AND p_new->>'hand_id' IS NULL
    AND p_new->>'idempotency_key' IS NULL AND p_new->>'metadata' IS NULL
    AND p_new->>'pre_from_balance' IS NULL AND p_new->>'post_from_balance' IS NULL
    AND p_new->>'status'='posted' AND (p_new->>'created_at')::timestamptz=r.resolved_at
    AND (p_new->>'performed_by')::uuid=COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
    AND (p_new->>'pre_to_balance')::numeric>=0
    AND (p_new->>'post_to_balance')::numeric-(p_new->>'pre_to_balance')::numeric=r.amount
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=(p_new->>'to_entity_id')::uuid
     AND w.union_id=(r.original_plan->>'union_id')::uuid
     AND w.rake_wallet=(p_new->>'post_to_balance')::numeric)
    AND EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=t
     AND s.destination='pending' AND s.amount=0 AND s.settled_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.from_type='prize_liability'
     AND l.from_entity_id=t AND l.to_type='union_wallet'
     AND (l.union_id=(r.original_plan->>'union_id')::uuid OR l.to_entity_id=(p_new->>'to_entity_id')::uuid));
  END IF;
  RETURN p_operation='INSERT' AND p_new->>'from_type'='prize_liability'
   AND p_new->>'from_entity_id'=t::text AND p_new->>'to_type'='chip_retirement'
   AND p_new->>'to_entity_id' IS NULL AND p_new->>'category'='burn'
   AND (p_new->>'amount')::numeric=r.amount AND r.original_plan->>'union_id' IS NULL
   AND p_new->>'description'='Standalone tournament fee retired (fn_settle_tournament_rake)';
 ELSIF p_table='tournament_escrow' THEN
  RETURN p_operation='UPDATE' AND (p_old->>'terminal_closed_at')::timestamptz=h.completed_at
   AND (p_old-ARRAY['fee_out','fee_balance','updated_at']) IS NOT DISTINCT FROM
       (p_new-ARRAY['fee_out','fee_balance','updated_at'])
   AND (p_old->>'prize_balance')::numeric=0 AND (p_old->>'bounty_balance')::numeric=0
   AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions q WHERE q.tournament_id=t
    AND q.status='recognized' AND q.net_rake=r.amount AND q.recognized_at=r.resolved_at
    AND q.source_fingerprint=r.source_fingerprint)
   AND (((p_old->>'fee_out')::numeric=(o.escrow_snapshot->>'fee_out')::numeric
      AND (p_new->>'fee_out')::numeric=(p_old->>'fee_out')::numeric+r.amount
      AND (p_old->>'fee_balance')::numeric=r.amount AND (p_new->>'fee_balance')::numeric=r.amount)
    OR ((p_old->>'fee_out')::numeric=(o.escrow_snapshot->>'fee_out')::numeric+r.amount
      AND (p_new->>'fee_out')::numeric=(p_old->>'fee_out')::numeric
      AND (p_old->>'fee_balance')::numeric=r.amount AND (p_new->>'fee_balance')::numeric=0));
 END IF;
 RETURN false;
END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb) TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)'::regprocedure)) IS DISTINCT FROM '54ca630d2363a5ac17041d79931e301c' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
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
END $function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_accounting_tournament_fee_net_plan(uuid)'::regprocedure)) IS DISTINCT FROM '9b1147a5b373e2a01e3374b8dd2cc2fa' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'original fee custody obligations are append-only' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_legacy_fee_custody_is_append_only()'::regprocedure)) IS DISTINCT FROM '4bc1c11e22a8ee54c63c36782b642831' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE receipt jsonb;h public.tournament_terminal_settlements%ROWTYPE;
BEGIN
 receipt:=public.fn_accounting_tournament_terminal_fee_receipt(NEW.tournament_id);
 SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=NEW.tournament_id;
 IF receipt->>'status' IS DISTINCT FROM 'recognized'
  OR receipt->>'source_fingerprint' IS DISTINCT FROM NEW.source_fingerprint
  OR (receipt->>'bank_amount')::numeric IS DISTINCT FROM NEW.amount
  OR (receipt->>'banked_at')::timestamptz IS DISTINCT FROM NEW.resolved_at
  OR NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=NEW.tournament_id
   AND s.amount=NEW.amount AND s.settled_at=NEW.resolved_at AND s.attributed_at=NEW.resolved_at
   AND s.attributed_users>0 AND s.attribution_error IS NULL AND s.terminal_closed_at=h.completed_at)
  OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=NEW.tournament_id
   AND e.prize_balance=0 AND e.bounty_balance=0 AND e.fee_balance=0)
 THEN RAISE EXCEPTION 'fee continuation cannot commit without exact original attribution and bank proof' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_tournament_terminal_receipt(NEW.tournament_id,NULL);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_fee_resolution_requires_recognition() TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_legacy_fee_resolution_requires_recognition()'::regprocedure)) IS DISTINCT FROM '5cacfa2b62b7ecbea69725a8486ae635' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record;r public.rake_records%ROWTYPE;t public.tournaments%ROWTYPE;
 v public.managed_game_contract_versions%ROWTYPE;tp record;e record;l record;s record;
 item record;n integer;gross numeric:=0;earliest timestamptz;rows jsonb:='[]';versions jsonb:='[]';
 reserve jsonb;game_union uuid;reserve_account uuid;
BEGIN
 IF p_tournament_id NOT IN (
 '199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,'808ef798-0942-4ce0-9ae1-eeefaaf4b0a9',
 'b60c7add-6b38-4549-b091-601f64d118a0','e3f4e2ab-8397-43e8-8643-6cec3fff3a63',
 'f3f050f1-569e-4fb6-859f-86b6092e682e') THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id);
 SELECT count(*) INTO n FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 SELECT * INTO r FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id;
 IF n<>1 OR c.source_count IS DISTINCT FROM 1 OR r.source IS DISTINCT FROM 'fn_spin_book_entry'
  OR r.rake_amount IS DISTINCT FROM c.amount OR md5(public.fn_accounting_tournament_fee_fingerprint(r)) IS DISTINCT FROM c.source_fingerprint
  OR r.created_at>='2026-09-17T18:24:02.831517Z'::timestamptz OR r.hand_id IS NOT NULL
  OR r.metadata->>'kind' IS DISTINCT FROM 'spin_rake' OR jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
  OR t.is_private IS DISTINCT FROM false OR t.variant IS DISTINCT FROM 'spin' OR t.tournament_type IS DISTINCT FROM 'SPIN'
  OR public.fn_poker_diamond_tournament(p_tournament_id)
 THEN RAISE EXCEPTION 'named Spin original aggregate identity missing' USING ERRCODE='P0404'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>3
  OR (SELECT count(DISTINCT value::numeric) FROM jsonb_each_text(r.player_contributions))<>1
 THEN RAISE EXCEPTION 'named Spin requires exactly three equal original paid contributors' USING ERRCODE='P0404'; END IF;
 FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
  SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=p_tournament_id AND user_id=item.player_id;
  SELECT count(*) INTO n FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id
   AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge' AND x.charge_category='tournament_buyin'
   AND x.created_at=tp.registered_at AND x.gross=item.weight;
  IF n<>1 THEN RAISE EXCEPTION 'named Spin original paid entry ambiguous' USING ERRCODE='P0404'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x WHERE x.tournament_id=p_tournament_id
   AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge' AND x.charge_category='tournament_buyin'
   AND x.created_at=tp.registered_at AND x.gross=item.weight;
  SELECT * INTO l FROM public.chip_ledger WHERE id=e.source_ledger_id;
  IF l.id IS NULL OR tp.club_id IS DISTINCT FROM e.refund_wallet_club_id OR l.created_at IS DISTINCT FROM e.created_at
   OR e.created_at>r.created_at OR l.amount IS DISTINCT FROM e.gross OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
   OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM item.player_id
   OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM p_tournament_id
   OR l.category IS DISTINCT FROM 'tournament_buyin' OR item.weight<=0
  THEN RAISE EXCEPTION 'named Spin original debit evidence disagrees' USING ERRCODE='P0404'; END IF;
  earliest:=least(earliest,e.created_at);gross:=gross+item.weight;
  rows:=rows||jsonb_build_array(jsonb_build_object('registration_id',tp.id,'player_id',item.player_id,
   'club_id',tp.club_id,'registered_at',tp.registered_at,'entitlement',to_jsonb(e)-'terminal_closed_at','ledger',to_jsonb(l)));
 END LOOP;
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='contribution';
 SELECT * INTO s FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='contribution';
 IF n<>1 OR s.seats IS DISTINCT FROM 3 OR s.house_rake IS DISTINCT FROM r.rake_amount
  OR s.amount IS DISTINCT FROM gross-r.rake_amount OR s.buy_in IS DISTINCT FROM gross/3
 THEN RAISE EXCEPTION 'named Spin original reserve contribution disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=jsonb_build_object('contribution',to_jsonb(s)-'terminal_closed_at');
 SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_entry';
 SELECT * INTO l FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_entry';
 IF n<>1 OR l.amount IS DISTINCT FROM s.amount OR l.created_at IS DISTINCT FROM s.created_at
  OR l.club_id IS DISTINCT FROM s.club_id OR l.from_type IS DISTINCT FROM 'prize_liability'
  OR l.from_entity_id IS DISTINCT FROM p_tournament_id OR l.to_type IS DISTINCT FROM 'spin_reserve' OR l.to_entity_id IS NULL
 THEN RAISE EXCEPTION 'named Spin reserve contribution debit disagrees' USING ERRCODE='P0404'; END IF;
 reserve_account:=l.to_entity_id;reserve:=reserve||jsonb_build_object('contribution_ledger',to_jsonb(l));
 SELECT count(*) INTO n FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='jackpot_draw';
 SELECT * INTO s FROM public.spin_reserve_ledger WHERE tournament_id=p_tournament_id AND kind='jackpot_draw';
 IF n<>1 OR s.seats IS DISTINCT FROM 3 OR s.house_rake IS DISTINCT FROM r.rake_amount
  OR s.amount IS DISTINCT FROM -t.prize_pool OR s.buy_in IS DISTINCT FROM gross/3 OR s.amount>=0
 THEN RAISE EXCEPTION 'named Spin original prize draw disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=reserve||jsonb_build_object('draw',to_jsonb(s)-'terminal_closed_at');
 SELECT count(*) INTO n FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_prize';
 SELECT * INTO l FROM public.chip_ledger x WHERE x.tournament_id=p_tournament_id AND x.category='spin_prize';
 IF n<>1 OR l.amount IS DISTINCT FROM -s.amount OR l.created_at IS DISTINCT FROM s.created_at
  OR l.club_id IS DISTINCT FROM s.club_id OR l.from_type IS DISTINCT FROM 'spin_reserve'
  OR l.from_entity_id IS DISTINCT FROM reserve_account OR l.to_type IS DISTINCT FROM 'prize_liability'
  OR l.to_entity_id IS DISTINCT FROM p_tournament_id
 THEN RAISE EXCEPTION 'named Spin original prize draw credit disagrees' USING ERRCODE='P0404'; END IF;
 reserve:=reserve||jsonb_build_object('draw_ledger',to_jsonb(l));
 SELECT * INTO v FROM public.managed_game_contract_versions WHERE game_id=p_tournament_id AND game_kind='tournament' AND version=1;
 IF NOT FOUND OR v.published_at>earliest OR v.club_id IS DISTINCT FROM r.club_id
  OR v.club_id IS DISTINCT FROM t.club_id OR v.union_id IS DISTINCT FROM t.union_id
 THEN RAISE EXCEPTION 'named Spin original created scope missing' USING ERRCODE='P0404'; END IF;
 game_union:=v.union_id;
 FOR v IN SELECT * FROM public.managed_game_contract_versions WHERE game_id=p_tournament_id AND game_kind='tournament'
  AND published_at<=r.created_at ORDER BY version,id LOOP
  IF v.club_id IS DISTINCT FROM t.club_id OR v.union_id IS DISTINCT FROM game_union
   OR v.contract->>'id' IS DISTINCT FROM p_tournament_id::text OR v.contract->>'club_id' IS DISTINCT FROM v.club_id::text
   OR NULLIF(v.contract->>'union_id','')::uuid IS DISTINCT FROM game_union OR v.contract->'is_private' IS DISTINCT FROM 'false'::jsonb
   OR v.contract->>'variant' IS DISTINCT FROM 'spin' OR v.contract->>'tournament_type' IS DISTINCT FROM 'SPIN'
   OR (v.contract->>'buy_in_amount')::numeric IS DISTINCT FROM gross/3 OR (v.contract->>'max_players')::integer IS DISTINCT FROM 3
   OR v.contract_hash IS DISTINCT FROM public.fn_managed_game_contract_hash(v.contract)
  THEN RAISE EXCEPTION 'named Spin immutable economic scope disagrees' USING ERRCODE='P0404'; END IF;
  versions:=versions||jsonb_build_array(to_jsonb(v));
 END LOOP;
 RETURN jsonb_build_object('tournament_id',p_tournament_id,'raw_source_count',1,'recognized_contributors',3,
  'source_fingerprint',c.source_fingerprint,'fee',c.amount,'gross',gross,'contributors',rows,'reserve',reserve,'scope_versions',versions);
END $function$;
ALTER FUNCTION public.fn_ca_sep8_spin_original_fee_proof(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_sep8_spin_original_fee_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_sep8_spin_original_fee_proof(uuid) TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_sep8_spin_original_fee_proof(uuid)'::regprocedure)) IS DISTINCT FROM '3224402eb784a60fbbc129135df632fb' THEN RAISE EXCEPTION 'FEE_GUARD_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
CREATE TRIGGER legacy_fee_resolution_is_append_only BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_custody_resolutions FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE TRIGGER legacy_fee_resolution_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_custody_resolutions FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE CONSTRAINT TRIGGER legacy_fee_resolution_requires_recognition AFTER INSERT ON public.accounting_tournament_fee_custody_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_resolution_requires_recognition();
COMMIT;
