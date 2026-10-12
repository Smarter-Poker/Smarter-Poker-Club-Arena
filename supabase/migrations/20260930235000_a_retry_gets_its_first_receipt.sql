-- ============================================================================
-- A RETRY GETS ITS FIRST RECEIPT
-- ============================================================================
--
-- 20260930235000_a_retry_gets_its_first_receipt.sql
-- Version assigned for this round and checked free against origin/main, every
-- remote branch and production's schema_migrations before it was written.
--
-- Phase 11 of the Diamond Arena programme, line 2 ("Test transfer/store/game
-- concurrency, duplicate delivery and crash recovery"). The concurrency suite
-- delivered the same request twice to every Diamond money door. Every door took
-- effect exactly once, but a retry did not always answer what the first
-- delivery answered (docs/evidence/diamond-phase-11/concurrency-and-recovery.md,
-- "Open for Dan"). Decided by Claude on Dan's delegation of 2026-09-30 ("these
-- are all for you to decide not me ... FIX AND FINISH ALL OF THESE"), recorded
-- in docs/DIAMOND-RULINGS.md:
--
--   1. Every Diamond money door answers a retry of the same request with its
--      first receipt, word for word. No door adds a replay marker: the cash
--      buy-in answers nothing (void) and the prize payer answers a boolean, so
--      a marker could never be the same at every door. The five doors that
--      already answered word for word (transfer, buy-in, top-up, cash-out,
--      registration) are untouched.
--   2. A retry that reuses a key with different parameters is refused by name
--      at every door, the prize payer included.
--
-- What changes - four functions. Nothing is created, opened or priced, and no
-- chip door answers differently:
--
--   fn_purchase_feature_v2 (the Diamond store). A retry was answered from the
--     stored receipt with cost 0, granted false and idempotent true laid over
--     it. It now answers the stored receipt itself, which IS the first answer.
--     The client keeps a request id only until it hears any answer, so the one
--     retry it ever sends follows a lost response; it now learns what its
--     purchase did instead of "restored, charged nothing".
--
--   fn_poker_diamond_tournament_unregister (the Diamond withdrawal). A retry
--     answered with idempotent and replayed markers, and read diamonds_after
--     from the wallet as it stood at the retry. It now answers without markers,
--     and both answers report the balance the refund left, from the release's
--     own immutable receipt (poker_diamond_movements, keyed by this request
--     id). That is the value the first answer read from the wallet: the credit
--     holds the wallet row until commit and nothing after it moves the wallet.
--
--   fn_poker_diamond_tournament_pay (the prize payer). It answered true once,
--     false to every retry, and false - paying nothing, naming nothing - when
--     a key came back with another amount. It now answers every retry of the
--     same payment (payee, event, bank and amount under the key) true, its
--     first receipt, and refuses any other use of the key by name:
--     diamond_tournament_pay_key_reused. When it pays, it names the key in the
--     transaction-local setting app.diamond_tournament_pay_claimed.
--
--   fn_credit_and_log (asserted substitution, Diamond branch only). The
--     payer's one caller. It told a payment from its retry by the payer's
--     answer: on true it writes the payout evidence row, on false it verifies
--     that row and answers false. It now reads the key the payer named, so it
--     answers exactly as before - true for the call that paid, false for a
--     verified retry. Without this edit a replayed true would write a second
--     payout row, uq_tournament_payouts_idempotency_key would refuse it, and
--     that retry would fail every time. The chip branch is untouched. Its
--     callers (the obligation settler, the satellite settlers, the terminal)
--     read the same answers as before, and the engine reaches tournament money
--     only through the terminal (server/src never calls the payer or
--     fn_credit_and_log), so no engine code changes.
--
-- Not changed, deliberately: the rebuy money core
-- (fn_ca_process_tournament_chip_purchase_money_v1) is shared with chips and is
-- reached only through process_tournament_rebuy, which answers every retry with
-- its stored first receipt before the core is reached and refuses the core's
-- "already charged" answer by name. The core refuses a changed price by name.
--
-- Diamond doors are pinned and redefined in full from production's own
-- pg_get_functiondef text with only the lines above changed; fn_credit_and_log
-- is edited by asserted substitution (pinned, found once, reverse proved).
-- fn_poker_diamond_tournament_pay and fn_poker_diamond_tournament_unregister
-- are on fn_ca_guard_watchlist() and are declared. Grants are kept: the payer,
-- the withdrawal and fn_credit_and_log stay owner-only; the store stays
-- callable by authenticated and service_role, never anon.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_purchase_feature_v2                   f16cefd4ad43466df06c7150440c3e16
--   fn_poker_diamond_tournament_unregister   39f95b499619cab7a1eb65ff583aa638
--   fn_poker_diamond_tournament_pay          e246c03b5a6d2aff690d227912ff7e82
--   fn_credit_and_log                        e1c4ca5fd66536cc90adc9af106e3068
-- RESULTING md5(pg_get_functiondef(oid)), asserted at the foot:
--   fn_purchase_feature_v2                   122d227c5571dc0ae34e4a351cd16453
--   fn_poker_diamond_tournament_unregister   6e3a82f7b5bf8e1f10d44e34fe214117
--   fn_poker_diamond_tournament_pay          19cd9ea4fb671379fe84f05d409812a1
--   fn_credit_and_log                        3ede19642ab1ca18b7e185caae03d192
--
-- The migration creates no object, so it declares its own proof of being live:
-- @live-proof: position('diamond_tournament_pay_key_reused' in pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)'::regprocedure)) > 0 AND position('RETURN false' in pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)'::regprocedure)) = 0
-- @live-proof: position('app.diamond_tournament_pay_claimed' in pg_get_functiondef('public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure)) > 0
-- @live-proof: position('v_prior_after' in pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)'::regprocedure)) > 0 AND position('''replayed''' in pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)'::regprocedure)) = 0
-- @live-proof: position('RETURN v_cached_result;' in pg_get_functiondef('public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure)) > 0 AND position('RETURN v_cached_result ||' in pg_get_functiondef('public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure)) = 0
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. THE STORE ANSWERS A RETRY WITH ITS FIRST RECEIPT
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'f16cefd4ad43466df06c7150440c3e16' THEN
    RAISE EXCEPTION 'fn_purchase_feature_v2 is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_purchase_feature_v2(p_user_id uuid, p_feature text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller            uuid := auth.uid();
  v_price             record;
  v_deduct            jsonb;
  v_expires           timestamptz;
  v_uses              integer;
  v_category          text;
  v_asset_id          text;
  v_is_customization  boolean := false;
  v_lifetime_included boolean := false;
  v_balance           integer;
  v_request_payload   jsonb := jsonb_build_object('feature', p_feature);
  v_cached_kind       text;
  v_cached_payload    jsonb;
  v_cached_result     jsonb;
  v_result            jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchases Are Limited To Your Own Account');
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'digital_purchase_request:' || v_caller::text || ':' || p_request_id::text,
      0
    )
  );

  SELECT r.purchase_kind, r.request_payload, r.result
    INTO v_cached_kind, v_cached_payload, v_cached_result
    FROM public.digital_purchase_receipts r
   WHERE r.user_id = v_caller
     AND r.request_id = p_request_id;

  IF FOUND THEN
    IF v_cached_kind IS DISTINCT FROM 'feature'
       OR v_cached_payload IS DISTINCT FROM v_request_payload
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Purchase',
        'code', 'REQUEST_ID_REUSED'
      );
    END IF;

    -- DIAMOND PHASE 11: A RETRY GETS ITS FIRST RECEIPT. The stored result is
    -- the first answer, and it answers every retry word for word - the cost it
    -- charged, the grant it made, the balance it left - so a client that lost
    -- the first response reads what its purchase did. Nothing moves.
    RETURN v_cached_result;
  END IF;

  SELECT feature, diamond_cost, usage_type INTO v_price
    FROM public.feature_pricing
   WHERE feature = p_feature;
  IF v_price.feature IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown Feature: ' || p_feature);
  END IF;
  IF v_price.diamond_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Feature Pricing Is Invalid');
  END IF;

  v_lifetime_included := public.sp_is_lifetime_vip(v_caller)
    AND p_feature = ANY(ARRAY[
      'rabbit_hunt',
      'time_bank_seconds',
      'throwable',
      'emoji_pack',
      'tag_pack',
      'show_stack_bb',
      'offline_protection',
      'auto_time_bank'
    ]::text[]);

  IF v_lifetime_included THEN
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = v_caller;

    v_result := jsonb_build_object(
      'success', true,
      'included', true,
      'unlimited', v_price.usage_type = 'per_use',
      'source', 'lifetime_vip',
      'cost', 0,
      'usage_type', v_price.usage_type,
      'idempotent', false,
      'granted', false,
      'diamonds_remaining', v_balance
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (v_caller, p_request_id, 'feature', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  IF p_feature LIKE 'studio:%' THEN
    v_category := split_part(p_feature, ':', 2);
    v_asset_id := substring(p_feature from length('studio:' || v_category || ':') + 1);
    v_is_customization := v_category IN (
      'theme_id', 'table_id', 'button_id', 'background_id'
    ) AND COALESCE(v_asset_id, '') <> '';
  ELSIF p_feature LIKE 'card_back_%' THEN
    v_category := 'cards_id';
    v_asset_id := substring(p_feature from length('card_back_') + 1);
    v_is_customization := COALESCE(v_asset_id, '') <> '';
  END IF;

  IF v_is_customization AND v_price.usage_type = 'permanent' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_purchase_feature:customization:' || v_caller::text, 0)
    );
  ELSE
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_purchase_feature:' || v_caller::text || ':' || p_feature, 0)
    );
  END IF;

  IF v_price.usage_type IN ('permanent', 'per_session') THEN
    IF EXISTS (
      SELECT 1
        FROM public.feature_purchases
       WHERE user_id = v_caller
         AND feature = p_feature
         AND (expires_at IS NULL OR expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type,
        'ownership_source', 'purchase_receipt'
      );
    END IF;

    IF v_is_customization
       AND public.sp_theme_asset_is_owned(v_caller, v_category, v_asset_id)
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type,
        'ownership_source', 'entitlement'
      );
    END IF;
  END IF;

  IF v_price.diamond_cost > 0 THEN
    v_deduct := public.deduct_diamonds(
      p_user_id          := v_caller,
      p_amount           := v_price.diamond_cost,
      p_description      := 'Feature purchase: ' || p_feature,
      p_transaction_type := 'feature_purchase',
      p_source           := 'feature_purchase',
      p_metadata         := jsonb_build_object('feature', p_feature),
      p_reference_id     := 'feat_' || v_caller::text || '_' || p_request_id::text
    );
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_deduct->>'error', 'Diamond Charge Failed')
      );
    END IF;

    -- deduct_diamonds deliberately deduplicates a repeated request receipt.
    -- Never turn that one debit into two grants after a response-lost retry.
    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      v_result := jsonb_build_object(
        'success', true,
        'cost', 0,
        'original_cost', v_price.diamond_cost,
        'usage_type', v_price.usage_type,
        'idempotent', true,
        'granted', false,
        'diamonds_remaining', (v_deduct->>'balance')::integer
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (v_caller, p_request_id, 'feature', v_request_payload, v_result);
      RETURN v_result;
    END IF;
    v_balance := (v_deduct->>'balance')::integer;
  ELSE
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = v_caller;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'User Not Found');
    END IF;
  END IF;

  v_uses := CASE v_price.usage_type WHEN 'per_use' THEN 1 ELSE NULL END;
  v_expires := CASE v_price.usage_type
    WHEN 'per_session' THEN now() + interval '8 hours'
    ELSE NULL
  END;

  INSERT INTO public.feature_purchases
    (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES
    (v_caller, p_feature, v_price.diamond_cost, v_price.usage_type, v_uses, v_expires);

  v_result := jsonb_build_object(
    'success', true,
    'cost', v_price.diamond_cost,
    'usage_type', v_price.usage_type,
    'idempotent', false,
    'granted', true,
    'diamonds_remaining', v_balance
  );
  INSERT INTO public.digital_purchase_receipts
    (user_id, request_id, purchase_kind, request_payload, result)
  VALUES
    (v_caller, p_request_id, 'feature', v_request_payload, v_result);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_purchase_feature_v2(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_purchase_feature_v2(uuid,text,uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. A WITHDRAWAL ANSWERS A RETRY WITH ITS FIRST RECEIPT
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)'::regprocedure)) INTO v_md5;
  IF v_md5 <> '39f95b499619cab7a1eb65ff583aa638' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_unregister is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE; v_reg public.tournament_players%ROWTYPE;
  v_refund jsonb; v_players_before integer; v_rows integer;
  v_prior public.poker_diamond_tournament_ledger%ROWTYPE; v_prior_reg uuid; v_prior_after bigint;
  v_authority text := 'scheduled_clock';
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and request ids are required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;

  -- A withdrawal that already happened answers with what it did: the same
  -- receipt the first answer carried, rebuilt from the refund ledger row
  -- (its registration id from the entry row of the same custody), so the
  -- client's one exact replay after a lost response is a receipt. The chip
  -- authority replays its stored receipt the same way, past the clock too.
  -- DIAMOND PHASE 11: word for word - no replay marker, and the balance it
  -- reports is the one the refund left, read from the release's own
  -- immutable receipt (keyed by this request id), never the wallet as it
  -- stands at the retry.
  SELECT l.* INTO v_prior FROM public.poker_diamond_tournament_ledger l
   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
     AND l.request->>'request_id'=p_request_id::text
   ORDER BY l.id LIMIT 1;
  IF FOUND THEN
    SELECT e.registration_id INTO v_prior_reg FROM public.poker_diamond_tournament_ledger e
     WHERE e.custody_id=v_prior.custody_id AND e.kind='entry'
     ORDER BY e.id LIMIT 1;
    SELECT (m.receipt->>'available_balance')::bigint INTO v_prior_after
      FROM public.poker_diamond_movements m
     WHERE m.request_id=p_request_id AND m.custody_id=v_prior.custody_id AND m.action='release';
    IF v_prior_after IS NULL THEN
      RAISE EXCEPTION 'diamond_tournament_refund_receipt_missing' USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,
      'request_id',p_request_id,
      'refunded_diamonds',v_prior.amount,'refund_prize',v_prior.prize_part,
      'refund_bounty',v_prior.bounty_part,'refund_fee',v_prior.fee_part,
      'registration_id',v_prior_reg,'custody_id',v_prior.custody_id,'obligation_id',v_prior.obligation_id,
      'asset','diamonds','diamonds_after',v_prior_after);
  END IF;

  -- The start authority is the chip authority's. A scheduled event closes at
  -- its clock. A spin or a heads-up sit-and-go is seat-first: start_time is
  -- only its fill-window deadline, and it closes when it actually starts. A
  -- launch releasing a registrant it could not seat names its incomplete
  -- receipt through app.ca_launch_release_launch_id; it is past the clock by
  -- design and is held to the seat-first proofs instead. A persisted hand
  -- closes every product.
  IF v_t.format_contract='spin-v1' THEN
    v_authority := 'spin_actual_start';
  ELSIF v_t.format_contract='sng-v1'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_authority := 'heads_up_sng_actual_start';
  END IF;
  IF v_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_authority := 'launch_release';
  END IF;
  IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables ht JOIN public.hand_history hh ON hh.table_id=ht.id
                 WHERE ht.tournament_id=p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id FOR UPDATE;
  IF v_reg.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_registered'); END IF;
  IF v_reg.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  SELECT count(*)::integer INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.status::text IN ('registered','playing');

  -- Money first: the release is the part that can refuse.
  v_refund := public.fn_poker_diamond_tournament_refund(
    p_tournament_id, p_user_id, 'unregister', 'fn_unregister_from_tournament', p_request_id);

  -- The same roster effects the chip authority produces, in the same order.
  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(COALESCE(prize_pool,0)-(v_refund->>'refund_prize')::numeric,2),
         bounty_pool=round(COALESCE(bounty_pool,0)-(v_refund->>'refund_bounty')::numeric,2),
         total_rake=round(COALESCE(total_rake,0)-(v_refund->>'refund_fee')::numeric,2),
         updated_at=now()
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament vanished during unregistration' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'request_id',p_request_id,
    'refunded_diamonds',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
    'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id',
    'asset','diamonds','diamonds_after',(v_refund->>'available_balance')::bigint);
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_unregister', 'migration a_retry_gets_its_first_receipt');

-- ---------------------------------------------------------------------------
-- 3. THE PRIZE PAYER ANSWERS A RETRY WITH ITS FIRST RECEIPT AND REFUSES A
--    REUSED KEY BY NAME
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)'::regprocedure)) INTO v_md5;
  IF v_md5 <> 'e246c03b5a6d2aff690d227912ff7e82' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_pay is not the pinned text (md5 %)', v_md5;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid; v_kind text; v_bank numeric; v_inserted integer; v_drained jsonb; v_credit jsonb; v_e record;
  v_category text := lower(COALESCE(p_category,''));
  v_prior public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_idempotency_key IS NULL
     OR p_amount IS NULL OR p_amount < 1 OR p_amount <> trunc(p_amount) OR p_amount > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_pay_requires_whole_diamonds' USING ERRCODE='22023';
  END IF;
  SELECT t.club_id INTO v_arena FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514'; END IF;
  v_kind := CASE WHEN v_category='bounty' THEN 'bounty'
                 WHEN v_category='prize' THEN 'prize'
                 ELSE NULL END;
  IF v_kind IS NULL THEN
    -- A refund never reaches this door: the Diamond refund authority returns
    -- entries whole through fn_poker_diamond_release.
    RAISE EXCEPTION 'diamond_tournament_pay_unknown_category:%', v_category USING ERRCODE='22023';
  END IF;

  -- The key is claimed before any Diamond moves, as the chip credit claims it.
  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES (p_idempotency_key,p_user_id,p_amount) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    -- DIAMOND PHASE 11: A RETRY GETS ITS FIRST RECEIPT. The key is the
    -- payment's identity. The same payee, event, bank and amount under it is
    -- this payment, already made: it answers as the first delivery did (true)
    -- and moves nothing. Any other use of the key - another payee, event, bank
    -- or amount, or a key another credit claimed - is refused by name, as every
    -- other Diamond door refuses a reused request id. The description is the
    -- payment's label, not its identity.
    SELECT l.* INTO v_prior FROM public.poker_diamond_tournament_ledger l
     WHERE l.idempotency_key='poker-tournament-pay:'||p_idempotency_key;
    IF NOT FOUND
       OR v_prior.kind IS DISTINCT FROM v_kind
       OR v_prior.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_prior.user_id IS DISTINCT FROM p_user_id
       OR v_prior.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'diamond_tournament_pay_key_reused' USING ERRCODE='22023';
    END IF;
    RETURN true;
  END IF;

  -- The bank this payment draws on: a place from the prize bank, a knockout
  -- (its cash half, the champion's own head, the residual) from the bounty
  -- bank. Each is the sum of the entries' parts less what it already paid.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_bank := CASE WHEN v_kind='bounty' THEN v_e.bounty_balance ELSE v_e.prize_balance END;
  IF v_bank < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_bank_short' USING ERRCODE='P0404';
  END IF;
  -- A knockout is paid while the event runs, before the terminal opens the
  -- escrow shadow; the shadow is opened here from the Diamond ledger's exact
  -- parts (idempotent, asserted) so the chip shadow never opens itself from a
  -- proportional split at the first bounty.
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);

  -- The recipient's wallet first (its journal row is what every drained
  -- row's movement carries), then the custody rows, oldest first.
  v_credit := public.add_diamonds_to_balance(
    p_user_id, p_amount::integer, 'arena_withdraw',
    COALESCE(NULLIF(btrim(p_description),''), CASE WHEN v_kind='bounty' THEN 'Tournament bounty' ELSE 'Tournament prize' END),
    'poker-tournament-pay:'||p_idempotency_key);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR NULLIF(v_credit->>'transaction_id','') IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_pay_credit_failed:%', v_credit->>'error' USING ERRCODE='P0404';
  END IF;
  v_drained := public.fn_poker_diamond_tournament_drain(
    p_tournament_id, v_kind, p_amount::bigint, 'poker-tournament-pay:'||p_idempotency_key, 'player:'||p_user_id::text,
    (v_credit->>'transaction_id')::uuid);

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,NULL,v_kind,p_amount::bigint,
    CASE WHEN v_kind='prize' THEN p_amount::bigint ELSE 0 END,
    CASE WHEN v_kind='bounty' THEN p_amount::bigint ELSE 0 END,0,
    'poker-tournament-pay:'||p_idempotency_key,(v_credit->>'transaction_id')::uuid,
    jsonb_build_object('kind',v_kind,'credit_key',p_idempotency_key,'drained',v_drained,'description',p_description));

  -- The escrow shadow follows, as a chip payment's wallet row makes it follow.
  IF v_kind='bounty' THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond bounty',p_bounty_out => p_amount);
  ELSE
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond prize',p_prize_out => p_amount);
  END IF;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  -- The answer no longer tells a payment from its retry, so the payment names
  -- its key for the one caller that must know: fn_credit_and_log writes the
  -- payout evidence once, on the call that paid. A retry names nothing.
  PERFORM set_config('app.diamond_tournament_pay_claimed', p_idempotency_key, true);
  RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_pay', 'migration a_retry_gets_its_first_receipt');

-- ---------------------------------------------------------------------------
-- 4. THE CREDIT DOOR STILL TELLS THE CALL THAT PAID FROM ITS RETRY
-- ---------------------------------------------------------------------------
DO $credit_and_log_reads_the_named_key$
DECLARE
  v_def text; v_after text; v_hits integer;
  v_old CONSTANT text := $old$  IF v_diamond THEN
    v_credited := public.fn_poker_diamond_tournament_pay(
      p_user_id, p_amount, p_idempotency_key, p_category, p_related_entity_id, p_description);
  ELSE
$old$;
  v_new CONSTANT text := $new$  IF v_diamond THEN
    -- DIAMOND PHASE 11: the payer answers a retry with its first receipt
    -- (true), so its answer no longer says whether THIS call paid. The key the
    -- payer names when it pays does: the call that paid writes the evidence
    -- below, and a retry takes the replay verification that follows, as before.
    PERFORM set_config('app.diamond_tournament_pay_claimed', '', true);
    IF public.fn_poker_diamond_tournament_pay(
         p_user_id, p_amount, p_idempotency_key, p_category, p_related_entity_id, p_description) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond tournament payment % answered no receipt', p_idempotency_key USING ERRCODE = 'P0404';
    END IF;
    v_credited := current_setting('app.diamond_tournament_pay_claimed', true) IS NOT DISTINCT FROM p_idempotency_key;
  ELSE
$new$;
BEGIN
  v_def := pg_get_functiondef('public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure);
  IF md5(v_def) <> 'e1c4ca5fd66536cc90adc9af106e3068' THEN
    RAISE EXCEPTION 'fn_credit_and_log changed (md5 %); re-read it before editing it', md5(v_def);
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the Diamond branch of fn_credit_and_log found % time(s), expected 1', v_hits;
  END IF;
  -- The key this branch reads is the one the payer installed above names.
  IF position('PERFORM set_config(''app.diamond_tournament_pay_claimed'', p_idempotency_key, true);' IN
              pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the prize payer does not name the key it paid';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure);
  IF md5(replace(v_after, v_new, v_old)) <> 'e1c4ca5fd66536cc90adc9af106e3068' THEN
    RAISE EXCEPTION 'unrelated fn_credit_and_log text changed';
  END IF;
END $credit_and_log_reads_the_named_key$;

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_bad text;
BEGIN
  -- Every edit landed exactly as written.
  IF md5(pg_get_functiondef('public.fn_purchase_feature_v2(uuid,text,uuid)'::regprocedure)) <> '122d227c5571dc0ae34e4a351cd16453'
     OR md5(pg_get_functiondef('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)'::regprocedure)) <> '6e3a82f7b5bf8e1f10d44e34fe214117'
     OR md5(pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)'::regprocedure)) <> '19cd9ea4fb671379fe84f05d409812a1'
     OR md5(pg_get_functiondef('public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)'::regprocedure)) <> '3ede19642ab1ca18b7e185caae03d192' THEN
    RAISE EXCEPTION 'a retry does not get its first receipt: an edit did not land as written';
  END IF;
  -- The grants are the estate's: three owner-only money doors, and the store
  -- the browser calls, which no anonymous caller reaches.
  IF has_function_privilege('anon', 'public.fn_purchase_feature_v2(uuid,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_purchase_feature_v2(uuid,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_purchase_feature_v2(uuid,text,uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role)
                 CROSS JOIN unnest(ARRAY['public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)',
                                         'public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)',
                                         'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)']) f(sig)
                 WHERE has_function_privilege(r.role, f.sig, 'EXECUTE')) THEN
    RAISE EXCEPTION 'a money door''s grants changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a retry gets its first receipt: the store, the withdrawal and the prize payer answer a retry as they answered it first, a reused key is refused by name, fn_credit_and_log answers as before, nothing opened';
END $m$;

COMMIT;
