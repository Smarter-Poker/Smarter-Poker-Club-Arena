-- Fixed original69 NONPAYING qualification only. No new payer or generic SQL.
-- Canonical settlement is unchanged and every execution ends in an uncaught
-- exception, rolling back its complete transaction. Execution belongs to the
-- original operation owner, after sealed healthy own thaw and exact quiescence.
BEGIN;
SET LOCAL lock_timeout='1s';
CREATE FUNCTION smarter_private.original69_probe_member(p_tournament_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT coalesce(p_tournament_id=ANY(ARRAY['0d98f87e-65bb-483c-b34d-0cc6af4a4e29'::uuid,'10146b16-aaac-4606-a2aa-7bbc3863b750'::uuid,'112ea67a-3885-4755-84cc-5f8523d3f82c'::uuid,'120ffb44-a3e6-4691-a52c-450768a09056'::uuid,'1294ab27-2191-484c-aa3e-98192de09e44'::uuid,'15202cb0-648c-4583-a6f9-9512a6e678c6'::uuid,'19349646-5d29-4e79-a65d-c01be5c0a7e6'::uuid,'197ed0bd-8fdb-4897-b001-dfe902139f9c'::uuid,'26ebb662-63bf-4bc5-9ac8-962bc5ad8849'::uuid,'2781bcd7-cc8a-4713-ab3e-0d0a81fdf110'::uuid,'27b49998-863d-44f7-8f11-f38d4de476b8'::uuid,'30bac12f-028e-4d05-841a-9c900c779850'::uuid,'369d46bd-1eba-44bf-a80f-fb19ec980614'::uuid,'3859e739-513e-4ed5-af23-5a190aa40f46'::uuid,'4163a647-780e-4a5e-910f-ccc0fe5cf218'::uuid,'45072749-ed7a-4e27-9891-f21cdd44a20a'::uuid,'4b7f3840-cc55-49b7-acd0-57216a89d044'::uuid,'4d88fc8c-a6d7-4e93-8cb6-ac45acb4e35d'::uuid,'4dfe400c-c942-41df-9e6b-bbd8336c9cf7'::uuid,'4e2cc712-8773-4d00-8927-6319153bddf4'::uuid,'551125c0-4129-4f28-b174-caedb576cd99'::uuid,'5638ff13-7d12-4a54-b784-4f309792db60'::uuid,'5a3e686c-8a9e-4c7c-b2c3-829c6a1ce096'::uuid,'5ef9868a-03d3-4d3b-bc92-41c63bd8b10c'::uuid,'6379b29e-1307-4e8b-91e7-e9a0975cd64d'::uuid,'6429087f-a9d1-49a3-b7cf-85e1ee283ac9'::uuid,'68af0f95-82f5-4047-b424-6780a4236f4d'::uuid,'6acde8fb-5631-4320-965d-bf9dbf01c4d8'::uuid,'6d047305-e5ac-4200-803f-399c83cf76f3'::uuid,'6f25fd3f-b96a-40be-b32b-e9f8a39c22e8'::uuid,'768cb55b-e915-4a01-9c74-f97535f700a3'::uuid,'7850aedc-640b-4905-b9e1-61d75d9543d0'::uuid,'78ed8458-4ffd-416a-a8fd-d0f0c5e3509e'::uuid,'7986217a-0a67-4585-bd43-254356a9cb54'::uuid,'7de6c45c-ac37-4c32-a22a-4faea11d6cfa'::uuid,'80861496-ee6c-498e-bae4-4d6acd8381c2'::uuid,'8aae8210-0444-455f-97f6-19a3a072eda0'::uuid,'8d8a5ecf-29c6-49e7-82fa-3109b6681fb6'::uuid,'90fc40a9-0f76-4835-a1e9-5c487f32b2c8'::uuid,'928dc47d-14b8-4721-9990-a5ccfd57a41e'::uuid,'94beb183-6b2a-4dbf-b1ea-556bf9681124'::uuid,'95760eed-827d-4502-8be6-cfb8ec610e1b'::uuid,'962cb5ce-3255-4ac3-9672-769752b4d169'::uuid,'9b0e7b08-17ad-46ad-be00-9745f788cdd3'::uuid,'9b23a2ec-d514-457f-ac61-fc80722068ad'::uuid,'a3e9d95e-9f0a-4b6b-9652-f6c697baadac'::uuid,'b2870f16-db00-4820-a2d7-b5fc76e627ab'::uuid,'b6435b76-7225-4d40-87fe-52f3a9d4521e'::uuid,'b67b1975-f8cb-417b-87f9-9910c8290178'::uuid,'b8484257-68b3-4961-aad3-4b096bb7c7b5'::uuid,'bab7002d-4e6c-4845-a6e0-af16a35a70cc'::uuid,'be27c5a4-8282-4dd1-8881-fe1145a94b5e'::uuid,'bed32f92-c2e5-485e-aa90-5ff62bdfd325'::uuid,'bf050b4a-afd3-43d4-82f4-5eab0983d490'::uuid,'bfad9be3-52f8-4f08-863b-cb8790ab4b75'::uuid,'c2835ddc-d3b6-4b91-9e1b-895028435b3c'::uuid,'c48b7118-a0e5-4b33-98df-79dcf29f15af'::uuid,'cc73fe07-8ab2-4282-9ba6-633563de2fec'::uuid,'d4fe7c06-14eb-4ded-a2fd-07a57559f2dd'::uuid,'d8b96746-98a8-444f-a779-76904bbca946'::uuid,'dcffef19-4c19-4c5a-b433-d043d3641bc9'::uuid,'e507f99a-fc33-45f7-9f7a-60f2793d3876'::uuid,'e9e505d4-13ed-48ee-b7bf-1bdbb28cc8f2'::uuid,'eb916895-36f9-49e9-a364-486ad4555744'::uuid,'ef75f627-1f29-4729-97cd-9988495b49f1'::uuid,'f55d1faf-380b-4aeb-a0bf-e0151531dab5'::uuid,'fac51189-3bcc-4bd6-b5b5-34316c034edb'::uuid,'fcb7f99f-b43e-4043-88ad-4ed13c17d40a'::uuid,'fe9145bb-acc1-4a51-97d1-e473d3c39c6e'::uuid]),false);
$fn$;
REVOKE ALL ON FUNCTION smarter_private.original69_probe_member(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- PRIVATE projection of stored original charge components. This neither computes
-- a payout nor writes money. The posted projection reads actual canonical tranches
-- or refund ledgers by the canonical receipt's keys. Generated IDs/times are never
-- part of the stable economics; original immutable charge/entitlement IDs are.
CREATE FUNCTION smarter_private.original69_probe_economics(p_tournament_id uuid,p_receipt jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE result jsonb;
BEGIN
 IF NOT smarter_private.original69_probe_member(p_tournament_id) THEN RAISE EXCEPTION 'original69_scope_required' USING ERRCODE='22023';END IF;
 IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
  IF p_receipt IS NULL THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',c.user_id,'source_charge_id',c.id,'source_entitlement_id',NULL,'wallet_club_id',NULL,
    'amount',c.amount::numeric::text,'prize',c.prize_part::numeric::text,'bounty',c.bounty_part::numeric::text,'fee',c.fee_part::numeric::text) ORDER BY c.user_id,c.id),'[]') INTO result
   FROM public.poker_diamond_tournament_ledger c WHERE c.tournament_id=p_tournament_id AND c.kind IN('entry','rebuy','reentry','addon')
   AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger r WHERE r.custody_id=c.custody_id AND r.kind='refund'
    AND coalesce(r.request->>'abort_operation_id','')<>'d44c4440-2911-430c-8ee7-376611ef3f38');
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',r.user_id,'source_charge_id',c.id,'source_entitlement_id',NULL,'wallet_club_id',NULL,
    'amount',r.amount::numeric::text,'prize',r.prize_part::numeric::text,'bounty',r.bounty_part::numeric::text,'fee',r.fee_part::numeric::text) ORDER BY r.user_id,c.id),'[]') INTO result
   FROM jsonb_array_elements(p_receipt->'financial'->'refunds') j
   JOIN public.poker_diamond_tournament_ledger r ON r.id=(j->>'ledger_id')::bigint AND r.tournament_id=p_tournament_id AND r.kind='refund'
   JOIN public.poker_diamond_tournament_ledger c ON c.id=(j->'charge_ledger_ids'->>0)::bigint AND c.tournament_id=p_tournament_id;
  END IF;
 ELSE
  IF p_receipt IS NULL THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',e.user_id,'source_charge_id',e.source_ledger_id,'source_entitlement_id',e.id,'wallet_club_id',e.refund_wallet_club_id,
    'amount',e.gross::numeric::text,'prize',e.refund_prize::numeric::text,'bounty',e.refund_bounty::numeric::text,'fee',e.refund_fee::numeric::text) ORDER BY e.user_id,e.id),'[]') INTO result
   FROM public.tournament_refund_entitlements e WHERE e.tournament_id=p_tournament_id AND e.entitlement_kind='wallet_charge'
    AND NOT EXISTS(SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=e.id);
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',tr.user_id,'source_charge_id',e.source_ledger_id,'source_entitlement_id',e.id,'wallet_club_id',tr.source_wallet_club_id,
    'amount',tr.amount_paid_now::numeric::text,'prize',tr.refund_prize::numeric::text,'bounty',tr.refund_bounty::numeric::text,'fee',tr.refund_fee::numeric::text) ORDER BY tr.user_id,e.id),'[]') INTO result
   FROM jsonb_array_elements(p_receipt->'financial'->'refunds') j
   JOIN public.tournament_refund_entitlements e ON e.id=(j->>'entitlement_id')::uuid AND e.tournament_id=p_tournament_id
   JOIN public.tournament_refund_tranches tr ON tr.entitlement_id=e.id AND tr.tournament_id=p_tournament_id;
  END IF;
 END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.original69_probe_economics(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.original69_probe_assert(p_operation_id uuid,p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'original69_service_required' USING ERRCODE='42501';END IF;
 IF p_operation_id IS DISTINCT FROM 'd44c4440-2911-430c-8ee7-376611ef3f38'::uuid OR NOT smarter_private.original69_probe_member(p_tournament_id)
 THEN RAISE EXCEPTION 'original69_scope_required' USING ERRCODE='22023';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM '32ffc8212bcbaec490b76fb904707d3c'
 THEN RAISE EXCEPTION 'original69_canonical_postimage_required' USING ERRCODE='55000';END IF;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.original69_probe_assert(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Event-scoped readback only. No global player-wallet balance or unrelated cash
-- activity participates. The original owner compares this before/after one probe.
CREATE FUNCTION public.fn_ca_original69_probe_state(p_operation_id uuid,p_tournament_id uuid,p_probe_xid text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE state_hash text;target_state text;outcome text;
BEGIN
 PERFORM smarter_private.original69_probe_assert(p_operation_id,p_tournament_id);
 IF p_probe_xid IS NOT NULL AND p_probe_xid !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'original69_xid_invalid' USING ERRCODE='22023';END IF;
 SELECT a.state INTO STRICT target_state FROM smarter_private.tournament_abort_targets a WHERE a.operation_id=p_operation_id AND a.tournament_id=p_tournament_id;
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'money',smarter_private.tournament_abort_money_snapshot(p_tournament_id),
 'target',(SELECT to_jsonb(a) FROM smarter_private.tournament_abort_targets a WHERE a.operation_id=p_operation_id AND a.tournament_id=p_tournament_id),
 'receipt',(SELECT to_jsonb(r) FROM public.tournament_cancellation_receipts r WHERE r.tournament_id=p_tournament_id),
 'refund_obligations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM public.tournament_obligations o WHERE o.tournament_id=p_tournament_id AND o.kind='refund'),
 'event_ledger',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id),
 'refund_keys',(SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY k.key),'[]') FROM public.wallet_credit_idempotency k
  WHERE k.key LIKE 'tourney:'||p_tournament_id||':refund-%' OR k.key LIKE 'poker-tournament-abort-refund:'||p_tournament_id||':charge:%')
 )::text,'UTF8')),'hex') INTO state_hash;
 IF p_probe_xid IS NOT NULL THEN outcome:=pg_xact_status(p_probe_xid::xid8);END IF;
 RETURN jsonb_build_object('schema','original69-probe-state/v1','operation_id',p_operation_id,'tournament_id',p_tournament_id,
  'state_sha256',state_hash,'target_state',target_state,'probe_xid_status',outcome);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_original69_probe_state(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_original69_probe_state(uuid,uuid,text) TO service_role;

CREATE FUNCTION public.fn_ca_probe_original69_abort(p_operation_id uuid,p_tournament_id uuid,p_expected_money_hash text,p_nonce text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE original jsonb;posted jsonb;receipt jsonb;replay jsonb;detail jsonb;fees numeric;total numeric;digest text;before_state jsonb;
BEGIN
 PERFORM smarter_private.original69_probe_assert(p_operation_id,p_tournament_id);
 IF p_expected_money_hash IS NULL OR p_expected_money_hash !~ '^[a-f0-9]{32}$' OR p_nonce IS NULL OR p_nonce !~ '^github-run-[0-9]{1,20}$'
 THEN RAISE EXCEPTION 'original69_typed_input_required' USING ERRCODE='22023';END IF;
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM 1 FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id AND state='quiesced' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'original69_quiesced_target_required' USING ERRCODE='55000';END IF;
 PERFORM smarter_private.assert_tournament_abort_quiesced(p_operation_id,p_tournament_id);
 before_state:=public.fn_ca_original69_probe_state(p_operation_id,p_tournament_id,NULL);
 original:=smarter_private.original69_probe_economics(p_tournament_id,NULL);
 SELECT coalesce(sum(rake_amount),0) INTO fees FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 receipt:=public.fn_ca_settle_tournament_abort(p_operation_id,p_tournament_id,p_expected_money_hash);
 IF receipt->>'fully_settled' IS DISTINCT FROM 'true' OR receipt->>'mode' IS DISTINCT FROM 'started_operator_abort'
  OR receipt->>'operation_id' IS DISTINCT FROM p_operation_id::text OR receipt->>'tournament_id' IS DISTINCT FROM p_tournament_id::text
  OR receipt->>'receipt_version' IS DISTINCT FROM '3' THEN RAISE EXCEPTION 'original69_canonical_receipt_invalid' USING ERRCODE='55000';END IF;
 posted:=smarter_private.original69_probe_economics(p_tournament_id,receipt);
 IF original IS DISTINCT FROM posted OR jsonb_array_length(posted) IS DISTINCT FROM (receipt->>'refund_line_count')::integer
 THEN RAISE EXCEPTION 'original69_original_economics_mismatch' USING ERRCODE='55000';END IF;
 SELECT coalesce(sum((j->>'amount')::numeric),0) INTO total FROM jsonb_array_elements(posted) j;
 IF total IS DISTINCT FROM (receipt->>'total_refunded')::numeric OR fees IS DISTINCT FROM (receipt->>'fees_reversed')::numeric
 THEN RAISE EXCEPTION 'original69_aggregate_mismatch' USING ERRCODE='55000';END IF;
 replay:=public.fn_ca_settle_tournament_abort(p_operation_id,p_tournament_id,p_expected_money_hash);
 IF replay IS DISTINCT FROM receipt THEN RAISE EXCEPTION 'original69_replay_mismatch' USING ERRCODE='55000';END IF;
 digest:=encode(sha256(convert_to(posted::text,'UTF8')),'hex');
 detail:=jsonb_build_object('schema','original69-probe-rollback/v1','operation_id',p_operation_id,'tournament_id',p_tournament_id,
 'nonce',p_nonce,'probe_xid',pg_current_xact_id()::text,'money_hash',p_expected_money_hash,
 'canonical_md5','32ffc8212bcbaec490b76fb904707d3c','state_sha256',before_state->>'state_sha256',
 'asset',receipt->'financial'->>'asset','source_player_count',(receipt->>'source_player_count')::integer,
 'refunded_count',(receipt->>'refunded_count')::integer,'refund_line_count',(receipt->>'refund_line_count')::integer,
 'total_refunded',total::text,'fees_reversed',fees::text,
 'refund_prize',(SELECT coalesce(sum((j->>'prize')::numeric),0)::text FROM jsonb_array_elements(posted) j),
 'refund_bounty',(SELECT coalesce(sum((j->>'bounty')::numeric),0)::text FROM jsonb_array_elements(posted) j),
 'refund_fee',(SELECT coalesce(sum((j->>'fee')::numeric),0)::text FROM jsonb_array_elements(posted) j),'economic_sha256',digest,'canonical_replay_equal',true);
 IF octet_length(detail::text)>4096 THEN RAISE EXCEPTION 'original69_receipt_bound_exceeded' USING ERRCODE='54000';END IF;
 -- MUST remain uncaught: this aborts the entire genuine PostgREST transaction.
 RAISE EXCEPTION 'ORIGINAL69_PROBE_ROLLBACK_V1' USING ERRCODE='PZ069',DETAIL=detail::text;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_probe_original69_abort(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_probe_original69_abort(uuid,uuid,text,text) TO service_role;
COMMIT;
