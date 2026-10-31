-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)'::regprocedure)='ec3d5f4747ef7712a9b0543a8ebc9eb2'
-- Owner October29: future unavailable/already-held satellite seats remain reusable same-value tickets.
-- Cash is paid only to the bubble. Historical settled receipts are retained and replayable.
-- New tickets keep their original target as provenance, not an admission binding.
-- Chips and Diamonds retain separate native backing; no wallet prize conversion.
-- Requires the separately reserved daily-window custody CHECK prerequisite first.
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_settle_satellite_cohort')='821694e700215e473c9690640e0b9d08'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_satellite_cohort_receipt')='63e6d7cc589cf7b4858bd2e6e38479fa'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_register_for_tournament_with_ticket_for')='150a54216455d6751fb6e1567519de89'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_find_tournament_entry_ticket_for')='663377e15ee338fc2ebec746da79af77'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_horse_tournament_entry_ticket_hints')='54aba182e83bfdf97c74ed7ae01fbb7c'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_pay_closed_target_ticket_in_cash')='dc04f91216a3c55b10fb88871accbf84'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_pay_closed_target_tickets_in_cash')='0135a3f976b7cc6189be6016c0113558'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_satellite_entry_ticket_is_guarded')='b134f0c6f85bf3864547e23784d92694'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_ticket_escrow_float')='be57e242b2e8a469ce56693b8f224412'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_arena_diamonds')='ef0881cd4e1da36e3bcf92409452bb63'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_poker_diamond_custody_balance')='24ab362f03ddea7e1314fb9a9a14e931'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_wallet_summary')='b757258cf4a042f8a46d8a4ddf3879a5'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_arena_reconciliation')='bd8c6ea804fcad7eba22b2c225ea9bef'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_trial_balance')='f55868f553f511674cb1be0792c9bb27'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_satellite_value_ticket_marked')='06733376c1f430457674381d041e2f12'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_assert_satellite_value_ticket')='4e0f3938898fb16718673edf4743ac30'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_value_ticket_float')='88eca689747cedc883e33b2505a461e8'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_issue_diamond_value_ticket')='8caa12c1bfeee2e79638ac58d5d2c32a'
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_value_ticket_fund_entry')='16f7c8315fc3ea51fb45f383a4c1080b'
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_satellite_value_ticket_marked(uuid)','EXECUTE')
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_assert_satellite_value_ticket(uuid)','EXECUTE')
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_diamond_value_ticket_float(uuid)','EXECUTE')
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_issue_diamond_value_ticket(uuid,uuid,uuid)','EXECUTE')
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_diamond_value_ticket_fund_entry(uuid,uuid,uuid)','EXECUTE')
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_refund_entitlement_commit_valid()'::regprocedure)='4da9c1df2d71030bef3b3289b20cb41f'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $preimage$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261031075352') THEN RAISE EXCEPTION 'VALUE_TICKET_CUSTODY_CHECK_PREREQUISITE_NOT_INSTALLED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.poker_diamond_movements'::regclass AND conname='poker_diamond_movements_amount_check' AND NOT convalidated AND md5(pg_get_constraintdef(oid))='fc6c4f604342103c8181084586a69e44') THEN RAISE EXCEPTION 'VALUE_TICKET_CUSTODY_CHECK_PREREQUISITE_CHANGED: poker_diamond_movements_amount_check'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.poker_diamond_tournament_ledger'::regclass AND conname='poker_diamond_tournament_ledger_inflow' AND NOT convalidated AND md5(pg_get_constraintdef(oid))='14bb613840792e4fe07859f0e9ef8079') THEN RAISE EXCEPTION 'VALUE_TICKET_CUSTODY_CHECK_PREREQUISITE_CHANGED: poker_diamond_tournament_ledger_inflow'; END IF;

 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)'::regprocedure) IS DISTINCT FROM '9e590a91e702937d34dd6507f5c778ef' THEN RAISE EXCEPTION 'VALUE_TICKET_DRAIN_PREIMAGE_CHANGED'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_refund_entitlement_commit_valid()'::regprocedure) IS DISTINCT FROM 'b3a3353b87e0e0afbfaeef29a42fb154' THEN RAISE EXCEPTION 'VALUE_TICKET_ENTITLEMENT_PREIMAGE_CHANGED'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_settle_satellite_cohort' AND pg_get_function_identity_arguments(oid)='p_tournament_id uuid, p_observed_qualifier_ids uuid[]') IS DISTINCT FROM '0a124091854663df1ddebc8e477bea03' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_settle_satellite_cohort'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_satellite_cohort_receipt' AND pg_get_function_identity_arguments(oid)='p_tournament_id uuid, p_observed_qualifier_ids uuid[]') IS DISTINCT FROM '1b54b5dced237a808a805cb59da22816' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_satellite_cohort_receipt'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_register_for_tournament_with_ticket_for' AND pg_get_function_identity_arguments(oid)='p_tournament_id uuid, p_ticket_id uuid, p_beneficiary_id uuid') IS DISTINCT FROM '7fcbe42e44d287b77e049bffd6a5fa65' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_register_for_tournament_with_ticket_for'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_find_tournament_entry_ticket_for' AND pg_get_function_identity_arguments(oid)='p_tournament_id uuid, p_beneficiary_id uuid') IS DISTINCT FROM 'fce9af08aca30df2bb8b2d0f5d700c4e' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_find_tournament_entry_ticket_for'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_horse_tournament_entry_ticket_hints' AND pg_get_function_identity_arguments(oid)='p_tournament_id uuid') IS DISTINCT FROM '52ab6434a9b0796430f277afa1b145d6' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_horse_tournament_entry_ticket_hints'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_pay_closed_target_ticket_in_cash' AND pg_get_function_identity_arguments(oid)='p_ticket_id uuid, p_source text') IS DISTINCT FROM '2babb800c88eb7798eafd2d4329e4598' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_pay_closed_target_ticket_in_cash'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_pay_closed_target_tickets_in_cash' AND pg_get_function_identity_arguments(oid)='p_target_id uuid, p_source text') IS DISTINCT FROM '7b57d1b2c7996a8e5f608853ec5090c5' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_pay_closed_target_tickets_in_cash'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_satellite_entry_ticket_is_guarded' AND pg_get_function_identity_arguments(oid)='') IS DISTINCT FROM 'bba45d82ffe2b2ebbfbcb35e30800af5' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_satellite_entry_ticket_is_guarded'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_ticket_escrow_float' AND pg_get_function_identity_arguments(oid)='') IS DISTINCT FROM 'bc5b376da141a1ac894ff985ab73cde3' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_ticket_escrow_float'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_arena_diamonds' AND pg_get_function_identity_arguments(oid)='') IS DISTINCT FROM '0af17301960fd0ebb5c2c4be3f184361' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_arena_diamonds'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_poker_diamond_custody_balance' AND pg_get_function_identity_arguments(oid)='') IS DISTINCT FROM 'bb6b6b7266a06d149e4dac5bc34a4ed7' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_poker_diamond_custody_balance'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_wallet_summary' AND pg_get_function_identity_arguments(oid)='p_user_id uuid') IS DISTINCT FROM '0da8fc01241ea8f34a55441be9dbbc5b' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_diamond_wallet_summary'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_diamond_arena_reconciliation' AND pg_get_function_identity_arguments(oid)='p_user_id uuid') IS DISTINCT FROM '73eca09b501123efa32f9b1f9b389357' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_diamond_arena_reconciliation'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_trial_balance' AND pg_get_function_identity_arguments(oid)='p_since timestamp with time zone') IS DISTINCT FROM 'afa5a725e0b228c5baa57d4a6b0c3a42' THEN RAISE EXCEPTION 'VALUE_TICKET_PREIMAGE_CHANGED: fn_ca_diamond_trial_balance'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_satellite_value_ticket_marked') THEN RAISE EXCEPTION 'VALUE_TICKET_HELPER_ALREADY_EXISTS: fn_ca_satellite_value_ticket_marked'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_assert_satellite_value_ticket') THEN RAISE EXCEPTION 'VALUE_TICKET_HELPER_ALREADY_EXISTS: fn_ca_assert_satellite_value_ticket'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_value_ticket_float') THEN RAISE EXCEPTION 'VALUE_TICKET_HELPER_ALREADY_EXISTS: fn_ca_diamond_value_ticket_float'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_issue_diamond_value_ticket') THEN RAISE EXCEPTION 'VALUE_TICKET_HELPER_ALREADY_EXISTS: fn_ca_issue_diamond_value_ticket'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_ca_diamond_value_ticket_fund_entry') THEN RAISE EXCEPTION 'VALUE_TICKET_HELPER_ALREADY_EXISTS: fn_ca_diamond_value_ticket_fund_entry'; END IF;
END $preimage$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_ca_issue_diamond_value_ticket','approved','Private atomic native prize-bank to reusable ticket escrow transfer, whole Diamonds, exact immutable issue proof, zero wallet movement.'),
 ('fn_ca_diamond_value_ticket_fund_entry','approved','Private atomic reusable Diamond ticket escrow to canonical funded tournament-entry custody, same full value, one ticket/one entry, zero wallet movement.');
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_value_ticket_marked(p_ticket_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
 SELECT EXISTS(SELECT 1 FROM public.tournament_tickets t
   JOIN public.tournament_payouts p ON p.tournament_id=t.source_satellite_id
   WHERE t.id=p_ticket_id AND p.source='satellite_ticket' AND p.metadata->>'ticket_id'=p_ticket_id::text
     AND p.metadata->>'ticket_contract'='same_value_entry_v1');
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_assert_satellite_value_ticket(p_ticket_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
 t public.tournament_tickets%ROWTYPE; a public.tournament_satellite_awards%ROWTYPE;
 h public.tournament_satellite_settlements%ROWTYPE; p public.tournament_payouts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; d public.poker_diamond_tournament_ledger%ROWTYPE;
 v_asset text; v_count integer; v_amount numeric;
BEGIN
 SELECT * INTO t FROM public.tournament_tickets WHERE id=p_ticket_id;
 SELECT * INTO a FROM public.tournament_satellite_awards
  WHERE tournament_id=t.source_satellite_id AND place=t.source_satellite_award_place;
 SELECT * INTO h FROM public.tournament_satellite_settlements WHERE tournament_id=a.tournament_id;
 SELECT * INTO p FROM public.tournament_payouts WHERE id=a.payout_id;
 v_asset:=CASE WHEN public.fn_poker_diamond_tournament(t.source_satellite_id) THEN 'diamonds' ELSE 'chips' END;
 IF t.id IS NULL OR a.ticket_id IS DISTINCT FROM t.id OR h.tournament_id IS NULL OR p.id IS NULL
  OR t.issued_by IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
  OR t.status NOT IN ('issued','redeemed') OR t.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
  OR t.source_refund_entitlement_id IS NOT NULL
  OR t.holder_id IS DISTINCT FROM a.user_id OR t.value IS DISTINCT FROM a.amount
  OR t.source_tournament_id IS DISTINCT FROM h.target_id OR t.value IS DISTINCT FROM h.ticket_cost
  OR a.delivery_kind IS DISTINCT FROM 'ticket' OR a.payout_source IS DISTINCT FROM 'satellite_ticket'
  OR round(t.entry_prize+t.entry_bounty,2) IS DISTINCT FROM h.target_buy_in
  OR t.entry_fee IS DISTINCT FROM h.target_fee
  OR p.tournament_id IS DISTINCT FROM a.tournament_id OR p.user_id IS DISTINCT FROM a.user_id
  OR p.amount IS DISTINCT FROM a.amount OR p.source IS DISTINCT FROM a.payout_source
  OR p.idempotency_key IS DISTINCT FROM a.idempotency_key
  OR p.metadata->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
  OR p.metadata->>'ticket_id' IS DISTINCT FROM t.id::text
  OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
  OR p.metadata->>'satellite_target_id' IS DISTINCT FROM h.target_id::text
  OR p.metadata->>'asset' IS DISTINCT FROM v_asset
  OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
  OR public.fn_poker_diamond_tournament(h.target_id) IS DISTINCT FROM (v_asset='diamonds')
  OR EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=a.idempotency_key)
  OR EXISTS(SELECT 1 FROM public.chip_ledger WHERE idempotency_key='ticket:'||t.id::text||':closed-target-cash') THEN
  RAISE EXCEPTION 'VALUE_TICKET_ISSUE_IDENTITY_UNPROVEN %',p_ticket_id USING ERRCODE='P0404';
 END IF;
 IF v_asset='chips' THEN
  SELECT * INTO l FROM public.chip_ledger WHERE idempotency_key=a.idempotency_key||':ticket_escrow';
  IF l.id IS NULL OR l.status IS DISTINCT FROM 'posted' OR l.from_type IS DISTINCT FROM 'prize_liability'
   OR l.from_entity_id IS DISTINCT FROM a.tournament_id OR l.to_type IS DISTINCT FROM 'escrow'
   OR l.to_entity_id IS DISTINCT FROM t.id OR l.amount IS DISTINCT FROM t.value
   OR l.category IS DISTINCT FROM 'ticket_issue' OR l.club_id IS DISTINCT FROM t.club_id
   OR l.tournament_id IS DISTINCT FROM a.tournament_id
   OR l.metadata->>'kind' IS DISTINCT FROM 'direct_satellite_entry_ticket'
   OR l.metadata->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
   OR l.metadata->>'ticket_id' IS DISTINCT FROM t.id::text
   OR l.metadata->>'payout_id' IS DISTINCT FROM p.id::text
   OR l.metadata->>'satellite_id' IS DISTINCT FROM a.tournament_id::text
   OR l.metadata->>'satellite_target_id' IS DISTINCT FROM h.target_id::text
   OR l.metadata->>'user_id' IS DISTINCT FROM t.holder_id::text
   OR l.pre_from_balance IS DISTINCT FROM round(h.pool-(a.place-1)*h.ticket_cost,2)
   OR l.post_from_balance IS DISTINCT FROM round(h.pool-a.place*h.ticket_cost,2)
   OR l.pre_to_balance IS DISTINCT FROM 0::numeric OR l.post_to_balance IS DISTINCT FROM t.value
   OR (SELECT count(*) FROM public.chip_transactions x
       WHERE x.transaction_type='tournament_ticket_issue' AND x.club_id=t.club_id
        AND x.from_user_id IS NULL AND x.to_user_id=t.holder_id AND x.amount=t.value
        AND x.metadata->>'ticket_id'=t.id::text AND x.metadata->>'payout_id'=p.id::text
        AND x.metadata->>'ledger_id'=l.id::text AND x.metadata->>'ticket_contract'='same_value_entry_v1')<>1
   OR EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger x
       WHERE x.idempotency_key='poker-value-ticket-issue:'||t.id::text) THEN
   RAISE EXCEPTION 'VALUE_TICKET_CHIP_BACKING_UNPROVEN %',t.id USING ERRCODE='P0404';
  END IF;
  SELECT count(*),coalesce(sum(amount),0) INTO v_count,v_amount FROM public.chip_ledger
   WHERE from_type='escrow' AND from_entity_id=t.id AND category='ticket_redeem';
 ELSE
  SELECT * INTO d FROM public.poker_diamond_tournament_ledger
   WHERE idempotency_key='poker-value-ticket-issue:'||t.id::text;
  IF d.id IS NULL OR d.tournament_id IS DISTINCT FROM a.tournament_id OR d.user_id IS DISTINCT FROM t.holder_id
   OR d.kind IS DISTINCT FROM 'prize' OR d.amount IS DISTINCT FROM t.value
   OR d.prize_part IS DISTINCT FROM t.value OR d.bounty_part IS DISTINCT FROM 0::bigint
   OR d.fee_part IS DISTINCT FROM 0::bigint OR d.custody_id IS NOT NULL
   OR d.request->>'delivery' IS DISTINCT FROM 'satellite_value_ticket'
   OR d.request->>'ticket_id' IS DISTINCT FROM t.id::text
   OR d.request->>'payout_id' IS DISTINCT FROM p.id::text
   OR d.wallet_journal_id IS NOT NULL
   OR jsonb_typeof(d.request->'drained') IS DISTINCT FROM 'array'
   OR (SELECT coalesce(sum((x->>'amount')::numeric),0)
       FROM jsonb_array_elements(d.request->'drained') x) IS DISTINCT FROM t.value
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.request->'drained') x
       LEFT JOIN public.poker_diamond_movements m ON m.request_id=(x->>'request_id')::uuid
       LEFT JOIN public.poker_diamond_custody c ON c.id=m.custody_id
       WHERE m.request_id IS NULL OR m.action IS DISTINCT FROM 'release'
        OR m.custody_id::text IS DISTINCT FROM x->>'custody_id'
        OR m.user_id IS DISTINCT FROM c.user_id OR c.purpose IS DISTINCT FROM 'tournament_entry'
        OR c.target_id IS DISTINCT FROM t.source_satellite_id
        OR m.amount::numeric IS DISTINCT FROM (x->>'amount')::numeric
        OR m.source_account IS DISTINCT FROM 'arena_custody:'||c.id::text
        OR m.destination_account IS DISTINCT FROM 'ticket_escrow:'||t.id::text
        OR m.wallet_journal_id IS NOT NULL
        OR m.request->>'action' IS DISTINCT FROM 'tournament_drain'
        OR m.request->>'bank' IS DISTINCT FROM 'prize'
        OR m.request->>'reason' IS DISTINCT FROM 'poker-value-ticket-issue:'||t.id::text
        OR m.request->>'delivery' IS DISTINCT FROM 'satellite_value_ticket'
        OR m.request->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
        OR m.request->>'ticket_id' IS DISTINCT FROM t.id::text
        OR m.request->>'payout_id' IS DISTINCT FROM p.id::text)
   OR (SELECT count(*) FROM jsonb_array_elements(d.request->'drained') x)
      IS DISTINCT FROM (SELECT count(DISTINCT x->>'request_id') FROM jsonb_array_elements(d.request->'drained') x)
   OR EXISTS(SELECT 1 FROM public.chip_ledger WHERE to_type='escrow' AND to_entity_id=t.id AND category='ticket_issue')
   OR EXISTS(SELECT 1 FROM public.chip_transactions WHERE metadata->>'ticket_id'=t.id::text) THEN
   RAISE EXCEPTION 'VALUE_TICKET_DIAMOND_BACKING_UNPROVEN %',t.id USING ERRCODE='P0404';
  END IF;
  SELECT count(*),coalesce(sum(amount),0) INTO v_count,v_amount FROM public.poker_diamond_tournament_ledger
   WHERE idempotency_key='poker-value-ticket-entry:'||t.id::text AND kind='entry'
    AND user_id=t.holder_id AND request->>'ticket_id'=t.id::text;
 END IF;
 IF (t.status='issued' AND (v_count<>0 OR v_amount<>0))
  OR (t.status='redeemed' AND (v_count<>1 OR v_amount IS DISTINCT FROM t.value)) THEN
  RAISE EXCEPTION 'VALUE_TICKET_CONSUMPTION_UNPROVEN %',t.id USING ERRCODE='P0404';
 END IF;
 IF v_asset='diamonds' AND t.status='redeemed' AND NOT EXISTS(
  SELECT 1 FROM public.poker_diamond_tournament_ledger e
   JOIN public.poker_diamond_custody c ON c.id=e.custody_id
   JOIN public.poker_diamond_movements m ON m.request_id=(e.request->>'request_id')::uuid
  WHERE e.idempotency_key='poker-value-ticket-entry:'||t.id::text
   AND e.kind='entry' AND e.user_id=t.holder_id AND e.amount=t.value
   AND e.wallet_journal_id IS NULL AND e.registration_id IS NOT NULL
   AND e.request->>'source'='satellite_value_ticket'
   AND e.request->>'ticket_contract'='same_value_entry_v1'
   AND e.request->>'ticket_id'=t.id::text
   AND c.user_id=t.holder_id AND c.purpose='tournament_entry'
   AND c.target_id=e.tournament_id AND c.entry_key='entry:'||e.registration_id::text
   AND m.custody_id=c.id AND m.user_id=t.holder_id AND m.action='reserve'
   AND m.amount=t.value AND m.wallet_journal_id IS NULL
   AND m.source_account='ticket_escrow:'||t.id::text
   AND m.destination_account='arena_custody:'||c.id::text
   AND m.request->>'action'='satellite_value_ticket_entry'
   AND m.request->>'ticket_contract'='same_value_entry_v1'
   AND m.request->>'ticket_id'=t.id::text
   AND m.request->>'target_id'=e.tournament_id::text
   AND m.request->>'registration_id'=e.registration_id::text
 ) THEN
  RAISE EXCEPTION 'VALUE_TICKET_DIAMOND_ENTRY_BACKING_UNPROVEN %',t.id USING ERRCODE='P0404';
 END IF;
 RETURN v_asset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_value_ticket_float(p_user_id uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
 SELECT coalesce(sum(t.value),0)::numeric FROM public.tournament_tickets t
 JOIN public.poker_diamond_tournament_ledger l ON l.idempotency_key='poker-value-ticket-issue:'||t.id::text
  AND l.tournament_id=t.source_satellite_id AND l.user_id=t.holder_id AND l.amount=t.value
  AND l.kind='prize' AND l.request->>'delivery'='satellite_value_ticket'
  AND l.request->>'ticket_id'=t.id::text
 WHERE t.status='issued' AND (p_user_id IS NULL OR t.holder_id=p_user_id)
  AND public.fn_ca_satellite_value_ticket_marked(t.id)
  AND public.fn_poker_diamond_tournament(t.source_satellite_id)
  AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger used
    WHERE used.idempotency_key='poker-value-ticket-entry:'||t.id::text AND used.kind='entry'
      AND used.user_id=t.holder_id AND used.amount=t.value
      AND used.request->>'ticket_id'=t.id::text);
$function$;


CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_left bigint := p_amount; v_take bigint; v_c record; v_lot record; v_loss bigint;
  v_drained jsonb := '[]'::jsonb; v_req uuid; v_journal uuid; v_wallet bigint; v_name text;
  v_register text; v_label text; v_supply numeric;
  v_ticket uuid; v_ticket_payout uuid;
BEGIN
  IF p_tournament_id IS NULL OR p_bank NOT IN ('prize','fee','bounty') OR p_amount IS NULL OR p_amount < 1 OR p_reason IS NULL
     OR p_destination_account IS NULL OR length(btrim(p_destination_account))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_drain' USING ERRCODE='22023';
  END IF;
  -- A ticket transfer is neither a wallet credit nor a house burn. Its
  -- destination must be the exact already-authored immutable prize contract.
  IF p_destination_account LIKE 'ticket_escrow:%' THEN
    IF p_journal_for IS NOT NULL OR p_bank IS DISTINCT FROM 'prize'
       OR p_destination_account !~ '^ticket_escrow:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_DRAIN_CONTRACT_INVALID' USING ERRCODE='P0404';
    END IF;
    v_ticket:=substring(p_destination_account FROM 15)::uuid;
    SELECT p.id INTO v_ticket_payout
      FROM public.tournament_tickets t JOIN public.tournament_payouts p
        ON p.tournament_id=t.source_satellite_id AND p.user_id=t.holder_id
     WHERE t.id=v_ticket AND t.status='issued' AND t.redemption_mode='tournament_entry_only'
       AND t.source_satellite_id=p_tournament_id AND t.value=p_amount
       AND p.amount=t.value AND p.source='satellite_ticket'
       AND p.metadata->>'ticket_id'=t.id::text
       AND p.metadata->>'ticket_contract'='same_value_entry_v1'
       AND p.metadata->>'asset'='diamonds'
       AND public.fn_poker_diamond_tournament(p_tournament_id)
       AND p_reason='poker-value-ticket-issue:'||t.id::text
     FOR UPDATE OF t;
    IF v_ticket_payout IS NULL THEN
      RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_DRAIN_BACKING_UNPROVEN' USING ERRCODE='P0404';
    END IF;
    IF EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=p_reason)
       OR EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger e
         JOIN public.poker_diamond_movements m ON m.request_id=uuid_in(md5(p_reason||':'||e.custody_id::text)::cstring)
         WHERE e.tournament_id=p_tournament_id AND e.custody_id IS NOT NULL
           AND e.kind IN ('entry','rebuy','reentry','addon','spin_underwrite','overlay')) THEN
      RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ALREADY_ISSUED' USING ERRCODE='P0404';
    END IF;
  END IF;
  IF public.fn_poker_diamond_tournament_custody(p_tournament_id) < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  SELECT t.name INTO v_name FROM public.tournaments t WHERE t.id=p_tournament_id;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
  FOR v_c IN
    SELECT c.id, c.user_id, c.balance, c.arena_id,
           (SELECT COALESCE(sum(CASE WHEN p_bank='prize' THEN l.prize_part
                                     WHEN p_bank='bounty' THEN l.bounty_part
                                     ELSE l.fee_part END),0)
              FROM public.poker_diamond_tournament_ledger l
             WHERE l.custody_id=c.id AND l.kind IN ('entry','rebuy','reentry','addon','spin_underwrite','overlay'))
         - (SELECT COALESCE(sum(m.amount),0) FROM public.poker_diamond_movements m
             WHERE m.custody_id=c.id AND m.action='release'
               AND m.request->>'action'='tournament_drain' AND m.request->>'bank'=p_bank) AS held
      FROM public.poker_diamond_custody c
     WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance > 0
     ORDER BY c.created_at, c.id
     FOR UPDATE OF c
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN v_c.held <= 0;
    v_take := LEAST(v_left, v_c.held, v_c.balance);
    -- The lots this row holds are consumed for what leaves it, oldest first,
    -- exactly as fn_poker_diamond_settle_cash_hand consumes a lost stack.
    v_loss := v_take;
    FOR v_lot IN
      SELECT l.id, r.amount-r.consumed AS held, greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
        FROM public.poker_diamond_lot_reservations r
        JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
       WHERE r.custody_id=v_c.id AND r.released_at IS NULL
       ORDER BY l.created_at, l.id FOR UPDATE OF l, r
    LOOP
      EXIT WHEN v_loss = 0;
      IF v_lot.held > 0 THEN
        UPDATE public.diamond_purchase_lots
           SET arena_reserved=arena_reserved-LEAST(v_loss,v_lot.held),
               consumed=consumed+LEAST(LEAST(v_loss,v_lot.held),v_lot.outstanding)::integer
         WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations SET consumed=consumed+LEAST(v_loss,v_lot.held)
         WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss - LEAST(v_loss,v_lot.held);
      END IF;
    END LOOP;
    -- The journal row the movement carries: the recipient's credit for a
    -- prize or a bounty, which moved that recipient's wallet.
    --
    -- A HOUSE-BOUND DRAIN (a fee, a Spin surplus, a guarantee overlay return)
    -- MOVES NO WALLET, SO IT WRITES NO WALLET JOURNAL ROW (20261007132503).
    -- The Diamonds left the player's wallet once, when the entry was bought
    -- (that arena_deposit row is the wallet's record of it); here they leave
    -- custody for the house. A diamond_transactions row would record the same
    -- Diamonds leaving the wallet a second time, and from 13:03 UTC on
    -- 2026-10-07 it did (four tournament_fee rows, 800 Diamonds). The register
    -- still retires them from the player, because it counts custody Diamonds as
    -- the player's: that burn is written here directly, with the wallet
    -- unchanged on both sides, exactly as fn_ca_diamond_sweep_cash_rake writes
    -- the cash rake (20261007112751).
    IF p_journal_for IS NOT NULL THEN
      v_journal := p_journal_for;
      v_register := NULL;
    ELSIF v_ticket IS NOT NULL THEN
      -- Supply remains player-owned ticket escrow; no wallet or mint row.
      v_journal := NULL;
      v_register := NULL;
    ELSE
      v_journal := NULL;
      v_register := p_reason||':'||v_c.id::text;
      SELECT COALESCE(diamonds,0), COALESCE(NULLIF(btrim(username),''), full_name, id::text)
        INTO v_wallet, v_label FROM public.profiles WHERE id=v_c.user_id;
      IF v_supply IS NULL THEN
        SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply
          FROM public.ca_mint_ledger WHERE asset='diamonds';
      END IF;
      v_supply := v_supply - v_take;
      INSERT INTO public.ca_mint_ledger
        (op_id, action, asset, holder_type, holder_id, holder_label, amount,
         balance_before, balance_after, supply_after, reason)
      VALUES
        (v_register, 'burn', 'diamonds', 'player', v_c.user_id, COALESCE(v_label, v_c.user_id::text), v_take,
         COALESCE(v_wallet,0), COALESCE(v_wallet,0), v_supply,
         CASE WHEN p_bank='prize' AND p_reason LIKE 'poker-guarantee-overlay-return:%'
              THEN 'Diamond guarantee overlay returned from this player''s entry custody to the house: '||COALESCE(v_name,'tournament')
              WHEN p_bank='prize'
              THEN 'Diamond Spin surplus returned from this player''s entry custody to the house: '||COALESCE(v_name,'spin')
              ELSE 'Tournament entry fee retired from this player''s entry custody for the house: '||COALESCE(v_name,'tournament') END
         ||'. The wallet does not move: the Diamonds left it when the entry was bought.');
    END IF;
    -- The movement first, then the balance: P0814 (an entry holds exactly its
    -- movements) is checked at the end of this UPDATE, not at commit, because
    -- a row drained twice in one settlement (the fee, then a prize) would
    -- otherwise present its first version against the final movement sum.
    v_req := uuid_in(md5(p_reason||':'||v_c.id::text)::cstring);
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
      source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (v_req,v_c.id,v_c.user_id,'release',v_take,'arena_custody:'||v_c.id,p_destination_account,v_journal,
      jsonb_build_object('action','tournament_drain','bank',p_bank,'reason',p_reason,'custody_id',v_c.id,'amount',v_take)
        || CASE WHEN v_ticket IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
             'delivery','satellite_value_ticket','ticket_contract','same_value_entry_v1',
             'ticket_id',v_ticket,'payout_id',v_ticket_payout) END,
      jsonb_build_object('success',true,'custody_id',v_c.id,'amount',v_take,'custody_balance',v_c.balance-v_take,'journal_id',v_journal,
                         'register_op_id',v_register));
    UPDATE public.poker_diamond_custody SET balance=balance-v_take WHERE id=v_c.id;
    v_drained := v_drained || jsonb_build_object('custody_id',v_c.id,'user_id',v_c.user_id,'amount',v_take,'journal_id',v_journal,
                                                 'register_op_id',v_register,'request_id',v_req);
    v_left := v_left - v_take;
  END LOOP;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  RETURN v_drained;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_issue_diamond_value_ticket(p_satellite_id uuid,p_ticket_id uuid,p_payout_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
 t public.tournament_tickets%ROWTYPE; p public.tournament_payouts%ROWTYPE;
 d public.poker_diamond_tournament_ledger%ROWTYPE;
 v_wallet bigint; v_journal uuid; v_drain jsonb; v_id bigint; v_key text;
BEGIN
 SELECT * INTO t FROM public.tournament_tickets WHERE id=p_ticket_id FOR UPDATE;
 SELECT * INTO p FROM public.tournament_payouts WHERE id=p_payout_id;
 IF t.id IS NULL OR t.status IS DISTINCT FROM 'issued' OR t.source_satellite_id IS DISTINCT FROM p_satellite_id
  OR t.redemption_mode IS DISTINCT FROM 'tournament_entry_only' OR t.value<1 OR t.value<>trunc(t.value)
  OR t.value>2147483647 OR NOT public.fn_poker_diamond_tournament(p_satellite_id)
  OR p.tournament_id IS DISTINCT FROM p_satellite_id OR p.user_id IS DISTINCT FROM t.holder_id
  OR p.amount IS DISTINCT FROM t.value OR p.source IS DISTINCT FROM 'satellite_ticket'
  OR p.metadata->>'ticket_id' IS DISTINCT FROM t.id::text
  OR p.metadata->>'ticket_contract' IS DISTINCT FROM 'same_value_entry_v1'
  OR p.metadata->>'asset' IS DISTINCT FROM 'diamonds' THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ISSUE_CONTRACT_INVALID' USING ERRCODE='P0404';
 END IF;
 v_key:='poker-value-ticket-issue:'||t.id::text;
 SELECT * INTO d FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
 IF FOUND THEN
  IF d.tournament_id IS DISTINCT FROM p_satellite_id OR d.user_id IS DISTINCT FROM t.holder_id
   OR d.amount IS DISTINCT FROM t.value OR d.kind IS DISTINCT FROM 'prize'
   OR d.request->>'payout_id' IS DISTINCT FROM p.id::text THEN
   RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ISSUE_KEY_REUSED' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('success',true,'idempotent',true,'ledger_id',d.id,'journal_id',d.wallet_journal_id);
 END IF;
 IF (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(p_satellite_id))<t.value THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_PRIZE_BANK_SHORT' USING ERRCODE='P0404';
 END IF;
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=t.holder_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_HOLDER_MISSING' USING ERRCODE='P0404'; END IF;
 v_drain:=public.fn_poker_diamond_tournament_drain(p_satellite_id,'prize',t.value::bigint,
  v_key,'ticket_escrow:'||t.id::text,v_journal);
 INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,
  kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,registration_id,request)
 VALUES(p_satellite_id,(SELECT club_id FROM public.tournaments WHERE id=p_satellite_id),t.holder_id,NULL,
  'prize',t.value::bigint,t.value::bigint,0,0,v_key,v_journal,NULL,
  jsonb_build_object('kind','prize','delivery','satellite_value_ticket','ticket_id',t.id,
   'payout_id',p.id,'ticket_contract','same_value_entry_v1','drained',v_drain)) RETURNING id INTO v_id;
 PERFORM public.fn_ca_escrow_apply(p_satellite_id,'Diamond value ticket issued',p_prize_out=>t.value);
 IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_satellite_id))
  IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_satellite_id)::numeric THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_SOURCE_CUSTODY_DIVERGED' USING ERRCODE='P0404';
 END IF;
 RETURN jsonb_build_object('success',true,'idempotent',false,'ledger_id',v_id,'journal_id',v_journal,'amount',t.value);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_value_ticket_fund_entry(p_tournament_id uuid,p_ticket_id uuid,p_registration_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
 t public.tournament_tickets%ROWTYPE; v_target public.tournaments%ROWTYPE;
 r public.tournament_players%ROWTYPE; v_before record; v_after record;
 v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
 v_custody uuid:=gen_random_uuid(); v_request uuid; v_journal uuid; v_wallet bigint;
 v_key text; v_amount numeric; v_prize numeric; v_fee numeric; v_count integer;
 v_ledger bigint; v_receipt jsonb;
BEGIN
 SELECT * INTO t FROM public.tournament_tickets WHERE id=p_ticket_id FOR UPDATE;
 SELECT * INTO v_target FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 SELECT * INTO r FROM public.tournament_players WHERE id=p_registration_id FOR UPDATE;
 IF t.id IS NULL OR t.status IS DISTINCT FROM 'issued'
  OR public.fn_ca_assert_satellite_value_ticket(t.id) IS DISTINCT FROM 'diamonds'
  OR NOT public.fn_poker_diamond_tournament(p_tournament_id)
  OR r.tournament_id IS DISTINCT FROM p_tournament_id OR r.user_id IS DISTINCT FROM t.holder_id
  OR r.source_satellite_id IS DISTINCT FROM t.source_satellite_id OR r.is_satellite_qualifier IS DISTINCT FROM true
  OR r.club_id IS DISTINCT FROM t.club_id
  OR v_target.is_bounty IS DISTINCT FROM false OR v_target.is_pko IS DISTINCT FROM false
  OR v_target.is_mystery_bounty IS DISTINCT FROM false OR coalesce(v_target.bounty_amount,0)<>0 THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ENTRY_CONTRACT_INVALID' USING ERRCODE='P0404';
 END IF;
 v_amount:=v_target.buy_in_amount+coalesce(v_target.buy_in_fee,0);
 v_prize:=v_target.buy_in_amount; v_fee:=coalesce(v_target.buy_in_fee,0);
 IF v_amount IS DISTINCT FROM t.value OR v_amount<>trunc(v_amount) OR v_prize<0 OR v_fee<0
  OR v_prize<>trunc(v_prize) OR v_fee<>trunc(v_fee) THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_PRICE_MISMATCH' USING ERRCODE='22023';
 END IF;
 v_key:='poker-value-ticket-entry:'||t.id::text;
 SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
 IF FOUND THEN RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ALREADY_COMMITTED' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM public.poker_diamond_custody c WHERE c.user_id=t.holder_id
  AND c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released') THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ENTRY_ALREADY_FUNDED' USING ERRCODE='23505';
 END IF;
 SELECT * INTO v_before FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
 SELECT count(*) INTO v_count FROM public.tournament_players
  WHERE tournament_id=p_tournament_id AND status::text IN ('registered','playing');
 IF v_target.prize_pool IS DISTINCT FROM v_before.prize_balance
  OR v_target.total_rake IS DISTINCT FROM v_before.fee_balance OR v_before.bounty_balance<>0
  OR v_before.prize_balance+v_before.fee_balance IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric
  OR v_target.current_players IS DISTINCT FROM (CASE WHEN v_target.status IN ('ANNOUNCED','REGISTERING') THEN v_count ELSE v_count-1 END) THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_TARGET_BANK_DIVERGED' USING ERRCODE='P0404';
 END IF;
 PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=t.holder_id FOR NO KEY UPDATE;
 INSERT INTO public.poker_diamond_custody(id,user_id,arena_id,purpose,target_id,entry_key,balance,state)
 VALUES(v_custody,t.holder_id,v_target.club_id,'tournament_entry',p_tournament_id,
  'entry:'||r.id::text,t.value::bigint,'active');
 v_request:=uuid_in(md5(v_key)::cstring);
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',v_request,
  'amount',t.value,'custody_balance',t.value,'journal_id',v_journal,'ticket_id',t.id);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
  source_account,destination_account,wallet_journal_id,request,receipt)
 VALUES(v_request,v_custody,t.holder_id,'reserve',t.value::bigint,'ticket_escrow:'||t.id::text,
  'arena_custody:'||v_custody::text,v_journal,jsonb_build_object('action','satellite_value_ticket_entry',
   'ticket_contract','same_value_entry_v1','ticket_id',t.id,'target_id',p_tournament_id,'registration_id',r.id,'amount',t.value),v_receipt);
 INSERT INTO public.poker_diamond_tournament_ledger(tournament_id,arena_id,user_id,custody_id,
  kind,amount,prize_part,bounty_part,fee_part,idempotency_key,wallet_journal_id,registration_id,request)
 VALUES(p_tournament_id,v_target.club_id,t.holder_id,v_custody,'entry',t.value::bigint,
  v_prize::bigint,0,v_fee::bigint,v_key,v_journal,r.id,
  jsonb_build_object('kind','entry','source','satellite_value_ticket','ticket_id',t.id,
   'ticket_contract','same_value_entry_v1','gross',t.value,'prize',v_prize,'bounty',0,'fee',v_fee,
   'request_id',v_request)) RETURNING id INTO v_ledger;
 UPDATE public.tournaments SET entry_contract_locked=true WHERE id=p_tournament_id AND NOT entry_contract_locked;
 PERFORM public.fn_ca_escrow_apply(p_tournament_id,'Diamond value ticket admission',
  p_gross_in=>t.value,p_fee_entries_in=>v_fee);
 SELECT * INTO v_after FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
 IF v_after.prize_balance IS DISTINCT FROM v_before.prize_balance+v_prize
  OR v_after.fee_balance IS DISTINCT FROM v_before.fee_balance+v_fee OR v_after.bounty_balance<>0
  OR v_after.prize_balance+v_after.fee_balance IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
  RAISE EXCEPTION 'DIAMOND_VALUE_TICKET_ENTRY_CUSTODY_DIVERGED' USING ERRCODE='P0404';
 END IF;
 UPDATE public.tournaments SET current_players=v_count,prize_pool=v_after.prize_balance,
  total_rake=v_after.fee_balance,updated_at=now() WHERE id=p_tournament_id;
 RETURN v_receipt||jsonb_build_object('ledger_id',v_ledger,'registration_id',r.id,
  'prize_contribution',v_prize,'bounty_contribution',0,'fee_contribution',v_fee,'asset','diamonds');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_cohort(p_tournament_id uuid, p_observed_qualifier_ids uuid[])
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
  v_qualifier_ids uuid[];
  v_award_users uuid[];
  v_entitlements jsonb;
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
  v_target_is_bounty boolean;              -- 2026-10-16: the target entry split
  v_entry_prize numeric;                   -- 2026-10-16: the target entry split
  v_entry_bounty numeric;                  -- 2026-10-16: the target entry split
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
  v_admitted public.tournament_players%ROWTYPE;
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
  v_seat_receipt jsonb;
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
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_diamond_seat jsonb;                    -- DIAMOND PHASE 9
  v_target_prize_before numeric;           -- DIAMOND PHASE 9
  v_target_fee_before numeric;             -- DIAMOND PHASE 9
  v_target_bounty_before numeric;          -- DIAMOND PHASE 9
  v_target_custody_before numeric;         -- DIAMOND PHASE 9
  v_unit_cents integer;                    -- DIAMOND PHASE 9
BEGIN
  IF public.fn_ca_lock_mtt_admission_contract() IS DISTINCT FROM 'unlimited-mtt-v2' THEN
    RAISE EXCEPTION 'satellite cohort admission is not activated' USING ERRCODE='55000';
  END IF;
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  -- THAT LOCK IS F, THE FINISH LANE (2026-09-17): exclusive among finishes,
  -- shared with every hand and rolling authority of other tournaments. A
  -- satellite writes its target's rows too, so it holds T(satellite) and
  -- T(target) exclusively, in uuid order, with G shared; the global lane
  -- calls inside re-enter it. No target resolvable: the global lane as before.
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);

  IF p_tournament_id IS NULL OR p_observed_qualifier_ids IS NULL OR cardinality(p_observed_qualifier_ids)<1
     OR p_observed_qualifier_ids IS DISTINCT FROM (SELECT array_agg(DISTINCT u ORDER BY u) FROM unnest(p_observed_qualifier_ids) u)
     OR array_position(p_observed_qualifier_ids,NULL::uuid) IS NOT NULL THEN
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
    RETURN public.fn_ca_satellite_cohort_receipt(
      p_tournament_id, p_observed_qualifier_ids);
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
      USING ERRCODE = '55000';
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
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_cohort_receipt(
      p_tournament_id, p_observed_qualifier_ids);
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

  IF (SELECT t.format_contract='mtt-v2' OR (t.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(t)))
         FROM public.tournaments t WHERE id=p_tournament_id) IS NOT TRUE
     OR NOT public.fn_ca_tournament_is_unlimited(v_target_id)
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=v_target_id
       AND (t.satellite_target_id IS NOT NULL OR t.satellite_target IS NOT NULL
         OR upper(coalesce(t.tournament_type,''))='SATELLITE'
         OR lower(coalesce(t.variant,''))='satellite')) THEN
    RAISE EXCEPTION 'satellite cohort requires recorded new MTT source and ordinary unlimited MTT target' USING ERRCODE='55000';
  END IF;
  v_entitlements:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
  IF (v_entitlements->>'ok')::boolean IS DISTINCT FROM true
     OR (v_entitlements->>'ready')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'satellite cohort final funded entitlements unproven: %',v_entitlements USING ERRCODE='P0404';
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
         t.bounty_amount, t.bounty_pool, t.bounty_pool_paid,
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
  -- DIAMOND PHASE 9: ASSETS NEVER CROSS. A Diamond satellite seats only a
  -- Diamond target and a chip satellite only a chip target; either crossing
  -- is refused by name here, before any money, roster or escrow row moves.
  v_diamond := public.fn_ca_assert_satellite_asset(p_tournament_id, v_target_id);
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
  -- A SEAT INTO A BOUNTY TARGET IS BOOKED EXACTLY LIKE A PAID ENTRY
  -- (2026-10-16). The ticket is the target's whole buy-in plus fee. A paid
  -- entry splits that charge through fn_tournament_entry_split into prize,
  -- bounty and fee; a seat delivered here is split the same way, by the
  -- same function, so the bounty slice lands on the bounty rail with a
  -- funded head and never on the prize ladder (the 2026-09-07 PKO
  -- shortfall). A Spin target, a premium Spin and a target whose flags are
  -- unknown are still refused: the split cannot be known for them. A
  -- Diamond bounty target is refused too: the Diamond seat transfer has no
  -- bounty part to carry the slice.
  IF (
       v_target.is_bounty IS NULL
       OR v_target.is_pko IS NULL
       OR v_target.is_mystery_bounty IS NULL
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported Spin or unknown entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  v_target_is_bounty := v_target.is_bounty OR v_target.is_pko
                        OR v_target.is_mystery_bounty;
  IF v_target_is_bounty AND v_diamond THEN
    RAISE EXCEPTION
      'satellite % Diamond target % carries a bounty the Diamond seat transfer cannot fund',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  SELECT s.prize, s.bounty INTO v_entry_prize, v_entry_bounty
    FROM public.fn_tournament_entry_split(
      v_target_buy_in, v_target_fee, v_target.bounty_amount,
      v_target_is_bounty) s;
  IF v_entry_prize IS NULL OR v_entry_bounty IS NULL
     OR v_entry_prize < 0 OR v_entry_bounty < 0
     OR round(v_entry_prize + v_entry_bounty, 2)
          IS DISTINCT FROM v_target_buy_in THEN
    RAISE EXCEPTION
      'satellite % target % has a misconfigured bounty split (prize %, bounty %, buy-in %)',
      p_tournament_id, v_target_id, v_entry_prize, v_entry_bounty,
      v_target_buy_in USING ERRCODE = '22023';
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
  -- DIAMOND PHASE 9: a Diamond satellite's escrow shadow opens from its own
  -- ledger with its exact parts, as the Diamond terminal writer opens one.
  IF v_diamond THEN
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
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
                 WHERE o.tournament_id = p_tournament_id
                   AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
                            AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed))
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

  SELECT array_agg(tp.user_id ORDER BY tp.user_id),count(*) INTO v_qualifier_ids,v_live_count
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND tp.status::text='playing' AND tp.chips>0;
  IF v_qualifier_ids IS DISTINCT FROM p_observed_qualifier_ids
     OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
          AND tp.status::text IN ('playing','winner') AND (tp.chips IS NULL OR tp.chips<=0 OR tp.status::text='winner'))
     OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates c WHERE c.tournament_id=p_tournament_id AND c.state='pending')
     OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c JOIN public.tables t ON t.id=c.table_id
          WHERE t.tournament_id=p_tournament_id AND c.post_commit_completed_at IS NULL) THEN
    RAISE EXCEPTION 'satellite cohort differs or accepted hand/elimination remains unresolved' USING ERRCODE='55000';
  END IF;
  v_ticket_award_count:=floor(v_pool/v_ticket_cost)::integer;
  IF v_ticket_award_count<2 OR v_live_count>v_ticket_award_count
     OR (v_entitlements->>'ticket_value')::numeric IS DISTINCT FROM v_ticket_cost
     OR (v_entitlements->>'source_pool')::numeric IS DISTINCT FROM v_pool
     OR (SELECT count(*) FROM public.tournament_satellite_entitlements e
          WHERE e.tournament_id=p_tournament_id AND e.award_kind='seat_or_cash'
            AND e.ticket_value=v_ticket_cost AND e.remainder_value=0)<>v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite has not reached its frozen full-ticket depth' USING ERRCODE='55000';
  END IF;
  SELECT count(*),count(elimination_sequence),count(DISTINCT elimination_sequence)
    INTO v_eliminated_count,v_sequenced_count,v_distinct_sequence_count
    FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated';
  IF v_eliminated_count<>v_field_size-v_live_count
     OR v_sequenced_count<>v_eliminated_count OR v_distinct_sequence_count<>v_eliminated_count THEN
    RAISE EXCEPTION 'satellite cohort lacks exact causal eliminated standings' USING ERRCODE='P0404';
  END IF;
  -- No ranked place is assigned to a survivor. Same-hand overflow awardees
  -- retain the already accepted elimination sequence, including the bubble.
  UPDATE public.tournament_players SET status='winner',position=NULL,eliminated_at=NULL,
    elimination_sequence=NULL WHERE tournament_id=p_tournament_id AND user_id=ANY(v_qualifier_ids);
  UPDATE public.tournament_players SET position=NULL WHERE tournament_id=p_tournament_id AND status='eliminated';
  WITH ranked AS (SELECT id,row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC)::integer+v_live_count final_position
       FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated')
  UPDATE public.tournament_players tp SET position=r.final_position FROM ranked r WHERE tp.id=r.id;
  SELECT v_qualifier_ids||coalesce(array_agg(tp.user_id ORDER BY tp.position),ARRAY[]::uuid[])
    INTO v_award_users FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND tp.position BETWEEN v_live_count+1 AND v_ticket_award_count;
  IF cardinality(v_award_users)<>v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite cohort has missing full-ticket recipients' USING ERRCODE='P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  -- DIAMOND PHASE 9: WHERE THE UNIT DIVIDES - NOWHERE. The prize bank is a
  -- sum of whole ledger parts and the ticket is the target's whole buy-in
  -- plus its whole fee, so seats times ticket and the remainder are whole
  -- Diamonds and the flooring residue (the remainder less its floor at the
  -- unit) is exactly zero. It lands nowhere: a pool, ticket or remainder
  -- that is not its own floor at the unit is refused by name, before any
  -- Diamond moves.
  IF v_diamond THEN
    v_unit_cents := public.fn_ca_tournament_unit_cents(p_tournament_id);
    IF public.fn_ca_unit_floor_cents(round(v_pool * 100)::bigint, v_unit_cents)
         <> round(v_pool * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_ticket_cost * 100)::bigint, v_unit_cents)
         <> round(v_ticket_cost * 100)::bigint
       OR public.fn_ca_unit_floor_cents(round(v_remainder * 100)::bigint, v_unit_cents)
         <> round(v_remainder * 100)::bigint THEN
      RAISE EXCEPTION
        'diamond_satellite_does_not_divide_into_whole_diamonds: satellite % pool % ticket % remainder %',
        p_tournament_id, v_pool, v_ticket_cost, v_remainder USING ERRCODE = '23514';
    END IF;
  END IF;
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
  -- held. Explicit closed, full or held seats become reusable same-value tickets. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(v_target_id) AND v_target.max_players IS NOT NULL AND v_target.max_players > 0
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
      WHEN public.fn_ca_tournament_is_unlimited(v_target_id) OR v_target.max_players IS NULL OR v_target.max_players = 0
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
       AND tp.user_id=ANY(v_award_users)
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_award_users[v_place];
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'ticket';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'ticket';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'ticket';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id)
          -- THE DYING SATELLITE IS NOT A GAME (2026-10-17). This settlement
          -- releases the winner's seats at this satellite in this same
          -- transaction, so those seats cannot be the games that cap the
          -- winner. Counting them held Sunday Deep Stack Satellite 10 RUNNING
          -- and unpaid for two hours on 2026-10-16 while its sole survivor
          -- "sat" at the table this settlement was about to close. The
          -- subtraction mirrors clause (1) of fn_concurrent_game_load exactly,
          -- so it removes only seats that clause counted.
          - (SELECT count(*)::int
               FROM public.table_seats zts
               JOIN public.tables zt ON zt.id = zts.table_id
              WHERE zts.user_id = v_finisher.user_id
                AND zts.left_at IS NULL
                AND zt.status <> 'closed'
                AND zt.tournament_id = p_tournament_id
                AND NOT EXISTS (
                  SELECT 1 FROM public.tournaments ztr
                   WHERE ztr.id = zt.tournament_id
                     AND ztr.status IN ('COMPLETING','COMPLETED','CANCELLED')));
        IF v_cap_load>=4 THEN
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
        RAISE EXCEPTION 'satellite value award has an unknown delivery kind' USING ERRCODE='P0404';
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
  -- Closed/full/independently-held seats become funded value tickets and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  -- DIAMOND PHASE 9: a Diamond target's money is its Diamond ledger and its
  -- custody, not a chip escrow. A satellite does not open its shadow (its own
  -- terminal does); the aggregates it publishes must be exactly its banks
  -- before a seat is added, and its banks exactly its custody.
  IF v_seat_count > 0 AND v_diamond THEN
    SELECT e.prize_balance, e.fee_balance, e.bounty_balance
      INTO v_target_prize_before, v_target_fee_before, v_target_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e;
    v_target_custody_before := public.fn_poker_diamond_tournament_custody(v_target_id)::numeric;
    IF v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS DISTINCT FROM v_target_prize_before
       OR v_target.total_rake IS DISTINCT FROM v_target_fee_before
       OR v_target_bounty_before IS DISTINCT FROM 0::numeric
       OR v_target_prize_before + v_target_fee_before IS DISTINCT FROM v_target_custody_before THEN
      RAISE EXCEPTION
        'satellite % cannot deliver a Diamond target seat against malformed aggregate or bank state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND NOT v_diamond AND (
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
       -- A bounty target's bounty bank is exactly its published pool less
       -- what knockouts have already paid from it (2026-10-16).
       OR v_target_escrow.bounty_balance IS DISTINCT FROM
            (CASE WHEN v_target_is_bounty
                  THEN round(COALESCE(v_target.bounty_pool, 0)
                             - COALESCE(v_target.bounty_pool_paid, 0), 2)
                  ELSE 0::numeric END)
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
     winner_id, qualifier_ids, receipt_version, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     NULL, v_qualifier_ids, 3, v_field_size, v_advertised_seats, v_pool,
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
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      -- A bounty seat carries its funded head on the row, exactly as the
      -- paid door writes it (flat bounty on the head, mystery value drawn
      -- later from the chest inventory), so trg_seed_bounty_head finds it
      -- already seeded and never raises an unfunded head (2026-10-16).
      IF v_entry_bounty > 0 THEN
        INSERT INTO public.tournament_players
          (tournament_id, user_id, username, chips, status,
           is_satellite_qualifier, source_satellite_id,
           current_bounty, mystery_bounty_value, bounties_collected,
           bounty_winnings)
        VALUES
          (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
           true, p_tournament_id, v_entry_bounty, 0, 0, 0)
        RETURNING * INTO v_admitted;
      ELSE
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING * INTO v_admitted;
      END IF;
      v_registration_id := v_admitted.id;
      -- The admission trigger selects the member club for a union entrant.
      -- It is the funding/refund identity used by ordinary ticket admission.
      IF v_admitted.club_id IS NULL
         OR v_admitted.tournament_id IS DISTINCT FROM v_target_id
         OR v_admitted.user_id IS DISTINCT FROM v_finisher.user_id
         OR v_admitted.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR v_admitted.is_satellite_qualifier IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'satellite seat returned inconsistent registration identity'
          USING ERRCODE='P0404';
      END IF;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
      IF v_diamond THEN
        -- DIAMOND PHASE 9: THE SEAT IS A CUSTODY-TO-CUSTODY MOVEMENT. The
        -- whole ticket leaves the satellite's prize bank (a release movement
        -- on each drained entry row) and becomes the winner's funded entry
        -- in the target (a new tournament_entry custody row, its reserve
        -- movement, and the entry ledger row carrying the target's own prize
        -- and fee parts). No wallet moves and the register does not move;
        -- the chip transfer leg and the chip fee row are not written. It is
        -- written before any chair is taken: a Diamond tournament chair is
        -- admitted only against an active funded entry (P0810).
        v_diamond_seat := public.fn_poker_diamond_tournament_seat_transfer(
          p_tournament_id, v_target_id, v_finisher.user_id, v_registration_id,
          v_ticket_cost, v_target_buy_in, v_target_fee,
          'tourney:' || p_tournament_id::text || ':seat:' || v_finisher.user_id::text);
        IF COALESCE((v_diamond_seat->>'success')::boolean, false) IS NOT TRUE
           OR COALESCE((v_diamond_seat->>'idempotent')::boolean, false) THEN
          RAISE EXCEPTION 'satellite % Diamond seat % was not delivered exactly once',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        END IF;
      END IF;

      /* EVERY ADMITTED ENTRANT IS DEALT IN (2026-09-25).

         The INSERT above writes status 'registered' with a zero stack and
         leaves the chair to whoever launches the target. That is correct while
         the target is ANNOUNCED or REGISTERING: startLifecycle reads the
         roster with status IN ('registered','playing') and
         createTablesAndSeatPlayers seats every one of them.

         A target that is already RUNNING has no such moment. Its tables exist,
         so the engine takes the resume branch that adopts them and never calls
         createTablesAndSeatPlayers again, and nothing else comes back for a
         roster row parked at 'registered'. The sibling ticket-funded admission
         path does not have this hole: fn_ca_register_for_tournament_with_ticket_for
         takes the chair through fn_seat_late_registrant in the same
         transaction that admits the entry. This door did not.

         Measured: satellite 95b5fd70 delivered place 1 into RUNNING target
         c7f21a83 ("Sunday Funday Six-Card Closer") at 2026-09-22 14:08:23.
         The winner has held a paid registration and no stack ever since. From
         the very next sample at 14:10:02 the tournament chip-conservation
         sentinel reported the event holding 120,000 against 150,000 issued to
         its five entrants, and it has reported the same -30,000 for 473
         consecutive samples with hands_dealt = 0 in every one of them - no
         chips moved, one starting stack was simply never created. Exactly one
         entrant on the whole estate is in that state, and this is the door it
         came through.

         So the chair is taken HERE, through the same canonical authority every
         other late-registration path uses, inside the transaction that books
         the admission. fn_ca_lock_tournament_seat_acquisition takes the global
         lane shared and then the target's rolling lane; this transaction
         already holds the global lane exclusively and already holds v_target
         FOR UPDATE, so the acquisition order is unchanged (G before T) and no
         new lane is introduced. A refusal raises rather than leaving a
         registration the tournament will never deal in: the satellite
         settlement is atomic, so the whole delivery is rolled back and retried
         rather than half-made.

         A maintenance freeze is one such refusal:
         fn_ca_lock_tournament_seat_acquisition answers
         {"ok": false, "reason": "platform_frozen"} and this raises, so a
         satellite that finishes inside the hourly break settles after the thaw
         instead of admitting a winner the frozen platform cannot seat. That is
         the same answer every other seat door gives during a break, and this
         settlement is idempotent on its own receipt. */
      IF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
        v_seat_receipt := public.fn_seat_late_registrant(
          v_target_id, v_finisher.user_id);
        IF COALESCE((v_seat_receipt->>'ok')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION
            'satellite % admitted place % to RUNNING target % and could not deal them in: % - Aborting So No Unseatable Entry Is Booked',
            p_tournament_id, v_place, v_target_id, v_seat_receipt
            USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.table_seats ts
            JOIN public.tables tb ON tb.id = ts.table_id
           WHERE tb.tournament_id = v_target_id
             AND ts.user_id = v_finisher.user_id
             AND ts.left_at IS NULL) THEN
          RAISE EXCEPTION
            'satellite % target seat for place % reported success but left no live chair in %',
            p_tournament_id, v_place, v_target_id
            USING ERRCODE = '55000';
        END IF;
      END IF;

      IF NOT v_diamond THEN  -- DIAMOND PHASE 9: the chip transfer and fee legs
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
         v_ticket_cost, 'tournament_buyin', v_admitted.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket award slot %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'award_slot', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0)
         -- A bounty seat's leg names its split (entry_split_version 2), so
         -- fn_ca_escrow_on_seat_transfer_leg books prize plus bounty as gross
         -- and the bounty on the bounty rail, as a paid entry is booked.
         || CASE WHEN v_entry_bounty > 0 THEN jsonb_build_object(
              'entry_split_version', 2,
              'entry_prize', v_entry_prize,
              'entry_bounty', v_entry_bounty,
              'entry_fee', v_target_fee)
            ELSE '{}'::jsonb END,
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
             'award_slot', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id)
           -- A split leg's gross already excludes the fee, so its fee row
           -- moves only the fee into fee escrow (fn_ca_escrow_on_rake_record).
           || CASE WHEN v_entry_bounty > 0
                   THEN jsonb_build_object('entry_split_version', 2)
                   ELSE '{}'::jsonb END);
      END IF;
      END IF;  -- DIAMOND PHASE 9: the chip transfer and fee legs

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_finisher.position, v_ticket_cost,
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
      -- escrow the funded award in a same-value, noncash ticket instead.
      v_ticket_club_id := CASE WHEN v_diamond THEN v_target.club_id ELSE public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id)) END;
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
        (p_tournament_id, v_finisher.user_id, v_finisher.position, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_contract', 'same_value_entry_v1',
           'asset', CASE WHEN v_diamond THEN 'diamonds' ELSE 'chips' END,
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
         'Satellite Award: Same-Value Tournament Entry Ticket',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_entry_prize, v_entry_bounty, v_target_fee,
         transaction_timestamp());

      IF v_diamond THEN
        v_diamond_seat:=public.fn_ca_issue_diamond_value_ticket(p_tournament_id,v_ticket_id,v_payout_id);
        IF (v_diamond_seat->>'success')::boolean IS DISTINCT FROM true
           OR (v_diamond_seat->>'idempotent')::boolean IS DISTINCT FROM false THEN
          RAISE EXCEPTION 'Diamond value ticket was not issued exactly once' USING ERRCODE='P0404';
        END IF;
      ELSE
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
         format('Satellite ticket award slot %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_contract', 'same_value_entry_v1',
           'asset', CASE WHEN v_diamond THEN 'diamonds' ELSE 'chips' END,
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'award_slot', v_place,
           'entry_prize', v_entry_prize,
           'entry_bounty', v_entry_bounty,
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
           'ticket_contract', 'same_value_entry_v1',
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

      END IF; -- Chips and Diamonds retain their own backing rails.
      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
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
        p_tournament_id USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_entry_prize, 2),
           bounty_pool = CASE WHEN v_entry_bounty > 0
                              THEN round(COALESCE(bounty_pool, 0)
                                         + v_seat_count * v_entry_bounty, 2)
                              ELSE bounty_pool END,
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake, t.bounty_pool
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
            round(v_target.prize_pool + v_seat_count * v_entry_prize, 2)
       OR v_target_after.bounty_pool IS DISTINCT FROM
            (CASE WHEN v_entry_bounty > 0
                  THEN round(COALESCE(v_target.bounty_pool, 0)
                             + v_seat_count * v_entry_bounty, 2)
                  ELSE v_target.bounty_pool END)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR (NOT v_diamond AND (v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM
            round(v_target_escrow.gross_in
                  + CASE WHEN v_entry_bounty > 0
                         THEN v_seat_count * (v_entry_prize + v_entry_bounty)
                         ELSE 0 END, 2)
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM
            round(v_target_escrow.bounty_in + v_seat_count * v_entry_bounty, 2)
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + CASE WHEN v_entry_bounty > 0 THEN 0
                         ELSE v_seat_count * v_target_buy_in END, 2)
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
                  + v_seat_count * v_entry_prize, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM
            round(v_target_escrow.bounty_balance + v_seat_count * v_entry_bounty, 2)
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note))
       -- DIAMOND PHASE 9: a Diamond target proves the delta on its own banks:
       -- each seat added exactly its buy-in to the prize bank, its fee to the
       -- fee bank and its ticket to custody, and the aggregates follow them.
       OR (v_diamond AND (
            (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_prize_before + v_seat_count * v_target_buy_in
         OR (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM v_target_fee_before + v_seat_count * v_target_fee
         OR (SELECT e.bounty_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
              IS DISTINCT FROM 0::numeric
         OR public.fn_poker_diamond_tournament_custody(v_target_id)::numeric
              IS DISTINCT FROM v_target_custody_before + v_seat_count * v_ticket_cost
         OR v_target_after.prize_pool IS DISTINCT FROM
              (SELECT e.prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e)
         OR v_target_after.total_rake IS DISTINCT FROM
              (SELECT e.fee_balance FROM public.fn_poker_diamond_tournament_escrow(v_target_id) e))) THEN
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
     AND user_id=ANY(v_award_users);
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
      p_tournament_id USING ERRCODE = '55000';
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
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '55000';
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
      p_tournament_id USING ERRCODE = '55000';
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
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  RETURN public.fn_ca_satellite_cohort_receipt(
    p_tournament_id, p_observed_qualifier_ids);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_cohort_receipt(p_tournament_id uuid, p_observed_qualifier_ids uuid[])
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
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
  v_diamond boolean := false;              -- DIAMOND PHASE 9
  v_entry_prize numeric;                   -- 2026-10-16: the target entry split
  v_entry_bounty numeric;                  -- 2026-10-16: the target entry split
BEGIN
  -- Browser receipt reads take the same outer locks as manager/finish reads.
  -- Acquire them before the header or any target row, never after a row lock.
  -- Reading an already committed receipt does not require an activated ABI.
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);
  IF p_tournament_id IS NULL OR p_observed_qualifier_ids IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed qualifier ids'
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
  IF v_h.receipt_version IS DISTINCT FROM 3 OR v_h.winner_id IS NOT NULL
     OR v_h.qualifier_ids IS DISTINCT FROM p_observed_qualifier_ids THEN
    RAISE EXCEPTION 'satellite cohort receipt identity differs' USING ERRCODE='55000';
  END IF;

  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 9
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
  -- A delivered seat or ticket into a bounty target carries the target's
  -- own entry split (2026-10-16). The economic columns are immutable after
  -- the first seat or ticket, so the split read now is the one booked.
  SELECT s.prize, s.bounty INTO v_entry_prize, v_entry_bounty
    FROM public.fn_tournament_entry_split(
      v_h.target_buy_in, v_h.target_fee, v_target.bounty_amount,
      COALESCE(v_target.is_bounty,false) OR COALESCE(v_target.is_pko,false)
        OR COALESCE(v_target.is_mystery_bounty,false)) s;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR v_entry_prize IS NULL OR v_entry_bounty IS NULL
       OR v_entry_prize < 0 OR v_entry_bounty < 0
       OR round(v_entry_prize + v_entry_bounty, 2)
            IS DISTINCT FROM v_h.target_buy_in
       OR (v_diamond AND v_entry_bounty <> 0)
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
  PERFORM public.fn_ca_assert_satellite_cohort_standings(p_tournament_id);

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
           ON tp.tournament_id = p_tournament_id AND tp.user_id = a.user_id
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR tp.user_id IS NULL
            OR a.user_id IS DISTINCT FROM CASE WHEN a.place<=cardinality(v_h.qualifier_ids)
                 THEN v_h.qualifier_ids[a.place]
                 ELSE (SELECT x.user_id FROM public.tournament_players x WHERE x.tournament_id=p_tournament_id AND x.position=a.place) END
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.user_id=ANY(v_h.qualifier_ids) OR tp.position BETWEEN cardinality(v_h.qualifier_ids)+1 AND v_h.ticket_award_count)
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.user_id = tp.user_id)
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
         OR p."position" IS DISTINCT FROM (SELECT tp.position FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id AND tp.user_id=a.user_id)
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

  -- New value contracts retain their exact native backing on every replay.
  IF EXISTS(SELECT 1 FROM public.tournament_satellite_awards a
     WHERE a.tournament_id=p_tournament_id AND a.delivery_kind='ticket'
       AND public.fn_ca_satellite_value_ticket_marked(a.ticket_id)
       AND public.fn_ca_assert_satellite_value_ticket(a.ticket_id)
           IS DISTINCT FROM CASE WHEN v_diamond THEN 'diamonds' ELSE 'chips' END) THEN
    RAISE EXCEPTION 'satellite value ticket asset is unproven' USING ERRCODE='P0404';
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
       AND NOT public.fn_ca_satellite_value_ticket_marked(a.ticket_id)
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
         OR tk.entry_prize IS DISTINCT FROM v_entry_prize
         OR tk.entry_bounty IS DISTINCT FROM v_entry_bounty
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
         OR l.metadata->>'award_slot' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_entry_prize
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM v_entry_bounty
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
       <> (CASE WHEN v_diamond THEN 0 ELSE v_h.entry_ticket_count END) THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- DIAMOND PHASE 9: a Diamond seat is proved by its Diamond evidence - the
  -- satellite's prize-bank row out, the target's funded entry row in with
  -- the target's own parts, and the entry custody row named for the
  -- registration - never by a chip transfer leg or a chip fee row, which a
  -- Diamond seat does not write.
  IF v_diamond AND (EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.poker_diamond_tournament_ledger lo
        ON lo.idempotency_key = 'poker-tournament-seat-out:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_tournament_ledger li
        ON li.idempotency_key = 'poker-tournament-seat-in:' || a.idempotency_key
      LEFT JOIN public.poker_diamond_custody c
        ON c.id = li.custody_id
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
         OR target_player.user_id IS DISTINCT FROM a.user_id
         OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
         OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR lo.id IS NULL
         OR lo.tournament_id IS DISTINCT FROM p_tournament_id
         OR lo.kind IS DISTINCT FROM 'prize'
         OR lo.user_id IS DISTINCT FROM a.user_id
         OR lo.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.id IS NULL
         OR li.tournament_id IS DISTINCT FROM v_h.target_id
         OR li.kind IS DISTINCT FROM 'entry'
         OR li.user_id IS DISTINCT FROM a.user_id
         OR li.amount IS DISTINCT FROM v_h.ticket_cost
         OR li.prize_part IS DISTINCT FROM v_h.target_buy_in
         OR li.bounty_part IS DISTINCT FROM 0
         OR li.fee_part IS DISTINCT FROM v_h.target_fee
         OR li.registration_id IS DISTINCT FROM a.registration_id
         OR li.wallet_journal_id IS DISTINCT FROM lo.wallet_journal_id
         OR c.id IS NULL
         OR c.user_id IS DISTINCT FROM a.user_id
         OR c.purpose IS DISTINCT FROM 'tournament_entry'
         OR c.target_id IS DISTINCT FROM v_h.target_id
         OR c.entry_key IS DISTINCT FROM 'entry:' || a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)
  ) OR (SELECT count(*) FROM public.poker_diamond_tournament_ledger lo
         WHERE lo.tournament_id = p_tournament_id
           AND lo.kind = 'prize'
           AND lo.idempotency_key LIKE 'poker-tournament-seat-out:tourney:'
                                       || p_tournament_id::text || ':seat:%')
       <> v_h.seat_count) THEN
    RAISE EXCEPTION 'satellite % has malformed or extra Diamond seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF NOT v_diamond AND (EXISTS (
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
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text
         -- A bounty seat's leg names its exact split; a plain seat's never does.
         OR l.metadata->>'entry_split_version' IS DISTINCT FROM
              (CASE WHEN v_entry_bounty > 0 THEN '2' END)
         OR (v_entry_bounty > 0 AND (
              (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM v_entry_prize
           OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM v_entry_bounty
           OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee)))
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count) THEN
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
  IF NOT v_diamond AND (v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
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
     )) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);
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
         WHEN EXISTS(SELECT 1 FROM public.tournament_satellite_awards a WHERE a.tournament_id=p_tournament_id AND a.user_id=tp.user_id) THEN v_h.ticket_cost
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
  IF v_diamond THEN
    -- DIAMOND PHASE 9: a Diamond satellite's fee is its fee bank, settled to
    -- the house, not a rake_records sum.
    SELECT e.fee_balance + e.fee_out INTO v_rake
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
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
           'award_slot', a.place,
           'position', (SELECT tp.position FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id AND tp.user_id=a.user_id),
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
           'award_slot', a.place,
           'position', (SELECT tp.position FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id AND tp.user_id=a.user_id),
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'qualifier_ids', v_h.qualifier_ids,
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
CREATE OR REPLACE FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(p_tournament_id uuid, p_ticket_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_value_ticket boolean:=false;
  v_diamond_value boolean:=false;
  v_diamond_receipt jsonb;
  v_t public.tournaments%ROWTYPE;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_split record;
  v_username text;
  v_registration_id uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_entitlement_id uuid;
  v_resolved_club uuid;
  v_is_bounty boolean;
  v_late_open boolean:=false;
  v_start_chips integer:=0;
  v_seat jsonb;
  v_seat_reason text;
  v_players_before integer;
  v_wallet_rows_before bigint;
  v_wallet_rows_after bigint;
  v_rows integer;
  v_key text;
  v_ticket_use_token uuid:=gen_random_uuid();
  v_previous_ticket_use_token text:=
    current_setting('app.ca_satellite_ticket_use_token',true);
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  IF v_ticket.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_ticket.redemption_mode IS DISTINCT FROM 'tournament_entry_only' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_is_wallet_only');
  END IF;

  v_value_ticket:=public.fn_ca_satellite_value_ticket_marked(v_ticket.id);
  IF v_value_ticket THEN
    v_diamond_value:=public.fn_ca_assert_satellite_value_ticket(v_ticket.id)='diamonds';
    IF public.fn_poker_diamond_tournament(p_tournament_id) IS DISTINCT FROM v_diamond_value THEN
      RETURN jsonb_build_object('ok',false,'reason','ticket_asset_mismatch');
    END IF;
  ELSE
  IF v_ticket.source_refund_entitlement_id IS NOT NULL THEN
    SELECT count(*) INTO v_rows
      FROM public.tournament_refund_entitlements source_e
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key='tourney:'
             ||source_e.tournament_id::text
             ||':satellite-ticket-return:'||source_e.id::text
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_e.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
     WHERE source_e.id=v_ticket.source_refund_entitlement_id
       AND v_ticket.source_satellite_award_place IS NULL
       AND source_e.user_id=v_uid
       AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND source_e.gross=v_ticket.value
       AND source_e.refund_prize=v_ticket.entry_prize
       AND source_e.refund_bounty=v_ticket.entry_bounty
       AND source_e.refund_fee=v_ticket.entry_fee
       AND source_e.source_satellite_id=v_ticket.source_satellite_id
       AND source_e.tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=source_e.id)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1;
  ELSE
    -- A cap-blocked satellite winner never held a target registration, so its
    -- noncash ticket is sourced directly by the immutable satellite award.
    SELECT count(*) INTO v_rows
      FROM public.tournament_satellite_awards source_a
      JOIN public.tournament_satellite_settlements source_h
        ON source_h.tournament_id=source_a.tournament_id
      JOIN public.tournament_payouts source_p ON source_p.id=source_a.payout_id
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key=source_a.idempotency_key||':ticket_escrow'
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_a.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
       AND issue_l.tournament_id=source_a.tournament_id
       AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
       AND issue_l.metadata->>'ticket_id'=v_ticket.id::text
       AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
       AND issue_l.metadata->>'satellite_target_id'=
             v_ticket.source_tournament_id::text
       AND issue_l.metadata->>'user_id'=source_a.user_id::text
       AND COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text
     WHERE source_a.tournament_id=v_ticket.source_satellite_id
       AND source_a.place=v_ticket.source_satellite_award_place
       AND source_a.user_id=v_uid
       AND source_a.delivery_kind='ticket'
       AND source_a.ticket_id=v_ticket.id
       AND source_a.amount=v_ticket.value
       AND source_a.payout_source='satellite_ticket'
       AND source_p.tournament_id=source_a.tournament_id
       AND source_p.user_id=source_a.user_id
       AND (source_p."position"=source_a.place OR source_h.receipt_version>=3)
       AND source_p.amount=source_a.amount
       AND source_p.source=source_a.payout_source
       AND source_p.idempotency_key=source_a.idempotency_key
       AND source_h.target_id=v_ticket.source_tournament_id
       AND source_h.ticket_cost=v_ticket.value
       -- A bounty target's seat ticket carries its bounty slice: the
       -- target's buy-in is the ticket's prize plus bounty (2026-10-16).
       AND source_h.target_buy_in=round(v_ticket.entry_prize+v_ticket.entry_bounty,2)
       AND source_h.target_fee=v_ticket.entry_fee
       AND p_tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.wallet_credit_idempotency wallet_key
          WHERE wallet_key.key=source_a.idempotency_key)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'source_tournament_id'=
                     p_tournament_id::text
               AND issue_tx.metadata->>'source_satellite_id'=source_a.tournament_id::text
               AND issue_tx.metadata->>'source_award_place'=source_a.place::text
               AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
               AND issue_tx.metadata->>'idempotency_key'=
                     source_a.idempotency_key)=1;
  END IF;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket has no exact noncash issue evidence'
      USING ERRCODE='P0404';
  END IF;

  END IF;

  IF v_ticket.status='redeemed' THEN
    IF v_diamond_value THEN
      SELECT jsonb_build_object('ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',l.registration_id,'ledger_id',l.id,'asset','diamonds','wallet_chips_credited',0)
        INTO v_diamond_receipt FROM public.poker_diamond_tournament_ledger l
       WHERE l.idempotency_key='poker-value-ticket-entry:'||v_ticket.id::text
         AND l.tournament_id=p_tournament_id AND l.user_id=v_uid AND l.amount=v_ticket.value
         AND l.kind='entry' AND l.request->>'ticket_id'=v_ticket.id::text;
      RETURN coalesce(v_diamond_receipt,jsonb_build_object('ok',false,'reason','ticket_already_used'));
    END IF;
    SELECT count(*),min(e.id::text)::uuid,min(e.registration_id::text)::uuid
      INTO v_rows,v_entitlement_id,v_registration_id
      FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
     WHERE e.source_ticket_id=v_ticket.id
       AND e.entitlement_kind='tournament_ticket'
       AND e.tournament_id=p_tournament_id
       AND e.user_id=v_uid
       AND tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id;
    IF v_rows=1 AND v_entitlement_id IS NOT NULL
       AND v_registration_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',v_registration_id,
        'entitlement_id',v_entitlement_id,'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_ticket.status<>'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND (lower(COALESCE(v_t.variant,''))='spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players>0 AND v_t.max_players<=2)) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
  END IF;
  IF v_t.status='RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id)
                 AND NOT COALESCE(v_t.prize_pool_finalized,false);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
  END IF;
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_full');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','already_registered');
  END IF;

  IF NOT v_diamond_value AND NOT EXISTS(
    SELECT 1 FROM public.club_members m
     WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
       AND COALESCE(m.status,'active') IN ('active','approved')) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  IF v_t.union_id IS NULL AND v_t.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_mismatch');
  END IF;
  IF v_t.union_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id AND NOT EXISTS(
    SELECT 1 FROM public.union_clubs uc
     WHERE uc.union_id=v_t.union_id AND uc.club_id=v_ticket.club_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_union_mismatch');
  END IF;
  IF v_diamond_value THEN
    IF NOT public.fn_ca_entry_scope_ok(v_uid,v_ticket.club_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','ticket_arena_profile_unavailable');
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.ca_arena_settings a WHERE a.id=1 AND a.club_id=v_ticket.club_id AND a.tournaments_enabled) THEN
      RETURN jsonb_build_object('ok',false,'reason','diamond_tournaments_closed');
    END IF;
    v_resolved_club:=v_ticket.club_id;
  ELSE
    v_resolved_club:=public.fn_tournament_club_for_user(v_uid,p_tournament_id,v_ticket.club_id);
  END IF;
  IF v_resolved_club IS DISTINCT FROM v_ticket.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  IF COALESCE(v_t.authorized_to_register,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_registration_approvals a
        WHERE a.tournament_id=p_tournament_id AND a.user_id=v_uid)
     AND NOT public.is_club_admin(v_ticket.club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized_to_register');
  END IF;
  IF COALESCE(v_t.is_vip_only,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.profiles pr
        WHERE pr.id=v_uid AND COALESCE(pr.is_vip,false)
          AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at>now()))
     AND NOT EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
          AND m.role IN ('owner','co_owner','admin','agent')) THEN
    RETURN jsonb_build_object('ok',false,'reason','vip_only');
  END IF;

  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<=0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2)
     OR v_ticket.value IS DISTINCT FROM v_split.charge
     OR (NOT v_value_ticket AND (v_ticket.entry_prize IS DISTINCT FROM v_split.prize
       OR v_ticket.entry_bounty IS DISTINCT FROM v_split.bounty
       OR v_ticket.entry_fee IS DISTINCT FROM v_split.rake)) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;

  IF COALESCE(v_t.early_bird_enabled,false)
     AND now()<v_t.start_time AND COALESCE(v_t.early_bird_chips,0)>0 THEN
    v_start_chips:=v_t.early_bird_chips;
  END IF;
  SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),'Player')
    INTO v_username FROM public.profiles p WHERE p.id=v_uid;
  v_username:=COALESCE(v_username,'Player');

  IF v_diamond_value THEN
    INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,current_bounty,
      mystery_bounty_value,bounties_collected,bounty_winnings,club_id,is_satellite_qualifier,source_satellite_id)
    VALUES(p_tournament_id,v_uid,v_username,v_start_chips,'registered',0,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
    RETURNING id INTO v_registration_id;
    v_diamond_receipt:=public.fn_ca_diamond_value_ticket_fund_entry(p_tournament_id,v_ticket.id,v_registration_id);
  ELSE
  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'ticket admission prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  SELECT count(*) INTO v_wallet_rows_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     -- A running bounty event's bank is its pool less what knockouts have
     -- already paid from it, so a late ticket seat compares against that
     -- (2026-10-16), as both settlement authorities do.
     OR v_escrow_before.bounty_balance IS DISTINCT FROM
          round(COALESCE(v_t.bounty_pool,0)-COALESCE(v_t.bounty_pool_paid,0),2)
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance THEN
    RAISE EXCEPTION 'ticket admission found divergent tournament escrow'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,username,chips,status,current_bounty,
    mystery_bounty_value,bounties_collected,bounty_winnings,
    club_id,is_satellite_qualifier,source_satellite_id)
  VALUES(
    p_tournament_id,v_uid,v_username,v_start_chips,'registered',
    v_split.bounty,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
  RETURNING id INTO v_registration_id;

  v_key:='ticket:'||v_ticket.id::text||':tournament:'
         ||p_tournament_id::text||':entry';
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    v_uid,'escrow',v_ticket.id,'tournament entry ticket',
    'prize_liability',p_tournament_id,'tournaments escrow',
    v_ticket.value,'ticket_redeem',v_ticket.club_id,p_tournament_id,
    v_key,'ticket-entry:'||v_ticket.id::text,
    'fn_register_for_tournament_with_ticket',
    'Tournament-entry ticket committed to tournament admission',
    jsonb_build_object(
      'kind','tournament_entry_ticket_admission','ticket_id',v_ticket.id,
      'user_id',v_uid,'registration_id',v_registration_id,
      'source_tournament_id',v_ticket.source_tournament_id,
      'source_satellite_id',v_ticket.source_satellite_id,
      'entry_prize',v_split.prize,
      'entry_bounty',v_split.bounty,'entry_fee',v_split.rake),
    v_ticket.value,0,
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance,2),
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance+v_ticket.value,2))
  RETURNING id INTO v_ledger_id;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'tournament-entry ticket admission',
    p_gross_in=>v_ticket.value,p_bounty_in=>v_split.bounty);
  IF v_split.rake>0 THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_ticket.club_id,v_split.rake,v_ticket.value,1,
      0,true,p_tournament_id,'fn_register_for_tournament_with_ticket',
      jsonb_build_object(
        'kind','tournament_ticket_entry_fee','user_id',v_uid,
        'registration_id',v_registration_id,'ticket_id',v_ticket.id));
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before+1,
         prize_pool=round(v_t.prize_pool+v_split.prize,2),
         bounty_pool=round(v_t.bounty_pool+v_split.bounty,2),
         total_rake=round(v_t.total_rake+v_split.rake,2),
         updated_at=now()
   WHERE id=p_tournament_id
     -- Before the start the canonical roster trigger has already counted
     -- the row inserted above. A RUNNING field is not counted on INSERT
     -- (20260922141704): this door publishes that count itself, as the
     -- wallet doors do. Expect exactly the state the trigger left.
     AND current_players IS NOT DISTINCT FROM CASE
       WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
       ELSE v_players_before
     END
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket admission tournament cache changed'
      USING ERRCODE='55000';
  END IF;

  END IF;

  INSERT INTO public.tournament_ticket_admission_authorizations(
    token,ticket_id,tournament_id,user_id,registration_id)
  VALUES(
    v_ticket_use_token,v_ticket.id,p_tournament_id,v_uid,v_registration_id);

  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_ticket_use_token::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_ticket.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',
    COALESCE(v_previous_ticket_use_token,''),true);
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket changed during admission'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_ticket_admission_authorizations a
     WHERE a.token=v_ticket_use_token) THEN
    RAISE EXCEPTION
      'tournament-entry ticket authorization was not consumed by admission'
      USING ERRCODE='P0404';
  END IF;

  IF NOT v_diamond_value THEN
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    source_ticket_id,escrow_bucket,evidence_kind,created_at)
  VALUES(
    p_tournament_id,v_uid,'tournament_ticket','tournament_ticket',
    v_ticket.club_id,v_ticket.value,v_split.prize,
    v_split.bounty,v_split.rake,v_ledger_id,
    v_registration_id,v_ticket.source_satellite_id,NULL,v_ticket.id,
    'ticket_gross','atomic_tournament_ticket',transaction_timestamp())
  RETURNING id INTO v_entitlement_id;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_ticket.club_id,v_uid,NULL,v_ticket.value,
    'tournament_ticket_entry','Tournament-Entry Ticket Used',NULL,
    jsonb_build_object(
      'ticket_id',v_ticket.id,'holder_id',v_uid,
      'target_tournament_id',p_tournament_id,
      'registration_id',v_registration_id,
      'entitlement_id',v_entitlement_id,'ledger_id',v_ledger_id,
      'idempotency_key',v_key,'wallet_chips_credited',0))
  RETURNING id INTO v_tx_id;

  END IF;

  IF v_late_open THEN
    BEGIN
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,0);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    END;
    v_seat_reason:=v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean,false)
       AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,0);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
      v_seat_reason:=v_seat->>'reason';
      IF NOT COALESCE((v_seat->>'ok')::boolean,false)
         AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
        RAISE EXCEPTION
          'Late ticket admission could not seat the player (%)',
          COALESCE(v_seat_reason,'unknown') USING ERRCODE='55000';
      END IF;
    END IF;
    -- The wake reasons are a closed list (fn_emit_tournament_manager_wake
    -- and tournament_manager_wakes_reason_check); the engine acts on
    -- 'late_registration'. A reason outside it rolled back every late
    -- ticket entry (20261012).
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_registration');
  END IF;

  IF NOT v_diamond_value THEN
  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_wallet_rows_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_after.prize_balance IS DISTINCT FROM
       round(v_escrow_before.prize_balance+v_split.prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
       round(v_escrow_before.bounty_balance+v_split.bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
       round(v_escrow_before.fee_balance+v_split.rake,2)
     OR v_wallet_rows_after IS DISTINCT FROM v_wallet_rows_before THEN
    RAISE EXCEPTION 'ticket admission did not preserve exact noncash rails'
      USING ERRCODE='P0404';
  END IF;

  END IF;
  IF v_value_ticket THEN PERFORM public.fn_ca_assert_satellite_value_ticket(v_ticket.id); END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'registration_id',v_registration_id,'entitlement_id',v_entitlement_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'ticket_value',v_ticket.value,'wallet_chips_credited',0,
    'prize_contribution',v_split.prize,
    'bounty_contribution',v_split.bounty,
    'fee_contribution',v_split.rake,'late_registration',v_late_open,
    'seat',v_seat)||CASE WHEN v_diamond_value THEN v_diamond_receipt ELSE '{}'::jsonb END;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_is_bounty boolean;
  v_candidate_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','ticket_id',NULL);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;

  -- A marked value award is eligible by full price and native asset; its
  -- original target fields remain immutable provenance, not a destination bind.
  SELECT tk.* INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid AND tk.status='issued' AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge AND public.fn_ca_satellite_value_ticket_marked(tk.id)
     AND public.fn_poker_diamond_tournament(tk.source_satellite_id)
         IS NOT DISTINCT FROM public.fn_poker_diamond_tournament(p_tournament_id)
     AND public.fn_ca_cashier_ticket_target_in_club(p_tournament_id,tk.club_id)
     AND ((public.fn_poker_diamond_tournament(p_tournament_id) AND public.fn_ca_entry_scope_ok(v_uid,tk.club_id))
       OR (EXISTS(SELECT 1 FROM public.club_members m WHERE m.user_id=v_uid AND m.club_id=tk.club_id
       AND coalesce(m.status,'active') IN ('active','approved'))
       AND public.fn_tournament_club_for_user(v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id))
   ORDER BY tk.created_at,tk.id LIMIT 1;
  IF FOUND THEN
    PERFORM public.fn_ca_assert_satellite_value_ticket(v_ticket.id);
    RETURN jsonb_build_object('ok',true,'ticket_id',v_ticket.id,'ticket_value',v_ticket.value,
      'ticket_kind','satellite_value_ticket','ticket_contract','same_value_entry_v1');
  END IF;

  -- Presence and validity are separate facts. If an exact-price ticket exists
  -- but its issue proof or scope is unreadable, do not erase it through an
  -- inner join and silently charge the wallet instead.
  SELECT count(*) INTO v_candidate_count
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND (tk.source_refund_entitlement_id IS NOT NULL
          OR tk.source_tournament_id=p_tournament_id)
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id;

  SELECT tk.* INTO v_ticket
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id
     AND (
       (tk.source_refund_entitlement_id IS NOT NULL
        AND tk.source_satellite_award_place IS NULL
        AND EXISTS(
          SELECT 1
            FROM public.tournament_refund_entitlements source_e
            JOIN public.chip_ledger issue_l
              ON issue_l.idempotency_key='tourney:'
                   ||source_e.tournament_id::text
                   ||':satellite-ticket-return:'||source_e.id::text
             AND issue_l.from_type='prize_liability'
             AND issue_l.from_entity_id=source_e.tournament_id
             AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
             AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
             AND issue_l.category='ticket_issue'
           WHERE source_e.id=tk.source_refund_entitlement_id
             AND source_e.user_id=v_uid
             AND source_e.entitlement_kind IN
                   ('satellite_seat','tournament_ticket')
             AND source_e.gross=tk.value
             AND source_e.refund_prize=tk.entry_prize
             AND source_e.refund_bounty=tk.entry_bounty
             AND source_e.refund_fee=tk.entry_fee
             AND source_e.source_satellite_id=tk.source_satellite_id
             AND source_e.tournament_id=tk.source_tournament_id
             AND NOT EXISTS(
               SELECT 1 FROM public.tournament_refund_tranches tr
                WHERE tr.entitlement_id=source_e.id)
             AND (SELECT count(*)
                    FROM public.chip_transactions issue_tx
                   WHERE issue_tx.transaction_type='tournament_ticket_issue'
                     AND issue_tx.club_id=tk.club_id
                     AND issue_tx.from_user_id IS NULL
                     AND issue_tx.to_user_id=v_uid
                     AND issue_tx.amount=tk.value
                     AND issue_tx.metadata->>'ticket_id'=tk.id::text
                     AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
                     AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1))
       OR
       (tk.source_refund_entitlement_id IS NULL
        AND tk.source_satellite_award_place IS NOT NULL
        AND tk.source_tournament_id=p_tournament_id
        AND EXISTS(
          SELECT 1
            FROM public.tournament_satellite_awards source_a
            JOIN public.tournament_satellite_settlements source_h
              ON source_h.tournament_id=source_a.tournament_id
             AND source_h.target_id=p_tournament_id
            JOIN public.tournament_payouts source_p
              ON source_p.id=source_a.payout_id
             AND source_p.tournament_id=source_a.tournament_id
             AND source_p.user_id=source_a.user_id
             AND (source_p."position"=source_a.place OR source_h.receipt_version>=3)
             AND source_p.amount=source_a.amount
             AND source_p.source=source_a.payout_source
             AND source_p.idempotency_key=source_a.idempotency_key
            JOIN public.chip_ledger issue_l
              ON issue_l.idempotency_key=source_a.idempotency_key
                                            ||':ticket_escrow'
             AND issue_l.from_type='prize_liability'
             AND issue_l.from_entity_id=source_a.tournament_id
             AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
             AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
             AND issue_l.category='ticket_issue'
             AND issue_l.tournament_id=source_a.tournament_id
             AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
             AND issue_l.metadata->>'ticket_id'=tk.id::text
             AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
             AND issue_l.metadata->>'satellite_target_id'=
                   p_tournament_id::text
             AND issue_l.metadata->>'user_id'=source_a.user_id::text
             AND COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text
           WHERE source_a.tournament_id=tk.source_satellite_id
             AND source_a.place=tk.source_satellite_award_place
             AND source_a.user_id=v_uid
             AND source_a.delivery_kind='ticket'
             AND source_a.ticket_id=tk.id
             AND source_a.amount=tk.value
             AND source_a.payout_source='satellite_ticket'
             AND source_h.ticket_cost=tk.value
             -- A bounty target's seat ticket carries its bounty slice: the
             -- target's buy-in is the ticket's prize plus bounty (2026-10-16).
             AND source_h.target_buy_in=round(tk.entry_prize+tk.entry_bounty,2)
             AND source_h.target_fee=tk.entry_fee
             AND NOT EXISTS(
               SELECT 1 FROM public.wallet_credit_idempotency wallet_key
                WHERE wallet_key.key=source_a.idempotency_key)
             AND (SELECT count(*)
                    FROM public.chip_transactions issue_tx
                   WHERE issue_tx.transaction_type='tournament_ticket_issue'
                     AND issue_tx.club_id=tk.club_id
                     AND issue_tx.from_user_id IS NULL
                     AND issue_tx.to_user_id=v_uid
                     AND issue_tx.amount=tk.value
                     AND issue_tx.metadata->>'ticket_id'=tk.id::text
                     AND issue_tx.metadata->>'source_tournament_id'=
                           p_tournament_id::text
                     AND issue_tx.metadata->>'source_satellite_id'=
                           source_a.tournament_id::text
                     AND issue_tx.metadata->>'source_award_place'=
                           source_a.place::text
                     AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
                     AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
                     AND issue_tx.metadata->>'idempotency_key'=
                           source_a.idempotency_key)=1))
     )
   ORDER BY tk.created_at,tk.id
   LIMIT 1;

  IF v_ticket.id IS NULL THEN
    IF v_candidate_count>0 THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','matching_tournament_ticket_unavailable',
        'ticket_id',NULL);
    END IF;
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'ticket_id',v_ticket.id,'ticket_value',v_ticket.value,
    'entry_prize',v_ticket.entry_prize,
    'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee,
    'source_satellite_id',v_ticket.source_satellite_id);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_horse_tournament_entry_ticket_hints(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_is_bounty boolean;
  v_holder_ids jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament id is required' USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','holder_ids','[]'::jsonb);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'holder_ids','[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.holder_id ORDER BY candidate.holder_id),
                  '[]'::jsonb)
    INTO v_holder_ids
    FROM (
      SELECT tk.holder_id
        FROM public.tournament_tickets tk
        JOIN public.profiles p ON p.id=tk.holder_id
       WHERE COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.redemption_mode='tournament_entry_only'
         AND tk.value=v_split.charge
         AND tk.entry_prize=v_split.prize
         AND tk.entry_bounty=v_split.bounty
         AND tk.entry_fee=v_split.rake
         AND (tk.source_refund_entitlement_id IS NOT NULL
              OR tk.source_tournament_id=p_tournament_id)
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
         AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
           SELECT 1 FROM public.union_clubs uc
            WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
      UNION
      -- 20261015132042: a horse holding a cashier ticket bound to this
      -- tournament is steered to it exactly as a satellite ticket holder is.
      SELECT b.holder_id
        FROM public.tournament_ticket_entry_targets b
        JOIN public.tournament_tickets tk ON tk.id=b.ticket_id
        JOIN public.profiles p ON p.id=b.holder_id
       WHERE b.tournament_id=p_tournament_id
         AND COALESCE(p.is_horse,false)
         AND tk.status='issued'
         AND tk.holder_id=b.holder_id
         AND b.value=v_split.charge
         AND b.entry_prize=v_split.prize
         AND b.entry_bounty=v_split.bounty
         AND b.entry_fee=v_split.rake
         AND EXISTS(
           SELECT 1 FROM public.club_members m
            WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
              AND COALESCE(m.status,'active') IN ('active','approved'))
         AND public.fn_tournament_club_for_user(
               tk.holder_id,p_tournament_id,tk.club_id)
               IS NOT DISTINCT FROM tk.club_id
      UNION
      SELECT tk.holder_id FROM public.tournament_tickets tk
      JOIN public.profiles p ON p.id=tk.holder_id
      WHERE p.is_horse IS TRUE AND tk.status='issued'
        AND tk.redemption_mode='wallet_chips' AND tk.value=v_split.charge
        AND tk.source_tournament_id IS NULL AND tk.source_refund_entitlement_id IS NULL
        AND public.fn_ca_tournament_unit_cents(p_tournament_id)=1
        AND NOT EXISTS (SELECT 1 FROM public.tournament_ticket_entry_targets b WHERE b.ticket_id=tk.id)
        AND EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
                      AND COALESCE(m.status,'active') IN ('active','approved'))
        AND public.fn_tournament_club_for_user(tk.holder_id,p_tournament_id,tk.club_id)
              IS NOT DISTINCT FROM tk.club_id
      UNION
      SELECT tk.holder_id FROM public.tournament_tickets tk JOIN public.profiles p ON p.id=tk.holder_id
       WHERE p.is_horse IS TRUE AND tk.status='issued' AND tk.redemption_mode='tournament_entry_only'
         AND tk.value=v_split.charge AND public.fn_ca_satellite_value_ticket_marked(tk.id)
         AND public.fn_poker_diamond_tournament(tk.source_satellite_id)
             IS NOT DISTINCT FROM public.fn_poker_diamond_tournament(p_tournament_id)
         AND public.fn_ca_cashier_ticket_target_in_club(p_tournament_id,tk.club_id)
         AND ((public.fn_poker_diamond_tournament(p_tournament_id) AND public.fn_ca_entry_scope_ok(tk.holder_id,tk.club_id))
           OR (EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=tk.club_id AND m.user_id=tk.holder_id
           AND coalesce(m.status,'active') IN ('active','approved'))
           AND public.fn_tournament_club_for_user(tk.holder_id,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id))
    ) candidate;
  RETURN jsonb_build_object('ok',true,'holder_ids',v_holder_ids);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(p_ticket_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tk public.tournament_tickets%ROWTYPE;
  v_award public.tournament_satellite_awards%ROWTYPE;
  v_key text;
  v_source text := lower(btrim(COALESCE(p_source,'')));
  v_context jsonb;
  v_setting text;
  v_before numeric;
  v_after numeric;
  v_issue_leg uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_rows integer;
BEGIN
  IF public.fn_ca_satellite_value_ticket_marked(p_ticket_id) THEN
    PERFORM public.fn_ca_assert_satellite_value_ticket(p_ticket_id);
    RETURN jsonb_build_object('ok',true,'paid',false,'reason','value_ticket_remains_reusable');
  END IF;
  /* A SATELLITE SEAT IS SEAT OR CASH (2026-10-12). Every direct satellite
     award is a seat_or_cash entitlement. fn_ca_settle_satellite_cohort pays a
     winner whose target is closed in cash at the finish; a winner at the
     four-table cap while the target is still open is held a noncash ticket
     for that one target instead. When that target closes before the ticket is
     used, the ticket can never admit anybody again, so its cash leg applies:
     the escrowed value goes to the holder's wallet in the ticket's own club,
     once, keyed by the ticket. Horses are players and are paid exactly so. */
  IF p_ticket_id IS NULL OR v_source='' THEN
    RAISE EXCEPTION 'closed target ticket cash needs a ticket and a source'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_tk FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found',
      'ticket_id',p_ticket_id);
  END IF;
  v_key:='ticket:'||v_tk.id::text||':closed-target-cash';

  IF v_tk.status='redeemed' THEN
    SELECT l.id INTO v_ledger_id
      FROM public.chip_ledger_idem i JOIN public.chip_ledger l ON l.id=i.leg_id
     WHERE i.idempotency_key=v_key;
    IF v_ledger_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok',true,'replayed',true,
        'ticket_id',v_tk.id,'ledger_id',v_ledger_id,'amount',v_tk.value);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used',
      'ticket_id',v_tk.id);
  END IF;
  IF v_tk.status IS DISTINCT FROM 'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_issued',
      'ticket_id',v_tk.id);
  END IF;
  IF v_tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
     OR v_tk.source_satellite_award_place IS NULL
     OR v_tk.source_refund_entitlement_id IS NOT NULL
     OR v_tk.source_tournament_id IS NULL
     OR v_tk.source_satellite_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason',
      'not_a_direct_satellite_ticket','ticket_id',v_tk.id);
  END IF;
  IF NOT public.fn_ca_satellite_ticket_target_is_closed(
           v_tk.source_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_still_admits',
      'ticket_id',v_tk.id);
  END IF;

  -- The value being paid is exactly what the satellite escrowed for this
  -- award: the immutable award row and its one issue leg.
  SELECT * INTO v_award FROM public.tournament_satellite_awards a
   WHERE a.tournament_id=v_tk.source_satellite_id
     AND a.place=v_tk.source_satellite_award_place
     AND a.ticket_id=v_tk.id AND a.delivery_kind='ticket'
     AND a.user_id=v_tk.holder_id AND a.amount=v_tk.value;
  IF v_award.tournament_id IS NULL THEN
    RAISE EXCEPTION 'satellite ticket % has no exact award row',v_tk.id
      USING ERRCODE='P0404';
  END IF;
  SELECT l.id INTO v_issue_leg
    FROM public.chip_ledger_idem i JOIN public.chip_ledger l ON l.id=i.leg_id
   WHERE i.idempotency_key=v_award.idempotency_key||':ticket_escrow'
     AND l.from_type='prize_liability'
     AND l.from_entity_id=v_tk.source_satellite_id
     AND l.to_type='escrow' AND l.to_entity_id=v_tk.id
     AND l.amount=v_tk.value AND l.club_id=v_tk.club_id
     AND l.category='ticket_issue';
  IF v_issue_leg IS NULL THEN
    RAISE EXCEPTION 'satellite ticket % has no exact escrow issue leg',v_tk.id
      USING ERRCODE='P0404';
  END IF;

  SELECT m.chip_balance INTO v_before FROM public.club_members m
   WHERE m.club_id=v_tk.club_id AND m.user_id=v_tk.holder_id
     AND COALESCE(m.status,'active') IN ('active','approved')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason',
      'holder_not_a_member_of_ticket_club','ticket_id',v_tk.id);
  END IF;
  v_before:=COALESCE(v_before,0);

  SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),''))
    INTO v_context
    FROM unnest(ARRAY[
      'app.ledger_category','app.ledger_counterparty',
      'app.ledger_counterparty_entity','app.ledger_counterparty_label',
      'app.ledger_tournament','app.ledger_idempotency_key',
      'app.ledger_autoskip_club_members',
      'app.ca_closed_target_ticket_cash']) settings(k);

  -- This door writes its own named leg, so the anonymous journal stands down.
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM public.fn_ca_declare_ledger(
    'ticket_redeem','escrow',v_tk.id,NULL,v_key,ARRAY['club_members']);
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'escrow',v_tk.id,'satellite tournament entry ticket',
    'player_wallet',v_tk.holder_id,'player wallet',
    v_tk.value,'ticket_redeem',v_tk.club_id,NULL,
    v_key,'ticket-cash:'||v_tk.id::text,
    'fn_ca_pay_closed_target_ticket_in_cash',
    'Satellite seat paid in cash because its target no longer takes entries',
    jsonb_build_object(
      'kind','closed_target_ticket_cash','ticket_id',v_tk.id,
      'holder_id',v_tk.holder_id,
      'source_satellite_id',v_tk.source_satellite_id,
      'source_tournament_id',v_tk.source_tournament_id,
      'award_place',v_tk.source_satellite_award_place,
      'award_idempotency_key',v_award.idempotency_key,
      'issue_ledger_id',v_issue_leg,'source',v_source),
    v_tk.value,0,v_before,round(v_before+v_tk.value,2))
  RETURNING id INTO v_ledger_id;

  UPDATE public.club_members
     SET chip_balance=round(COALESCE(chip_balance,0)+v_tk.value,2),
         updated_at=now()
   WHERE club_id=v_tk.club_id AND user_id=v_tk.holder_id
     AND COALESCE(status,'active') IN ('active','approved')
   RETURNING chip_balance INTO v_after;
  IF v_after IS DISTINCT FROM round(v_before+v_tk.value,2) THEN
    RAISE EXCEPTION 'ticket % cash credit did not land exactly',v_tk.id
      USING ERRCODE='55000';
  END IF;

  PERFORM set_config('app.ca_closed_target_ticket_cash',v_tk.id::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_tk.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket % changed while it was paid in cash',v_tk.id
      USING ERRCODE='55000';
  END IF;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_tk.club_id,NULL,v_tk.holder_id,v_tk.value,'tournament_ticket_redeem',
    'Satellite Seat Paid In Cash: Target Entry Closed',v_after,
    jsonb_build_object(
      'ticket_id',v_tk.id,'issuer_id',v_tk.issued_by,
      'holder_id',v_tk.holder_id,'escrow_action','release_to_holder',
      'reason','target_entry_closed',
      'source_tournament_id',v_tk.source_tournament_id,
      'source_satellite_id',v_tk.source_satellite_id,
      'source_award_place',v_tk.source_satellite_award_place,
      'ledger_id',v_ledger_id,'idempotency_key',v_key,
      'holder_balance_after',v_after))
  RETURNING id INTO v_tx_id;
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,balance_after)
  VALUES(
    v_tk.holder_id,'PLAYER','credit',v_tk.value,'transfer',
    'Satellite Seat Paid In Cash: Target Entry Closed',v_after);

  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_tk.id,
    'holder_id',v_tk.holder_id,'club_id',v_tk.club_id,'amount',v_tk.value,
    'target_id',v_tk.source_tournament_id,
    'satellite_id',v_tk.source_satellite_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'balance_before',v_before,'balance_after',v_after);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_pay_closed_target_tickets_in_cash(p_target_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_result jsonb;
  v_paid integer:=0;
  v_amount numeric:=0;
  v_unpaid jsonb:='[]'::jsonb;
BEGIN
  /* Runs in the transaction that closes the target, so a ticket that can no
     longer be used is paid at the moment it stops being usable. One ticket
     the door cannot pay never stops the target from closing: that ticket is
     named on a critical alert, in this same transaction, with the reason. */
  IF p_target_id IS NULL
     OR NOT public.fn_ca_satellite_ticket_target_is_closed(p_target_id) THEN
    RETURN jsonb_build_object('ok',true,'paid',0,'amount',0);
  END IF;
  FOR v_id IN
    SELECT tk.id FROM public.tournament_tickets tk
     WHERE tk.source_tournament_id=p_target_id
       AND tk.status='issued'
       AND tk.redemption_mode='tournament_entry_only'
       AND tk.source_satellite_award_place IS NOT NULL
       AND tk.source_refund_entitlement_id IS NULL
       AND NOT public.fn_ca_satellite_value_ticket_marked(tk.id)
     ORDER BY tk.id
  LOOP
    BEGIN
      v_result:=public.fn_ca_pay_closed_target_ticket_in_cash(v_id,p_source);
    EXCEPTION WHEN OTHERS THEN
      v_result:=jsonb_build_object('ok',false,'reason','refused',
        'sqlstate',SQLSTATE,'message',SQLERRM,'ticket_id',v_id);
    END;
    IF COALESCE((v_result->>'ok')::boolean,false) THEN
      IF NOT COALESCE((v_result->>'replayed')::boolean,false) THEN
        v_paid:=v_paid+1;
        v_amount:=round(v_amount+(v_result->>'amount')::numeric,2);
      END IF;
    ELSE
      v_unpaid:=v_unpaid||jsonb_build_array(v_result);
      INSERT INTO public.financial_alerts(severity,source,message,context)
      VALUES('critical','fn_ca_pay_closed_target_tickets_in_cash',
        'A Satellite Ticket For A Closed Target Could Not Be Paid In Cash',
        jsonb_build_object('target_id',p_target_id,'ticket_id',v_id,
          'result',v_result));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok',jsonb_array_length(v_unpaid)=0,
    'paid',v_paid,'amount',v_amount,'unpaid',v_unpaid);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token uuid := NULLIF(
    current_setting('app.ca_satellite_ticket_use_token',true),'')::uuid;
  v_cash_token uuid := NULLIF(
    current_setting('app.ca_closed_target_ticket_cash',true),'')::uuid;
  v_authorization public.tournament_ticket_admission_authorizations%ROWTYPE;
  v_rows integer;
BEGIN
  IF TG_OP='DELETE' AND OLD.redemption_mode='tournament_entry_only' THEN
    RAISE EXCEPTION 'tournament-entry tickets are durable financial evidence'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.redemption_mode='tournament_entry_only' THEN
    IF ROW(NEW.id,NEW.club_id,NEW.issued_by,NEW.holder_id,NEW.value,NEW.note,
           NEW.redemption_mode,NEW.source_tournament_id,
           NEW.source_satellite_id,NEW.source_refund_entitlement_id,
           NEW.source_satellite_award_place,
           NEW.entry_prize,NEW.entry_bounty,NEW.entry_fee,NEW.created_at,
           NEW.cancelled_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.club_id,OLD.issued_by,OLD.holder_id,OLD.value,OLD.note,
           OLD.redemption_mode,OLD.source_tournament_id,
           OLD.source_satellite_id,OLD.source_refund_entitlement_id,
           OLD.source_satellite_award_place,
           OLD.entry_prize,OLD.entry_bounty,OLD.entry_fee,OLD.created_at,
           OLD.cancelled_at) THEN
      RAISE EXCEPTION 'tournament-entry ticket identity and rails are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      /* A SATELLITE SEAT IS SEAT OR CASH (2026-10-12). A direct satellite
         ticket whose one target can no longer admit it is paid to its holder
         in cash by fn_ca_pay_closed_target_ticket_in_cash, and only by it:
         the transition is accepted only when that door has already written
         the exact escrow-to-wallet leg under the ticket's own key in this
         transaction and named this ticket on its token. */
      IF OLD.status='issued' AND NEW.status='redeemed'
         AND v_cash_token IS NOT NULL AND v_cash_token=OLD.id
         AND NOT public.fn_ca_satellite_value_ticket_marked(OLD.id)
         AND OLD.redeemed_at IS NULL
         AND NEW.redeemed_at=transaction_timestamp()
         AND OLD.source_satellite_award_place IS NOT NULL
         AND OLD.source_refund_entitlement_id IS NULL
         AND public.fn_ca_satellite_ticket_target_is_closed(
               OLD.source_tournament_id)
         AND (SELECT count(*)
                FROM public.chip_ledger_idem i
                JOIN public.chip_ledger l ON l.id=i.leg_id
               WHERE i.idempotency_key=
                       'ticket:'||OLD.id::text||':closed-target-cash'
                 AND l.from_type='escrow' AND l.from_entity_id=OLD.id
                 AND l.to_type='player_wallet'
                 AND l.to_entity_id=OLD.holder_id
                 AND l.amount=OLD.value AND l.club_id=OLD.club_id
                 AND l.category='ticket_redeem'
                 AND l.tournament_id IS NULL)=1 THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status='issued' AND NEW.status='redeemed'
              AND v_token IS NOT NULL
              AND OLD.redeemed_at IS NULL
              AND NEW.redeemed_at IS NOT NULL
              AND NEW.redeemed_at=transaction_timestamp()) THEN
        RAISE EXCEPTION
          'tournament-entry tickets can only be consumed by tournament admission'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO v_authorization
        FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id
       FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.user_id IS DISTINCT FROM OLD.holder_id
         OR NOT EXISTS(
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.id=v_authorization.registration_id
              AND tp.tournament_id=v_authorization.tournament_id
              AND tp.user_id=v_authorization.user_id
              AND tp.status::text IN ('registered','playing')) THEN
        RAISE EXCEPTION
          'tournament-entry ticket has no exact admission authorization'
          USING ERRCODE = '42501';
      END IF;
      DELETE FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION
          'tournament-entry ticket admission authorization was not consumed once'
          USING ERRCODE = 'P0404';
      END IF;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at THEN
      RAISE EXCEPTION
        'tournament-entry ticket redemption time is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_ticket_escrow_float()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(t.value), 0)::numeric
    FROM public.tournament_tickets t
   WHERE t.status = 'issued'
     AND NOT public.fn_poker_diamond_tournament(t.source_satellite_id);
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open')
   +(SELECT COALESCE(sum(amount),0)::numeric FROM public.ca_diamond_rake_accrual WHERE swept_at IS NULL)
   +public.fn_poker_diamond_jackpot_diamonds()
   +public.fn_ca_diamond_value_ticket_float(NULL);
$function$;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_custody_balance()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('available',p.diamonds,'in_play',
 (SELECT COALESCE(sum(c.balance),0) FROM public.poker_diamond_custody c WHERE c.user_id=p.id),
 'ticket_value',public.fn_ca_diamond_value_ticket_float(p.id))
 FROM public.profiles p WHERE p.id=auth.uid();
$function$;
CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_user       uuid := COALESCE(p_user_id, auth.uid());
    v_role       text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_on_hand    bigint;
    v_collateral bigint;
    v_in_arena   bigint;
    v_seats      integer;
    v_entries    integer;
    v_arena      record;
    v_open       integer := 0;
    v_lifetime   record;
    -- SCALARS, NOT A RECORD (2026-09-30). v_cheapest was a plpgsql `record`,
    -- and a record only acquires a tuple structure when something assigns it.
    -- Gating the scan on cash_games_enabled meant the SELECT INTO no longer ran
    -- on a closed arena, so `v_cheapest.id IS NULL` in the answer raised
    -- 55000 "record v_cheapest is not assigned yet" for every caller. Scalars
    -- are NULL from the start, which is the state the closed arena has to
    -- report anyway.
    v_seat_id    uuid;
    v_seat_name  text;
    v_seat_sb    numeric;
    v_seat_bb    numeric;
    v_seat_min   numeric;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'wallet_summary_is_own_only' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(diamonds, 0)::bigint INTO v_on_hand
      FROM public.profiles WHERE id = v_user;
    v_on_hand := COALESCE(v_on_hand, 0);

    SELECT COALESCE(SUM(GREATEST(issued - consumed - refunded - arena_reserved, 0)), 0)::bigint
      INTO v_collateral
      FROM public.diamond_purchase_lots WHERE user_id = v_user;

    SELECT COALESCE(SUM(balance), 0)::bigint,
           COUNT(*) FILTER (WHERE purpose = 'cash_seat')::integer,
           COUNT(*) FILTER (WHERE purpose = 'tournament_entry')::integer
      INTO v_in_arena, v_seats, v_entries
      FROM public.poker_diamond_custody
     WHERE user_id = v_user AND state <> 'released';

    SELECT c.id, c.name, c.slug, a.cash_games_enabled, a.tournaments_enabled
      INTO v_arena
      FROM public.ca_arena_settings a
      JOIN public.clubs c ON c.id = a.club_id
     WHERE a.id = 1 AND c.asset = 'diamonds' AND c.is_platform IS TRUE;

    -- THE PLATE MAY NOT CONTRADICT THE SWITCH (2026-09-30). These three fields
    -- used to be computed whatever cash_games_enabled said, so a closed arena
    -- still reported 17 open tables and a named 80-Diamond seat. The switch is
    -- the authority: it is what fn_poker_diamond_buyin and fn_poker_diamond_top_up
    -- enforce, and while it is false every one of those tables refuses a buy-in.
    -- Closed therefore means open_cash_tables 0, min_cash_buy_in NULL and
    -- cheapest_table NULL, and the scan does not run at all.
    IF v_arena.id IS NOT NULL AND COALESCE(v_arena.cash_games_enabled, false) THEN
        -- The cheapest seat a player could actually take: the same predicate
        -- fn_poker_diamond_buyin admits on, so this number is never a seat
        -- that function would refuse.
        SELECT t.id, t.name, t.small_blind, t.big_blind, t.min_buy_in,
               COUNT(*) OVER ()::integer
          INTO v_seat_id, v_seat_name, v_seat_sb, v_seat_bb, v_seat_min, v_open
          FROM public.tables t
         WHERE t.club_id = v_arena.id
           AND t.game_variant = 'nlh'
           AND t.tournament_id IS NULL
           AND t.cluster_id IS NULL
           AND NOT COALESCE(t.is_template, false)
           AND t.status IN ('waiting', 'running', 'playing', 'active')
           AND COALESCE(t.rake_percent, 0) = 0 AND COALESCE(t.bbj_percent, 0) = 0
           AND NOT COALESCE(t.insurance_enabled, false) AND NOT COALESCE(t.bomb_pot_enabled, false)
           AND NOT COALESCE(t.run_it_twice_enabled, false) AND NOT COALESCE(t.run_it_twice, false)
           AND NOT COALESCE(t.allow_run_it_twice, false) AND NOT COALESCE(t.straddle_enabled, false)
           AND NOT COALESCE(t.seven_deuce_enabled, false) AND NOT COALESCE(t.nit_game, false)
           AND NOT COALESCE(t.all_in_or_fold, false) AND NOT COALESCE(t.pineapple_holdem, false)
           AND NOT COALESCE(t.cap_enabled, false) AND NOT COALESCE(t.auto_utg_straddle, false)
           AND NOT COALESCE(t.voluntary_straddle, false)
           AND t.min_buy_in IS NOT NULL AND t.min_buy_in > 0
         ORDER BY t.min_buy_in ASC, t.big_blind ASC, t.name ASC
         LIMIT 1;
        -- No eligible table leaves v_open NULL, and a NULL count would be a
        -- figure nobody can read. Zero is the answer, and it is true.
        v_open := COALESCE(v_open, 0);
    END IF;

    SELECT * INTO v_lifetime FROM public.fn_diamond_lifetime_totals(v_user);

    RETURN jsonb_build_object(
        'user_id',        v_user,
        'on_hand',        v_on_hand,
        'collateral',     v_collateral,
        'sendable',       GREATEST(v_on_hand - v_collateral, 0),
        'in_arena',       v_in_arena,
        'ticket_value',   public.fn_ca_diamond_value_ticket_float(v_user),
        'arena_seats',    v_seats,
        'arena_entries',  v_entries,
        'arena', CASE WHEN v_arena.id IS NULL THEN NULL ELSE jsonb_build_object(
            'club_id',             v_arena.id,
            'name',                v_arena.name,
            'slug',                v_arena.slug,
            'cash_games_enabled',  COALESCE(v_arena.cash_games_enabled, false),
            'tournaments_enabled', COALESCE(v_arena.tournaments_enabled, false),
            'open_cash_tables',    v_open,
            'min_cash_buy_in',     CASE WHEN v_seat_id IS NULL THEN NULL
                                        ELSE v_seat_min::bigint END,
            'cheapest_table',      CASE WHEN v_seat_id IS NULL THEN NULL ELSE jsonb_build_object(
                'id',          v_seat_id,
                'name',        v_seat_name,
                'small_blind', v_seat_sb,
                'big_blind',   v_seat_bb
            ) END
        ) END,
        'lifetime_earned', COALESCE(v_lifetime.lifetime_earned, 0),
        'lifetime_spent',  COALESCE(v_lifetime.lifetime_spent, 0),
        'read_at',         now()
    );
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_diamond_arena_reconciliation(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_user      uuid := COALESCE(p_user_id, auth.uid());
    v_role      text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_sessions  integer := 0;
    v_open      integer := 0;
    v_buy_ins   bigint  := 0;
    v_cash_outs bigint  := 0;
    v_in_play   bigint  := 0;
    v_settled   bigint  := 0;
    v_unmatched jsonb   := '[]'::jsonb;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'arena_reconciliation_is_own_only' USING ERRCODE = '42501';
    END IF;

    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE state <> 'released')::integer,
           COALESCE(SUM(balance) FILTER (WHERE state <> 'released'), 0)::bigint
      INTO v_sessions, v_open, v_in_play
      FROM public.poker_diamond_custody
     WHERE user_id = v_user;

    SELECT COALESCE(SUM(amount) FILTER (WHERE action = 'reserve'), 0)::bigint,
           COALESCE(SUM(amount) FILTER (WHERE action = 'release'), 0)::bigint
      INTO v_buy_ins, v_cash_outs
      FROM public.poker_diamond_movements
     WHERE user_id = v_user;

    SELECT COALESCE(SUM(CASE WHEN m.action = 'release' THEN m.amount ELSE -m.amount END), 0)::bigint
      INTO v_settled
      FROM public.poker_diamond_movements m
      JOIN public.poker_diamond_custody c ON c.id = m.custody_id
     WHERE m.user_id = v_user AND c.state = 'released';

    -- A JOURNAL ROW IS RECONCILED AGAINST ALL OF ITS LEGS (20261011192722).
    -- A house leg has no journal row (20261007132503) and is excluded. Every
    -- other leg points at the journal row that recorded the wallet movement,
    -- and several legs can share one row: a tournament prize is paid from
    -- every entrant's custody in one arena_withdraw row, and a satellite
    -- seat's reserve and release net to one zero row. So the row is compared
    -- with the signed sum of every leg that points at it, whoever owns the
    -- custody; comparing one leg with the whole row reported correct payouts
    -- as mismatches to every entrant who funded them.
    WITH mine AS (
        SELECT m.wallet_journal_id AS journal_id,
               (array_agg(m.custody_id ORDER BY m.created_at, m.request_id))[1] AS custody_id,
               (array_agg(m.request_id ORDER BY m.created_at, m.request_id))[1] AS request_id,
               bool_and(m.action = 'reserve') AS all_reserve
          FROM public.poker_diamond_movements m
         WHERE m.user_id = v_user
           AND m.wallet_journal_id IS NOT NULL
           AND m.destination_account <> 'house'
           AND m.source_account NOT LIKE 'house:%'
         GROUP BY m.wallet_journal_id
    ), legs AS (
        SELECT mine.journal_id,
               SUM(CASE WHEN m.action = 'reserve' THEN -m.amount ELSE m.amount END)::bigint AS moved
          FROM mine
          JOIN public.poker_diamond_movements m ON m.wallet_journal_id = mine.journal_id
         WHERE m.destination_account <> 'house'
           AND m.source_account NOT LIKE 'house:%'
         GROUP BY mine.journal_id
    )
    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', mine.custody_id,
               'request_id', mine.request_id,
               'reason', CASE
                   WHEN j.id IS NULL THEN 'journal_missing'
                   WHEN mine.all_reserve THEN 'reserve_amount_mismatch'
                   ELSE 'release_amount_mismatch'
               END)), v_unmatched)
      INTO v_unmatched
      FROM mine
      JOIN legs ON legs.journal_id = mine.journal_id
      LEFT JOIN public.diamond_transactions j ON j.id = mine.journal_id
     WHERE j.id IS NULL OR j.amount <> legs.moved;

    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'release_movement_missing')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
     WHERE c.user_id = v_user AND c.state = 'released'
       AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m
                        WHERE m.custody_id = c.id AND m.action = 'release');

    SELECT COALESCE(v_unmatched || jsonb_agg(jsonb_build_object(
               'custody_id', c.id, 'request_id', NULL, 'reason', 'seat_stack_drift')), v_unmatched)
      INTO v_unmatched
      FROM public.poker_diamond_custody c
      JOIN public.table_seats s ON s.id = c.seat_id
     WHERE c.user_id = v_user AND c.state = 'active' AND c.purpose = 'cash_seat'
       AND s.left_at IS NULL AND s.stack IS DISTINCT FROM c.balance;

    RETURN jsonb_build_object(
        'user_id',            v_user,
        'sessions',           v_sessions,
        'open_sessions',      v_open,
        'buy_ins',            v_buy_ins,
        'cash_outs',          v_cash_outs,
        'in_play',            v_in_play,
        'ticket_value',       public.fn_ca_diamond_value_ticket_float(v_user),
        'net_result_settled', v_settled,
        'unmatched',          v_unmatched,
        'balanced',           jsonb_array_length(v_unmatched) = 0,
        'read_at',            now()
    );
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance(p_since timestamp with time zone DEFAULT (now() - '01:15:00'::interval))
 RETURNS TABLE(account text, balance_now numeric, balance_delta numeric, journal_net numeric, mint_net numeric, difference numeric, note text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_foundation constant timestamptz := timestamptz '2026-09-03 00:07:00+00';
  v_since   timestamptz := COALESCE(p_since, now() - interval '75 minutes');
  s0        public.ca_diamond_snapshots%ROWTYPE;
  w0        timestamptz;
  v_players numeric; v_house numeric; v_reg numeric; v_reg_players numeric; v_reg_house numeric;
  v_fix numeric; v_reg_fix numeric; v_fix_n bigint;
  v_delta   numeric; v_jrn numeric; v_jrn_live numeric; v_jrn_archive numeric; v_mint numeric;
  v_diff    numeric; v_note text; v_n bigint; v_sub numeric; v_tmp numeric;
  v_house_ledger numeric; v_house_ledger_total numeric;
  v_arena numeric; v_arena_fix numeric;
  v_tot_now numeric := 0; v_tot_delta numeric := 0; v_tot_jrn numeric := 0; v_tot_mint numeric := 0;
  r record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  -- A MISSED SNAPSHOT IS NOT AN UNKNOWN BALANCE, FOR ANY READER (2026-10-04). When the
  -- hourly snapshot did not land (2026-10-01 16:10 and 17:10, 2026-10-03 19:10) there is
  -- no snapshot inside the window, and every movement comparison below came back NULL.
  -- The comparisons are stock against stored stock, so the newest snapshot BEFORE the
  -- window answers the same question over a longer span, and the note names the snapshot
  -- it measured from. fn_ca_diamond_health has passed that snapshot in by hand since
  -- 2026-10-03; the hourly watch and the staff desk did not. No snapshot at all still
  -- reads unknown.
  IF s0.id IS NULL THEN
    SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at < v_since ORDER BY taken_at DESC LIMIT 1;
  END IF;
  w0 := COALESCE(s0.taken_at, v_since);

  -- ONE statement, ONE snapshot (2026-09-07 review fix 4), so a signup committing between two reads
  -- cannot show as a 500 break for one run.
  -- THE REGISTER IS READ ONCE, AND THE FIXTURE QUESTION IS ASKED ONCE PER HOLDER
  -- (2026-10-04): see fn_ca_diamond_snapshot. Three passes over the Diamond register,
  -- one of them calling fn_ca_is_fixture_account for every ledger row, are one pass
  -- netted per holder. Same rows, same sums, same SQL snapshot.
  WITH reg AS MATERIALIZED (
    SELECT m.holder_type, m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS net
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type IN ('player', 'house')
     GROUP BY m.holder_type, m.holder_id)
  SELECT (SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric FROM public.profiles p),
         (SELECT COALESCE(SUM(p.diamonds), 0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT count(*) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT COALESCE(balance, 0) FROM public.ca_diamond_house WHERE id = 1),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'player'),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'player' AND public.fn_ca_is_fixture_account(g.holder_id)),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'house'),
         public.fn_ca_mint_supply('diamonds'), public.fn_ca_arena_diamonds(),
         ((SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id)) + (SELECT COALESCE(sum(pending_diamonds),0) FROM public.diamond_spin_days WHERE status='open' AND public.fn_ca_is_fixture_account(owner_id)) + (SELECT coalesce(sum(public.fn_ca_diamond_value_ticket_float(p.id)),0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id))),
         -- The cumulative house ledger, read with the house balance (2026-10-25):
         -- see the diamond_house row below.
         (SELECT COALESCE(SUM(hl.delta), 0) FROM public.ca_diamond_house_ledger hl)
    INTO v_players, v_fix, v_fix_n, v_house, v_reg_players, v_reg_fix, v_reg_house, v_reg, v_arena, v_arena_fix,
         v_house_ledger_total;
  v_house := COALESCE(v_house, 0);

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_jrn_live FROM public.diamond_transactions dt WHERE dt.created_at >= w0 AND dt.created_at < now();
  SELECT COALESCE(SUM(a.amount), 0) INTO v_jrn_archive FROM public.ca_diamond_journal_archive a WHERE a.created_at >= w0 AND a.created_at < now();
  v_jrn := v_jrn_live + v_jrn_archive;

  -- player_diamonds: players without the fixture harness, on stored figures.
  IF s0.id IS NULL THEN
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := 'no diamond snapshot at or after the window start, so the delta is unknown';
  ELSIF s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := (v_players - v_fix) - (s0.profile_diamonds - s0.fixture_diamonds);
    v_mint  := (v_reg_players - v_reg_fix) - (s0.register_supply - COALESCE(s0.register_fixture, 0));
    v_diff  := v_delta - v_mint + (v_arena - v_arena_fix - COALESCE(s0.arena_diamonds,0) + COALESCE(s0.arena_fixture_diamonds,0));
    v_note  := 'player balances (fixtures excluded) moved ' || v_delta || ' since the ' || to_char(s0.taken_at AT TIME ZONE 'UTC', 'HH24:MI')
            || ' UTC snapshot; the player register moved ' || v_mint || ' on the same stored figures (no window skew).'
            || ' journal_net over the window is ' || v_jrn || ' (live ' || v_jrn_live || ' + archived ' || v_jrn_archive
            || '), informative: the seed trigger and the Mint house branch write no journal row.';
  ELSIF s0.register_supply IS NOT NULL THEN
    v_delta := v_players - s0.profile_diamonds;
    v_mint  := v_reg_players - s0.register_supply;
    v_diff  := v_delta - v_mint + (v_arena - COALESCE(s0.arena_diamonds,0));
    v_note  := 'transitional: the window snapshot stored the register but not the fixture split, so this row includes the certification harness. journal_net ' || v_jrn || ' informative.';
  ELSE
    v_delta := v_players - s0.profile_diamonds;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= w0 AND ml.created_at < now();
    v_diff := v_delta - v_mint + (v_arena - COALESCE(s0.arena_diamonds,0));
    v_note := 'the window snapshot predates register_supply, so the register is windowed by created_at (boundary skew possible). journal_net ' || v_jrn || ' informative.';
  END IF;
  -- balance_now must be the SAME population balance_delta is measured on, or adding this row
  -- to fixture_accounts double counts the harness (found by the verification pass, 2026-09-08).
  DECLARE v_players_shown numeric := CASE
    WHEN s0.id IS NOT NULL AND s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL
    THEN v_players - v_fix ELSE v_players END;
  BEGIN
    v_tot_now := v_tot_now + v_players_shown; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
    v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
    RETURN QUERY SELECT 'player_diamonds'::text, v_players_shown, v_delta, v_jrn, v_mint, v_diff,
      (v_note || CASE WHEN v_players_shown <> v_players
                      THEN ' balance_now is players WITHOUT the harness (' || v_fix || ' shown on the fixture_accounts row), so the two rows add up.'
                      ELSE '' END)::text;
  END;

  -- fixture_accounts: the certification harness, measured the same way, reported apart.
  IF s0.id IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := v_fix - s0.fixture_diamonds;
    v_mint  := v_reg_fix - COALESCE(s0.register_fixture, 0);
    v_diff  := v_delta - v_mint + (v_arena_fix - COALESCE(s0.arena_fixture_diamonds,0));
    v_note  := format('%s fixture profiles hold %s. Their balances moved %s and their register moved %s; a non-zero difference is the harness writing profiles.diamonds directly (DR6 at info). Never a player, never a horse.', v_fix_n, v_fix, v_delta, v_mint);
  ELSE
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := format('%s fixture profiles hold %s diamonds (inside player_diamonds). No stored fixture figure at the window start yet.', v_fix_n, v_fix);
  END IF;
  RETURN QUERY SELECT 'fixture_accounts'::text, v_fix, v_delta, NULL::numeric, v_mint, v_diff, v_note;

  -- diamond_house
  -- THE HOUSE IS READ AT ONE INSTANT AT BOTH ENDS (2026-10-25). The house balance
  -- is read in the single statement above; the Mint and the house ledger used to be
  -- summed over the window in two LATER statements, each a fresh read-committed
  -- snapshot, bucketed by created_at / at, which is the writing transaction's START
  -- time. A house mint that committed while the single statement ran was in the sum
  -- and not in the balance (2026-10-24 23:20 UTC, -16400: an overlay return started
  -- 23:20:00.073 and committed during the 78 s statement), and one that started
  -- before the window snapshot and committed after it was in the balance and not in
  -- the sum (2026-10-20 01:20 UTC, +655). Like the player row, the house row now
  -- compares figures the snapshot stored from the statement that read house_balance
  -- with figures read in the single statement above. A window snapshot taken before
  -- house_register existed keeps the windowed sums, and the note says so.
  IF s0.id IS NOT NULL AND s0.house_register IS NOT NULL THEN
    v_mint := v_reg_house - s0.house_register;
  ELSE
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now();
  END IF;
  IF s0.id IS NOT NULL AND s0.house_ledger_total IS NOT NULL THEN
    v_house_ledger := v_house_ledger_total - s0.house_ledger_total;
  ELSE
    SELECT COALESCE(SUM(delta), 0) INTO v_house_ledger FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now();
  END IF;
  IF s0.id IS NOT NULL AND s0.house_balance IS NOT NULL THEN
    v_delta := v_house - s0.house_balance; v_diff := v_delta - v_house_ledger - v_mint;
    v_note := 'house moved ' || v_delta || '; the house ledger (rake, cuts, forfeits) explains ' || v_house_ledger || ' and the Mint explains ' || v_mint || '. DR14: what leaves a player and reaches no player lands here.'
      || CASE WHEN s0.house_register IS NOT NULL AND s0.house_ledger_total IS NOT NULL
              THEN ' Both ends are stored figures, each read in one statement with its house balance (no window skew).'
              ELSE ' The window snapshot predates house_register, so the Mint and the house ledger are windowed by created_at (boundary skew possible).' END;
  ELSE
    v_delta := NULL; v_diff := NULL;
    v_note := 'no stored house balance at the window start; ledger ' || v_house_ledger || ', mint ' || v_mint || ' shown.';
  END IF;
  v_tot_now := v_tot_now + v_house; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0); v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'diamond_house'::text, v_house, v_delta, v_house_ledger, v_mint, v_diff, v_note;

  -- arena_wallets: diamonds a player has deposited onto the platform club's felt. Still theirs,
  -- still in the supply, and in neither profiles nor the house - so the identity below has to
  -- count them or a deposit reads as a break (2026-09-08).
  -- Custody was read with balances and register above.
  IF s0.id IS NOT NULL AND s0.arena_diamonds IS NOT NULL THEN
    v_delta := v_arena - s0.arena_diamonds;
  ELSE
    v_delta := NULL;
  END IF;
  v_tot_now := v_tot_now + v_arena; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  RETURN QUERY SELECT 'arena_wallets'::text, v_arena, v_delta, NULL::numeric, NULL::numeric, NULL::numeric,
    ('diamonds on the Diamond Arena felt plus signed unsettled Diamond Spin custody. A custody deposit moves them out of '
     || 'profiles.diamonds without changing the supply, so they are counted here and in the register '
     || 'identity below. The Mint issues nothing for a deposit and retires nothing for a withdrawal.')::text;

  -- register: the identity over every holder (D9), read in the same snapshot as the balances.
  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric, (v_players + v_house + v_arena) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house + arena is ' || (v_players + v_house + v_arena)
     || '. Player holders net ' || v_reg_players || ' (fixtures ' || v_reg_fix || '), house holders net ' || v_reg_house
     || ', the rest is the acknowledged pre-standard baseline and its corrections (holder circulation). difference must be 0.')::text;

  -- diamond_debts
  EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts WHERE settled_at IS NULL' INTO v_sub;
  v_tot_now := v_tot_now + v_sub;
  RETURN QUERY SELECT 'diamond_debts'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'unsettled chargeback receivable (DR1). A balance is never negative; the remainder lands here.'::text;

  -- promo_budgets_spent
  SELECT COALESCE(SUM(public.fn_ca_diamond_engine_spent(b.period, b.engine)), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*) INTO v_sub, v_tmp, v_n
    FROM public.diamond_reward_budgets b;
  RETURN QUERY SELECT 'promo_budgets_spent'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    format('%s budget lines, %s budgeted, %s spent by players (fixture issuance excluded since 2026-09-07). A counter, not a balance.', v_n, v_tmp, v_sub);

  -- mirror_mismatch
  SELECT count(*) INTO v_n FROM public.profiles p
    LEFT JOIN public.user_diamonds ud ON ud.user_id = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets dw ON dw.user_id = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;
  RETURN QUERY SELECT 'mirror_mismatch'::text, v_n::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'COUNT of profiles whose three mirrors disagree or are missing. The mirror trigger upserts all three legs on INSERT and UPDATE (2026-09-07); non-zero means a writer bypassed it.'::text;

  -- dead_stores
  v_sub := 0; v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_progress', 'diamonds'), ('bot_profiles', 'diamonds'), ('club_members', 'diamonds'),
                                 ('club_memberships', 'diamonds'), ('club_diamond_wallets', 'balance')) AS m(rel, col) LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN v_note := v_note || r.rel || ': absent. ';
      ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = r.rel AND c.column_name = r.col) THEN
        -- Dropped on purpose (20260908033824), which is not the same thing as a query that
        -- broke. This line exists to tell those two apart, so it has to say which one it is.
        v_note := v_note || format('%s.%s: dropped. ', r.rel, r.col);
      ELSE
        EXECUTE format('SELECT COALESCE(SUM(COALESCE(%I, 0)), 0)::numeric FROM public.%I', r.col, r.rel) INTO v_tmp;
        v_sub := v_sub + v_tmp; v_note := v_note || format('%s.%s = %s. ', r.rel, r.col, v_tmp);
      END IF;
    EXCEPTION WHEN OTHERS THEN v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'dead_stores'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    (v_note || 'Outside the supply; the delete list, gated on seven days of zero writes (ca_diamond_dead_store_writes).')::text;

  -- suspense (DR12)
  SELECT COALESCE(SUM(dt.amount), 0), count(*) INTO v_sub, v_n FROM public.diamond_transactions dt
   WHERE dt.created_at >= GREATEST(w0, c_foundation) AND (dt.counterparty IS NULL OR dt.counterparty = 'unknown' OR dt.issuance_class IS NULL);
  RETURN QUERY SELECT 'suspense'::text, v_sub, NULL::numeric, v_sub, NULL::numeric, NULL::numeric,
    format('%s journal rows in the window name no counterparty or class. The journal classifier fills both on INSERT since 2026-09-07 and files DR12 naming the writer, so this must read zero.', v_n);

  -- total
  RETURN QUERY SELECT 'total'::text, v_tot_now, CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta END, v_tot_jrn, v_tot_mint,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta - v_tot_mint END,
    'players + custody + house + unsettled debts. difference is player-and-house movement minus register movement (fixtures apart).'::text;
END $function$;
ALTER FUNCTION public.fn_ca_satellite_value_ticket_marked(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_value_ticket_marked(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_assert_satellite_value_ticket(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_assert_satellite_value_ticket(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_diamond_value_ticket_float(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_value_ticket_float(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_issue_diamond_value_ticket(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_issue_diamond_value_ticket(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_ca_diamond_value_ticket_fund_entry(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_value_ticket_fund_entry(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_refund_entitlement_commit_valid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_rows integer;
BEGIN
  IF NEW.entitlement_kind='wallet_charge' THEN
    SELECT count(*) INTO v_rows FROM public.chip_ledger l
     WHERE l.id=NEW.source_ledger_id
       AND l.tournament_id=NEW.tournament_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='player_wallet' AND l.from_entity_id=NEW.user_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND lower(l.category)=NEW.charge_category
       AND l.amount=NEW.gross;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'wallet charge entitlement lost its exact source ledger'
        USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.tournament_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=NEW.charge_category;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.tournament_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=NEW.charge_category;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'wallet charge entitlement and reporting debit do not commit together'
        USING ERRCODE = 'P0404';
    END IF;
  ELSIF NEW.entitlement_kind='satellite_seat' THEN
    SELECT count(*) INTO v_rows FROM public.chip_ledger l
     WHERE l.id=NEW.source_ledger_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='prize_liability'
       AND l.from_entity_id=NEW.source_satellite_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND l.amount=NEW.gross
       AND l.metadata->>'user_id'=NEW.user_id::text
       AND l.metadata->>'registration_id'=NEW.registration_id::text;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite seat entitlement lost its exact pool transfer'
        USING ERRCODE = 'P0404';
    END IF;
  ELSE
    SELECT count(*) INTO v_rows
      FROM public.chip_ledger l
      JOIN public.tournament_tickets tk ON tk.id=NEW.source_ticket_id
     WHERE l.id=NEW.source_ledger_id
       AND l.tournament_id=NEW.tournament_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='escrow' AND l.from_entity_id=NEW.source_ticket_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND l.category='ticket_redeem' AND l.amount=NEW.gross
       AND l.metadata->>'user_id'=NEW.user_id::text
       AND l.metadata->>'registration_id'=NEW.registration_id::text
       AND tk.holder_id=NEW.user_id
       AND tk.status='redeemed'
       AND tk.redemption_mode='tournament_entry_only'
       AND tk.value=NEW.gross
       AND ((NOT public.fn_ca_satellite_value_ticket_marked(tk.id)
         AND tk.entry_prize=NEW.refund_prize
         AND tk.entry_bounty=NEW.refund_bounty
         AND tk.entry_fee=NEW.refund_fee)
        OR (public.fn_ca_satellite_value_ticket_marked(tk.id)
         AND public.fn_ca_assert_satellite_value_ticket(tk.id)='chips'
         AND (l.metadata->>'entry_prize')::numeric=NEW.refund_prize
         AND (l.metadata->>'entry_bounty')::numeric=NEW.refund_bounty
         AND (l.metadata->>'entry_fee')::numeric=NEW.refund_fee
         AND NEW.refund_prize+NEW.refund_bounty+NEW.refund_fee=NEW.gross))
       AND tk.source_satellite_id=NEW.source_satellite_id;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament-ticket entitlement lost its exact admission transfer'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_refund_entitlement_commit_valid() FROM PUBLIC,anon,authenticated,service_role;
-- Explicitly retain the live private/service reader ACLs (read October31).
REVOKE ALL ON FUNCTION public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_entry_ticket_hints(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_ticket_escrow_float() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ticket_escrow_float() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) TO service_role;

-- Retain the rest of the exact installed authority surface as well.
REVOKE ALL ON FUNCTION public.fn_ca_settle_satellite_cohort(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_cohort_receipt(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_pay_closed_target_tickets_in_cash(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_pay_closed_target_tickets_in_cash(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_custody_balance() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_custody_balance() TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_wallet_summary(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_wallet_summary(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_reconciliation(uuid) TO authenticated,service_role;

ALTER FUNCTION public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid) TO service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_drain','20261030001505_satellite_fallback_awards_are_reusable_value_tickets');
COMMIT;
