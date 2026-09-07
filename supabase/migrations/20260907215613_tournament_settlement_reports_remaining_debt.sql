-- Report the entire recorded obligation after a successful operation.
-- The original function returns ok=true after paying 99.99 of 100.00.
-- Additive result fields distinguish operation success from full settlement,
-- including a replay that requests less than the durable amount owed.
-- No payment amount, funding source, keys, historical rows or payout policy change.
-- Rollback probes exercised the actual body with pg_temp bank/credit helpers:
-- partial credit, stale smaller replay, final cent, full replay and refusal.
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid, p_amount numeric, p_source text, p_description text DEFAULT NULL::text, p_adjustment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind        text := lower(btrim(COALESCE(p_kind, '')));
  v_row_kind    text;
  v_place       integer;
  v_amount      numeric := round(COALESCE(p_amount, 0), 2);
  v_t           record;
  v_ob          public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_owed        numeric;
  v_pay         numeric;
  v_key         text;
  v_category    text;
  v_desc        text;
  v_pool_kinds  text[] := ARRAY['place','late_reg_adjustment','bubble_protection','final_table_deal','satellite_remainder','seat'];
  -- Rows paid from the BOUNTY pool (or recorded on the target by a satellite),
  -- never from the prize pool. Everything else counts against the pool.
  v_not_pool    text[] := ARRAY['satellite_seat','bounty','mystery_bounty','bounty_residual','own_bounty','mystery_bounty_residual'];
  v_paid_pool   numeric := 0;
  v_credited    boolean;
  v_alert_ctx   jsonb;
  v_payout_source text;
  v_adj         public.ca_manual_adjustments%ROWTYPE;
  v_src         text := lower(btrim(COALESCE(p_source, '')));
  v_can         jsonb;
  v_short       numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'missing_ids', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty','refund','seat',
                    'satellite_remainder','bubble_protection','final_table_deal','late_reg_adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'unknown_kind', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_amount < 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'negative_amount', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- A late-registration top-up is the SAME obligation as the place it corrects:
  -- it carries the new total and the difference is what moves.
  v_row_kind := CASE WHEN v_kind = 'late_reg_adjustment' THEN 'place' ELSE v_kind END;
  v_place    := CASE WHEN v_row_kind IN ('place') THEN p_place ELSE NULL END;
  IF v_row_kind = 'place' AND v_place IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'place_required', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Kill switch (Lane E): an open freeze on tournament payouts refuses everything.
  IF to_regclass('public.ca_payout_freeze') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                WHERE f.scope = 'tournament_payouts' AND f.cleared_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'payout_frozen', 'obligation_id', NULL, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* CHIP STANDARD PHASE 6.1 (2026-09-05): A SETTLEMENT FROM OUTSIDE THE
     PLATFORM NEEDS AN APPROVED ADJUSTMENT. The engine, the recovery and the
     registered doors settle under their own names (ca_settle_sources). Any
     other caller - a migration, an operator, an agent under CLAUDE.md 10.9 -
     must name a ca_manual_adjustments row that is approved, for this event,
     this player, at least this amount, in chips; the row is marked settled
     when the chips move and the obligation carries its id. p_adjustment_id
     was accepted and ignored until today. */
  IF NOT (v_src LIKE 'engine.%' OR EXISTS (SELECT 1 FROM public.ca_settle_sources s WHERE s.source = v_src)) THEN
    IF p_adjustment_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'adjustment_required', 'obligation_id', NULL, 'idempotency_key', NULL,
        'detail', format('source %s is not a platform settle source; name an approved ca_manual_adjustments row (fn_ca_adjustment_under_10_9 writes one)', COALESCE(NULLIF(v_src, ''), '<none>')));
    END IF;
    SELECT * INTO v_adj FROM public.ca_manual_adjustments WHERE id = p_adjustment_id FOR UPDATE;
    IF NOT FOUND OR v_adj.status <> 'approved' OR v_adj.asset <> 'chips'
       OR v_adj.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_adj.target_kind <> 'player_wallet' OR v_adj.target_id IS DISTINCT FROM p_user_id
       OR v_adj.amount < v_amount THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'adjustment_mismatch', 'obligation_id', NULL, 'idempotency_key', NULL,
        'detail', 'the adjustment must be approved, in chips, for this tournament, this player wallet, and at least this amount');
    END IF;
  END IF;

  SELECT t.id, t.name, t.club_id, t.prize_pool, t.bounty_pool, t.bounty_pool_paid, t.status
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'tournament_not_found', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Upsert the obligation. amount_owed only ever rises.
  IF v_place IS NOT NULL THEN
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place = v_place
     FOR UPDATE;
  ELSE
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place IS NULL AND user_id = p_user_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    -- Legacy seeding: what did the old key shapes already pay for this obligation?
    IF v_place IS NOT NULL THEN
      SELECT COALESCE(sum(tp.amount), 0) INTO v_seeded_paid
        FROM public.tournament_payouts tp
       WHERE tp.tournament_id = p_tournament_id AND tp."position" = v_place
         AND COALESCE(tp.source, '') NOT IN ('satellite_seat');
    ELSIF v_row_kind = 'refund' THEN
      SELECT COALESCE(sum(w.amount), 0) INTO v_seeded_paid
        FROM public.wallet_transactions w
       WHERE w.related_entity_id = p_tournament_id AND w.user_id = p_user_id
         AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    END IF;
    v_seeded_paid := round(v_seeded_paid, 2);
    v_owed := GREATEST(v_amount, v_seeded_paid);

    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
    VALUES (p_tournament_id, v_row_kind, v_place, p_user_id, v_owed, v_seeded_paid, p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_amount > v_ob.amount_owed THEN
      UPDATE public.tournament_obligations
         SET amount_owed = v_amount, updated_at = now(), user_id = COALESCE(user_id, p_user_id)
       WHERE id = v_ob.id
       RETURNING * INTO v_ob;
    END IF;
  END IF;

  -- The player on record for a place is whoever was first paid for it; a
  -- different user asking for an already-paid place gets a refusal, not chips.
  IF v_place IS NOT NULL AND v_ob.user_id IS NOT NULL AND v_ob.user_id <> p_user_id AND v_ob.amount_paid > 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'place_paid_to_another_user', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  v_pay := round(LEAST(v_amount, v_ob.amount_owed) - v_ob.amount_paid, 2);
  IF v_pay <= 0 THEN
    -- A replay of an older, smaller request can still leave the recorded
    -- obligation unpaid. Report the durable total, not the caller's amount.
    RETURN jsonb_build_object('ok', true, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'amount_owed', v_ob.amount_owed, 'amount_paid', v_ob.amount_paid,
      'remaining', GREATEST(0, v_ob.amount_owed - v_ob.amount_paid),
      'fully_settled', v_ob.amount_paid >= v_ob.amount_owed,
      'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R2b: one finisher, one place.
  IF v_row_kind = 'place' THEN
    IF EXISTS (SELECT 1 FROM public.tournament_obligations o
                WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
                  AND o.user_id = p_user_id AND o.place <> v_place AND o.amount_paid > 0) THEN
      v_alert_ctx := jsonb_build_object('kind','second_place_prize_refused','tournament_id',p_tournament_id,
        'user_id',p_user_id,'place',v_place,'amount',v_pay,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused a second structure place: this player already holds a paid place in tournament %s', p_tournament_id),
        v_alert_ctx, 'obl:second_place:' || p_tournament_id::text || ':' || p_user_id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'player_already_holds_a_place', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* R1 (chip standard Phase 5.1, 2026-09-04): the ESCROW BALANCE decides.
     tournament_escrow holds what the event holds, per bank; a place is paid
     from the prize bank, a bounty from the bounty bank, a refund from all
     three. When the balance knows the event, the counter cap below is not
     consulted; the escrow trigger refuses again inside the credit if a race
     gets past this read. An event the balance has never seen (opened on its
     first row) keeps the old counter cap for this call. */
  v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);

  /* A BANK THAT IS SHORT PAYS WHAT IT HOLDS (2026-09-07). This used to refuse
     the whole payment, so a bank 180.00 short of a 13,441.68 obligation paid
     the winner nothing and froze 13,261.68 - three events were sitting like
     that when this was written. Paying what is there takes nothing from
     anybody: amount_owed is untouched, so the remainder stays owed and
     payable, and the credit is still capped by the bank and refused again by
     the escrow trigger if a race gets past this read. */
  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean
     AND COALESCE((v_can->>'available')::numeric, 0) >= 0.01 THEN
    v_short := round(v_pay - (v_can->>'available')::numeric, 2);
    v_pay   := round((v_can->>'available')::numeric, 2);
    v_alert_ctx := jsonb_build_object('kind','escrow_short_paid_what_it_holds',
      'tournament_id',p_tournament_id,'tournament',v_t.name,'user_id',p_user_id,
      'obligation_kind',v_kind,'place',v_place,'paid',v_pay,'still_owed',v_short,
      'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,
      'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Paid %s of %s to %s for %s and %s is still owed: the escrow bank was short (%s)',
             v_pay, v_pay + v_short, p_user_id, v_kind, v_short, v_t.name),
      v_alert_ctx, 'obl:escrow_short_partial:' || v_ob.id::text);
    v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);
  END IF;

  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean THEN
    v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
      'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
      'escrow_available',(v_can->>'available')::numeric,'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Refused %s to %s for %s: the escrow holds %s for that bank (%s)',
             v_pay, p_user_id, v_kind, (v_can->>'available')::numeric, v_t.name),
      v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R1-lite (counter cap), only for an event the balance has never seen.
  IF v_row_kind = ANY (v_pool_kinds) AND NOT (v_can->>'known')::boolean THEN
    SELECT COALESCE(sum(tp.amount), 0) INTO v_paid_pool
      FROM public.tournament_payouts tp
     WHERE tp.tournament_id = p_tournament_id
       AND NOT (COALESCE(tp.source, '') = ANY (v_not_pool));
    IF v_paid_pool + v_pay > COALESCE(v_t.prize_pool, 0) + 0.05 THEN
      v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
        'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
        'paid_from_pool_so_far',v_paid_pool,'prize_pool',v_t.prize_pool,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused %s to %s for %s: the prize pool of %s has already paid %s (%s)',
               v_pay, p_user_id, v_kind, round(COALESCE(v_t.prize_pool,0),2), v_paid_pool, v_t.name),
        v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* THE KEY NAMES THE TOURNAMENT (Lane A3, 2026-09-02). fn_credit_player_wallet_once
     resolves WHICH club wallet to credit from a 'tourney:<id>:...' key
     (tournament_players.club_id for that entry); any other shape falls back to
     fn_player_home_club, which is the club the player joined FIRST, not the
     club they bought in from. Measured in the rolled-back probe: 3 of 4 places
     landed in the wrong club under the old 'obl:<id>:<n>' shape. No 'obl:' key
     was ever spent in production, so the rename costs nothing. */
  v_key := 'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':' || (round(v_ob.amount_paid * 100))::bigint::text;
  v_category := CASE
                  WHEN v_row_kind IN ('bounty','bounty_residual','mystery_bounty') THEN 'bounty'
                  WHEN v_row_kind = 'refund' THEN 'refund'
                  ELSE 'prize'
                END;
  /* THE PAYOUT RECORD KEEPS ITS CLASS (2026-09-02). tournament_payouts.source is
     the CLASS of a payment ('structure', 'reconcile', 'late_reg_adjustment',
     'final_table_deal', ...) and every detector downstream filters on it:
     fn_tournament_guarantee_check and fn_tournament_double_paid_obligations
     whitelist it, fn_payout_guarantee_check blacklists the bounty classes. The
     engine calls this function with its own provenance ('engine.finishTournament'
     and friends), which the first build wrote straight into that column - so
     the moment the engine cut over, the guarantee check would have counted
     every engine-paid place as unpaid. Provenance stays on
     tournament_obligations.source; the payout row gets the class. */
  v_payout_source := CASE
    WHEN lower(COALESCE(p_source, '')) IN ('structure','reconcile','hu_shortfall','spin_backpay',
         'overlay_backpay','late_reg_adjustment','final_table_deal','bubble_protection',
         'satellite_remainder','clawback') THEN lower(p_source)
    WHEN v_kind = 'late_reg_adjustment' THEN 'late_reg_adjustment'
    WHEN v_row_kind IN ('final_table_deal','bubble_protection','satellite_remainder') THEN v_row_kind
    ELSE 'structure'
  END;
  v_desc := COALESCE(NULLIF(btrim(p_description), ''),
              CASE
                WHEN v_row_kind = 'place' THEN format('Tournament prize: position %s', v_place)
                WHEN v_row_kind = 'refund' THEN 'Tournament refund'
                ELSE format('Tournament %s', replace(v_row_kind, '_', ' '))
              END);

  PERFORM set_config('app.money_path', 'fn_settle_tournament_obligation', true);

  -- Guard against a key that was already spent while the obligation says otherwise:
  -- that means the obligation row was rebuilt without its payments, and paying
  -- again would be exactly the bug this function exists to end.
  IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key) THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation: key % already spent while obligation % shows paid %; refusing',
      v_key, v_ob.id, v_ob.amount_paid;
  END IF;

  v_credited := public.fn_credit_and_log(
    p_user_id, v_pay, v_key, v_category, v_desc, p_tournament_id,
    'PLAYER', NULL, NULL,
    CASE WHEN v_category = 'prize' THEN v_place ELSE NULL END,
    CASE WHEN v_category = 'prize' THEN v_payout_source ELSE NULL END);

  PERFORM set_config('app.money_path', '', true);

  IF NOT v_credited THEN
    -- fn_credit_and_log returns false only when the key was already spent or a
    -- guard inside it refused; either way no chips moved for THIS call.
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'credit_refused', 'obligation_id', v_ob.id, 'idempotency_key', v_key);
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         user_id     = COALESCE(user_id, p_user_id),
         source      = COALESCE(p_source, source),
         adjustment_id = COALESCE(adjustment_id, p_adjustment_id),
         updated_at  = now(),
         settled_at  = CASE WHEN amount_paid + v_pay >= amount_owed THEN now() ELSE settled_at END
   WHERE id = v_ob.id;
  IF v_adj.id IS NOT NULL THEN
    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj.id;
  END IF;

  -- ok acknowledges this operation; it is not proof that the entire debt
  -- was paid. v_ob holds the pre-credit row, so include this call's v_pay.
  RETURN jsonb_build_object('ok', true, 'paid', v_pay, 'already_paid', v_ob.amount_paid,
    'amount_owed', v_ob.amount_owed, 'amount_paid', v_ob.amount_paid + v_pay,
    'remaining', GREATEST(0, v_ob.amount_owed - v_ob.amount_paid - v_pay),
    'fully_settled', v_ob.amount_paid + v_pay >= v_ob.amount_owed,
    'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', v_key);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid) TO service_role;
COMMIT;
