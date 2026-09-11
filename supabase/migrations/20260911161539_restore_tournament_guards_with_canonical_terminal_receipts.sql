-- D12: reuse the existing canonical batch and readiness contracts.
-- No historical payments, standing records or application rows are rewritten.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='120s';
-- Pin the complete trigger functions before changing their shared composition.
-- This additive migration must not silently replace another operation's guard.
DO $d12_source_preflight$
BEGIN
 IF to_regprocedure('public.fn_ca_verify_terminal_place_batch(uuid,boolean)') IS NOT NULL THEN
  RAISE EXCEPTION 'D12 canonical place verifier already exists; reconcile its authority';
 END IF;
 IF EXISTS (SELECT 1 FROM (VALUES
  ('aa_guard_tournament_completing_claim','fn_guard_tournament_completing_claim','311ed77e7726f0c7515859a9140d526c'),
  ('aaa_guard_atomic_satellite_completion','trg_guard_atomic_satellite_completion','8ac917a51ecde732a1f9c27527c87219'),
  ('zzzz_freeze_finalized_tournament_prize_pool','trg_freeze_finalized_tournament_prize_pool','d58236d778465cfd5f4c1e25933f77f4'),
  ('zzzz_tournament_pool_finalization_window_guard','trg_tournament_pool_finalization_window_guard','6ba00817ea7d386e3c1d37212b9c9866'),
  ('zzzz_tournaments_atomic_place_completion_guard','trg_tournament_atomic_place_completion_guard','18cf8159e315f322ac7cc09e1f913671'),
  ('zzzzz_tournaments_atomic_final_table_deal_completion_guard','trg_atomic_final_table_deal_completion_guard','38bf96ba348994fd40264584c26107d8'),
  ('zzzzzz_tournaments_financial_certificate','fn_guard_tournament_completed_certificate','8a05956d1fd25d649f1f80b133ed3ed0')
 ) expected(trigger_name,function_name,definition_md5)
 LEFT JOIN pg_trigger t ON t.tgrelid='public.tournaments'::regclass
  AND t.tgname=expected.trigger_name AND NOT t.tgisinternal
 LEFT JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE t.oid IS NULL OR t.tgenabled<>'D'
  OR p.pronamespace IS DISTINCT FROM 'public'::regnamespace
  OR p.proname IS DISTINCT FROM expected.function_name
  OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM expected.definition_md5) THEN
  RAISE EXCEPTION 'D12 seven disabled guard definitions differ from the reviewed source';
 END IF;
END $d12_source_preflight$;
-- BEGIN CANONICAL TERMINAL PLACE BATCH CONTRACT
-- Version is owned by this writer; legacy p_source cannot choose semantics.
ALTER TABLE public.tournament_place_settlement_batches
 ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
DO $canonical_place_batch_version$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
   ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.tournament_place_settlement_batches'::regclass
    AND a.attname='contract_version' AND a.atttypid='integer'::regtype
    AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='1') THEN
  RAISE EXCEPTION 'canonical place batch version column differs';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
  WHERE conrelid='public.tournament_place_settlement_batches'::regclass
   AND conname='tournament_place_batch_contract_version') THEN
  ALTER TABLE public.tournament_place_settlement_batches
   ADD CONSTRAINT tournament_place_batch_contract_version CHECK(contract_version IN (1,2));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.tournament_place_settlement_batches'::regclass
    AND conname='tournament_place_batch_contract_version' AND convalidated
    AND pg_get_constraintdef(oid)='CHECK ((contract_version = ANY (ARRAY[1, 2])))') THEN
  RAISE EXCEPTION 'canonical place batch version constraint differs';
 END IF;
END;
$canonical_place_batch_version$;

-- Verify the current cash authority's version 2 batch against its canonical
-- ladder, the installed bust-witness ordering, paid obligations and wallet receipts.
CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_place_batch(
 p_tournament_id uuid,p_require_terminal boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $verify_terminal_place_batch$
DECLARE
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_place_settlement_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ladder jsonb; v_plan jsonb;
 v_field integer; v_positive integer; v_bubble_place integer;
 v_place_total numeric; v_bubble_amount numeric:=0;
 v_bubble_user uuid; v_ob public.tournament_obligations%ROWTYPE;
 v_bubble_count integer;
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_place_settlement_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.mode<>'structure' OR v_b.settled_at IS NULL
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
 THEN RAISE EXCEPTION 'canonical terminal batch is not funded and settled'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players
  WHERE tournament_id=p_tournament_id;
 IF v_field=0 OR
  (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1)<>1
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND (position IS NULL OR position<1 OR position>v_field
     OR status NOT IN ('winner','eliminated')
     OR (status='winner' AND position<>1)
     OR (status='eliminated' AND (eliminated_at IS NULL OR elimination_sequence IS NULL))))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT 1 FROM ranked WHERE ranked.bust_at IS NULL
       OR ranked.position IS DISTINCT FROM ranked.expected_position)
 THEN RAISE EXCEPTION 'canonical terminal batch has no exact durable standings'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
   ORDER BY a.place),'[]'::jsonb),COALESCE(sum(a.amount),0),
   count(*) FILTER(WHERE a.amount>0),max(a.place)+1
 INTO v_ladder,v_place_total,v_positive,v_bubble_place
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF jsonb_array_length(v_ladder)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) a
   WHERE (a->>'amount')::numeric<0 OR (a->>'amount')::numeric<>round((a->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical terminal batch ladder is invalid'; END IF;
 IF v_t.bubble_protection AND v_bubble_place<=v_field THEN
  v_bubble_amount:=v_t.buy_in_amount;
  IF v_bubble_amount IS NULL OR v_bubble_amount<=0
   OR v_bubble_amount::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble_amount<>round(v_bubble_amount,2)
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble amount is invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_bubble_place AND status='eliminated';
 END IF;
 IF v_place_total+v_bubble_amount IS DISTINCT FROM v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical ladder and Bubble do not allocate one pool'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',(a->>'place')::integer,
  'user_id',tp.user_id,'club_id',tp.club_id,'cents',round((a->>'amount')::numeric*100)::bigint)
  ORDER BY (a->>'place')::integer),'[]'::jsonb) INTO v_plan
 FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
  ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
 WHERE (a->>'amount')::numeric>0;
 IF jsonb_array_length(v_plan)<>v_positive OR v_b.place_count<>v_positive
  OR v_b.amount_owed IS DISTINCT FROM v_place_total
  OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_plan::text)
  OR v_b.escrow_required<0 OR v_b.escrow_available<v_b.escrow_required
  OR v_b.escrow_required>v_t.prize_pool
  OR v_b.escrow_required<>round(v_b.escrow_required,2)
  OR v_b.escrow_available<>round(v_b.escrow_available,2)
 THEN RAISE EXCEPTION 'canonical terminal batch header or funding proof differs'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_players tp
  LEFT JOIN LATERAL (SELECT (a->>'amount')::numeric AS amount
   FROM jsonb_array_elements(v_ladder) a WHERE (a->>'place')::integer=tp.position) expected ON true
  WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE(expected.amount,
    CASE WHEN tp.user_id=v_bubble_user THEN v_bubble_amount ELSE 0 END))
 THEN RAISE EXCEPTION 'canonical terminal batch prize cache differs'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
  LEFT JOIN public.tournament_obligations o ON o.tournament_id=p_tournament_id
   AND o.kind='place' AND o.place=(a->>'place')::integer
  WHERE o.id IS NULL OR o.user_id IS DISTINCT FROM (a->>'user_id')::uuid
   OR o.amount_owed IS DISTINCT FROM (a->>'cents')::numeric/100
   OR o.amount_paid IS DISTINCT FROM o.amount_owed OR o.settled_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id AND o.kind='place'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
     WHERE o.place=(a->>'place')::integer AND o.user_id=(a->>'user_id')::uuid
      AND o.amount_owed=(a->>'cents')::numeric/100))
 THEN RAISE EXCEPTION 'canonical terminal batch obligations differ'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a WHERE
  (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position=(a->>'place')::integer
    AND p.user_id=(a->>'user_id')::uuid) IS DISTINCT FROM (a->>'cents')::numeric/100)
  OR EXISTS(SELECT 1 FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.position IS NOT NULL AND
    (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_plan) a
      WHERE p.position=(a->>'place')::integer AND p.user_id=(a->>'user_id')::uuid)
     OR p.amount IS NULL OR p.amount<=0 OR p.amount<>round(p.amount,2)
     OR p.idempotency_key IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key=p.idempotency_key
       AND k.user_id=p.user_id AND k.amount=p.amount)))
 THEN RAISE EXCEPTION 'canonical terminal batch payout or wallet receipt differs'; END IF;
 SELECT count(*) INTO v_bubble_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble_amount>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_bubble_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
   OR v_ob.settled_at IS NULL
   OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement','engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble_amount
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble_amount
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection')<>v_bubble_amount
   OR EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.source='bubble_protection'
     AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user OR p.amount<=0
      OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k
       WHERE k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)))
  THEN RAISE EXCEPTION 'canonical terminal batch Bubble proof differs'; END IF;
 ELSIF v_bubble_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0
  OR v_b.bubble_amount_paid_before<>0
  OR EXISTS(SELECT 1 FROM public.tournament_payouts
   WHERE tournament_id=p_tournament_id AND source='bubble_protection')
 THEN RAISE EXCEPTION 'canonical terminal batch has uncontracted Bubble evidence'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical terminal batch has open custody or seats'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'place_total',v_place_total,
  'bubble_amount',v_bubble_amount,'place_count',v_positive,'plan_fingerprint',v_b.plan_fingerprint);
END;
$verify_terminal_place_batch$;
REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_place_batch(uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

DO $contract_terminal_place_batch$
DECLARE
 v_oid oid; v_definition text; v_source text; v_before jsonb; v_after jsonb;
BEGIN
 v_oid:=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite metadata differs: fn_settle_tournament_places';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('6181734ff98555ecc04648186f6ebf24','473f67cf3949b938f5277c89fb64edef') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite body differs: fn_settle_tournament_places';
 END IF;
 IF md5(v_source)='6181734ff98555ecc04648186f6ebf24' THEN
  IF position($canonical_old_0_0$  v_rows integer;$canonical_old_0_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/0 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_0$  v_rows integer;$canonical_old_0_0$,$canonical_new_0_0$  v_rows integer;
  v_modern_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_modern_replay boolean := false;
  v_modern_required numeric := 0;
  v_modern_escrow_before numeric := 0;
  v_modern_plan jsonb;
  v_modern_positive integer;
$canonical_new_0_0$);
  IF position($canonical_old_0_1$  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_old_0_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/1 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_1$  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_old_0_1$,$canonical_new_0_1$  -- A published batch is an immutable money plan. Replay it without even
  -- transiently clearing cached prizes or rewriting a frozen obligation.
  SELECT * INTO v_modern_batch FROM public.tournament_place_settlement_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    IF v_modern_batch.contract_version<>2 OR v_modern_batch.settled_at IS NULL THEN
      RAISE EXCEPTION 'existing place batch requires its original settlement authority'
        USING ERRCODE='55000';
    END IF;
    v_modern_replay:=true;
  END IF;

  IF lower(COALESCE(v_t.variant,'')) = 'satellite'$canonical_new_0_1$);
  IF position($canonical_old_0_2$v_status = 'COMPLETED'$canonical_old_0_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/2 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_2$v_status = 'COMPLETED'$canonical_old_0_2$,$canonical_new_0_2$(v_status = 'COMPLETED' OR v_modern_replay)$canonical_new_0_2$);
  IF position($canonical_old_0_3$v_status <> 'COMPLETED'$canonical_old_0_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/3 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_3$v_status <> 'COMPLETED'$canonical_old_0_3$,$canonical_new_0_3$(v_status <> 'COMPLETED' AND NOT v_modern_replay)$canonical_new_0_3$);
  IF position($canonical_old_0_4$    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_old_0_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/4 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_4$    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_old_0_4$,$canonical_new_0_4$    SELECT e.prize_balance INTO STRICT v_modern_escrow_before
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id AND e.enforced FOR UPDATE;
    SELECT COALESCE(sum(o.amount_owed-o.amount_paid),0)
      INTO v_modern_required FROM public.tournament_obligations o
     WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','bubble_protection');
    IF v_modern_required<0 OR v_modern_required<>round(v_modern_required,2)
       OR v_modern_escrow_before IS NULL
       OR v_modern_escrow_before<v_modern_required
       OR v_modern_escrow_before<>round(v_modern_escrow_before,2) THEN
      RAISE EXCEPTION 'canonical place batch lacks exact pre-credit funding'
        USING ERRCODE='23514';
    END IF;

    IF v_bubble_amount > 0 THEN
      v_bubble_result :=$canonical_new_0_4$);
  IF position($canonical_old_0_5$  RETURN jsonb_build_object(
    'ok',true,$canonical_old_0_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 0/5 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_0_5$  RETURN jsonb_build_object(
    'ok',true,$canonical_old_0_5$,$canonical_new_0_5$  -- This header certifies money the same authority just proved and paid.
  -- It never invents or seeds a payment, and its original funding snapshot is
  -- preserved unchanged on every retry.
  IF NOT v_modern_replay THEN
    IF v_status='COMPLETED' THEN
      RAISE EXCEPTION 'completed event has no current canonical place batch'
        USING ERRCODE='55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'place',(a->>'place')::integer,'user_id',tp.user_id,'club_id',tp.club_id,
      'cents',round((a->>'amount')::numeric*100)::bigint)
      ORDER BY (a->>'place')::integer),'[]'::jsonb),count(*)
      INTO v_modern_plan,v_modern_positive
      FROM jsonb_array_elements(v_ladder) a JOIN public.tournament_players tp
       ON tp.tournament_id=p_tournament_id AND tp.position=(a->>'place')::integer
     WHERE (a->>'amount')::numeric>0;
    IF (SELECT e.prize_balance FROM public.tournament_escrow e
         WHERE e.tournament_id=p_tournament_id) IS DISTINCT FROM
         v_modern_escrow_before-v_modern_required THEN
      RAISE EXCEPTION 'canonical place batch lost its exact escrow delta'
        USING ERRCODE='23514';
    END IF;
    -- The real Bubble payer may normalize source while crediting. Record its
    -- settled identity, retaining v_bubble_paid as the pre-credit snapshot.
    IF v_bubble_amount>0 THEN
      SELECT * INTO STRICT v_bubble_ob FROM public.tournament_obligations
       WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
    END IF;
    INSERT INTO public.tournament_place_settlement_batches(
      tournament_id,mode,plan_fingerprint,place_count,amount_owed,
      escrow_required,escrow_available,bubble_contract_required,
      bubble_obligation_id,bubble_user_id,bubble_source,
      bubble_amount_owed,bubble_amount_paid_before,source,settled_at,contract_version)
    VALUES(p_tournament_id,'structure',md5(v_modern_plan::text),
      v_modern_positive,v_total_expected,v_modern_required,v_modern_escrow_before,
      v_bubble_amount>0,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_user_id ELSE NULL END,
      CASE WHEN v_bubble_amount>0 THEN v_bubble_ob.source ELSE NULL END,
      v_bubble_amount,CASE WHEN v_bubble_amount>0 THEN v_bubble_paid ELSE 0 END,
      'engine.fn_settle_tournament_places',transaction_timestamp(),2);
  END IF;
  PERFORM public.fn_ca_verify_terminal_place_batch(p_tournament_id,false);

  RETURN jsonb_build_object(
    'ok',true,$canonical_new_0_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'473f67cf3949b938f5277c89fb64edef' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical place batch postcondition differs: fn_settle_tournament_places';
 END IF;
 v_oid:=to_regprocedure('public.trg_tournament_atomic_place_completion_guard()');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite metadata differs: trg_tournament_atomic_place_completion_guard';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('3e43d26ddd36a55e736a9a304a89ba9a','1bde80d6520fbc3a93409fe88651109e') THEN
  RAISE EXCEPTION 'canonical place batch prerequisite body differs: trg_tournament_atomic_place_completion_guard';
 END IF;
 IF md5(v_source)='3e43d26ddd36a55e736a9a304a89ba9a' THEN
  IF position($canonical_old_1_0$  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_old_1_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'canonical batch source fragment 1/0 absent'; END IF;
  v_definition:=replace(v_definition,$canonical_old_1_0$  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_old_1_0$,$canonical_new_1_0$  IF v_batch.contract_version=2 THEN
    PERFORM public.fn_ca_verify_terminal_place_batch(NEW.id,true);
    RETURN NEW;
  END IF;

  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN$canonical_new_1_0$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
   'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'1bde80d6520fbc3a93409fe88651109e' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical place batch postcondition differs: trg_tournament_atomic_place_completion_guard';
 END IF;
END;
$contract_terminal_place_batch$;
DO $canonical_batch_terminal_marker$
DECLARE v_oid oid:='public.trg_freeze_batched_tournament_place()'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
   AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]) THEN
  RAISE EXCEPTION 'frozen batch trigger metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'returns',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('da224a232366acc2443f0ec5428567e0','5c00f4babf2e07dd86e9f47e14588b07') THEN
  RAISE EXCEPTION 'frozen batch trigger source differs';
 END IF;
 IF md5(v_source)='da224a232366acc2443f0ec5428567e0' THEN
  IF position($marker_old$  IF v_gate <> OLD.tournament_id::text THEN$marker_old$ IN v_definition)=0 THEN
   RAISE EXCEPTION 'frozen batch trigger marker anchor absent';
  END IF;
  v_definition:=replace(v_definition,$marker_old$  IF v_gate <> OLD.tournament_id::text THEN$marker_old$,$marker_new$  -- Stamp only the exact lifecycle marker after completion. Frozen monetary
  -- columns and payment gates retain their original restrictions.
  IF OLD.terminal_closed_at IS NULL AND NEW.terminal_closed_at IS NOT NULL
     AND isfinite(NEW.terminal_closed_at)
     AND (to_jsonb(NEW)-'terminal_closed_at') IS NOT DISTINCT FROM
         (to_jsonb(OLD)-'terminal_closed_at')
     AND EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id=OLD.tournament_id AND b.contract_version=2
        AND b.settled_at IS NOT NULL)
     AND EXISTS(SELECT 1 FROM public.tournaments t
       WHERE t.id=OLD.tournament_id AND upper(t.status::text)='COMPLETED'
        AND t.ended_at IS NOT DISTINCT FROM NEW.terminal_closed_at) THEN
    PERFORM public.fn_ca_verify_terminal_place_batch(OLD.tournament_id,true);
    RETURN NEW;
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN$marker_new$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'returns',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'5c00f4babf2e07dd86e9f47e14588b07' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'frozen batch marker postcondition differs';
 END IF;
END;
$canonical_batch_terminal_marker$;
-- END CANONICAL TERMINAL PLACE BATCH CONTRACT
-- BEGIN CANONICAL TERMINAL READINESS DISPATCH
-- Only the versioned format proof changes. Shared finish claim, winner,
-- obligation, custody, rake, bounty and mystery certification remain intact.
DO $contract_terminal_batch_readiness$
DECLARE v_oid oid:='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'terminal readiness owner-only metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('ac4a33b4428ca68fb385b7de764a8590','993e6e1de9edba2fe235d86ff6c243c9','0388659818612493c16b02048dae5b3f') THEN RAISE EXCEPTION 'terminal readiness source differs'; END IF;
 IF md5(v_source)='ac4a33b4428ca68fb385b7de764a8590' THEN
  IF position($readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 0 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$,$readiness_new_0$  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;$readiness_new_0$);
  IF position($readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 1 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$,$readiness_new_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
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
$readiness_new_1$);
  IF position($readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 2 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$,$readiness_new_2$  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN$readiness_new_2$);
  IF position($readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 3 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$,$readiness_new_3$    IF v_modern_place THEN
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

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_new_3$);
  IF position($readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 4 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$,$readiness_new_4$    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_new_4$);
  IF position($readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 5 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$,$readiness_new_5$      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;$readiness_new_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('993e6e1de9edba2fe235d86ff6c243c9','0388659818612493c16b02048dae5b3f') OR v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'readiness source or metadata postcondition differs'; END IF;
END;
$contract_terminal_batch_readiness$;
-- END CANONICAL TERMINAL READINESS DISPATCH
DO $terminal_claim$
DECLARE d text; b text; m jsonb; a jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure
  AND proowner='postgres'::regrole AND prosecdef
  AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  AND proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=45s']::text[]
  AND proacl @> ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]
  AND ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[] @> proacl) THEN
  RAISE EXCEPTION 'D12 terminal claim entry-point metadata differs';
 END IF;
 SELECT pg_get_functiondef(oid),prosrc,to_jsonb(p)-ARRAY['prosrc','oid'] INTO d,b,m FROM pg_proc p WHERE oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
 IF md5(b)<>'96a61ea5e16560735bcb70b355aa79ab' THEN RAISE EXCEPTION 'terminal claim source changed'; END IF;
 IF (length(d)-length(replace(d,'  v_token:=public.fn_ca_open_tournament_seat_exit_authority(','')))/length('  v_token:=public.fn_ca_open_tournament_seat_exit_authority(')<>1 THEN RAISE EXCEPTION 'terminal claim anchor changed'; END IF;
 EXECUTE replace(d,'  v_token:=public.fn_ca_open_tournament_seat_exit_authority(','  -- Normal terminal callers own a verified finish claim in the same SQL
  -- transaction. Failure below rolls the claim back with the entire payment.
  IF lower(btrim(coalesce(p_settlement_mode,'''')))=''places''
     AND NOT EXISTS (SELECT 1 FROM public.tournament_terminal_settlements
       WHERE tournament_id=p_tournament_id) THEN
    v_result:=public.fn_claim_tournament_finish(
      p_tournament_id,p_observed_winner_id,''engine.fn_complete_tournament_terminal'');
    IF (v_result->>''ok'')::boolean IS DISTINCT FROM true
       OR v_result->>''winner_user_id'' IS DISTINCT FROM p_observed_winner_id::text THEN
      RAISE EXCEPTION ''terminal finish claim refused or winner changed: %'',v_result
        USING ERRCODE=''55000'';
    END IF;
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(');
 SELECT prosrc,to_jsonb(p)-ARRAY['prosrc','oid'] INTO b,a FROM pg_proc p WHERE oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
 IF md5(b)<>'541b6e9d029b8eec7f55aa4ad6965a63' OR a IS DISTINCT FROM m THEN RAISE EXCEPTION 'terminal claim postimage or metadata changed'; END IF;
END $terminal_claim$;
ALTER TABLE public.tournaments ENABLE TRIGGER aa_guard_tournament_completing_claim;
ALTER TABLE public.tournaments ENABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;
ALTER TABLE public.tournaments ENABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;
ALTER TABLE public.tournaments ENABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;
ALTER TABLE public.tournaments ENABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;
ALTER TABLE public.tournaments ENABLE TRIGGER zzzzzz_tournaments_financial_certificate;
ALTER TABLE public.tournaments ENABLE TRIGGER aaa_guard_atomic_satellite_completion;
DO $d12_guard_postcondition$
BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
  AND tgname IN ('aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate'))<>7
  OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
  AND tgname IN ('aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate') AND tgenabled<>'O') THEN
  RAISE EXCEPTION 'D12 did not activate all seven tournament guards';
 END IF;
 IF has_function_privilege('anon','public.fn_ca_verify_terminal_place_batch(uuid,boolean)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_ca_verify_terminal_place_batch(uuid,boolean)','EXECUTE')
  OR has_function_privilege('service_role','public.fn_ca_verify_terminal_place_batch(uuid,boolean)','EXECUTE') THEN
  RAISE EXCEPTION 'D12 canonical verifier must remain owner-only';
 END IF;
END $d12_guard_postcondition$;
COMMIT;
