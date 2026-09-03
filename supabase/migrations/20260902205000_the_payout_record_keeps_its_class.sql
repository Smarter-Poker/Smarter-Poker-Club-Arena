-- THE PAYOUT RECORD KEEPS ITS CLASS
-- Chip Accounting Standard, Lane A follow-up (2026-09-02, cutover watch, second
-- finding, still before any engine build had called this function live).
--
-- tournament_payouts.source is the CLASS of a payment: 'structure', 'reconcile',
-- 'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'spin_backpay',
-- 'overlay_backpay', and the bounty classes. Downstream detectors filter on it:
--
--   fn_tournament_guarantee_check        whitelist (structure, reconcile, hu_shortfall,
--                                        late_reg_adjustment, final_table_deal, spin_backpay)
--   fn_tournament_double_paid_obligations whitelist (structure, reconcile, overlay_backpay, spin_backpay)
--   fn_payout_guarantee_check            blacklist (bounty, own_bounty, mystery_bounty_residual)
--   fn_tournament_payout_reconcile       whitelist OR the obligation key shape (Lane A3)
--
-- fn_settle_tournament_obligation passed the caller's p_source straight through
-- as the payout row's source. The engine (PR #2671) calls it with its own
-- provenance - 'engine.eliminatePlayer', 'engine.finishTournament',
-- 'engine.recalculateEliminatedPrizes', 'engine.settleFinalTableDeal',
-- 'engine.processSatelliteAwards', 'engine.recoverStuckCompleting',
-- 'engine.refundAndCloseCancelledTournament' - so from the first engine-paid
-- place, fn_tournament_guarantee_check would have counted that place as UNPAID
-- and fn_tournament_double_paid_obligations would have stopped seeing engine
-- payments at all. Silent blindness in one detector, false alarms in the other.
--
-- Now the payout row gets the class: a known class name passed by a DB arm is
-- kept ('reconcile' stays 'reconcile'); otherwise the class is derived from the
-- obligation kind (late_reg_adjustment / final_table_deal / bubble_protection /
-- satellite_remainder by name, everything else that is a place is 'structure').
-- The caller's provenance is still recorded, on tournament_obligations.source.
--
-- Also carries Lane A3's key rename ('tourney:<tid>:obl:<id>:<cents>', so
-- fn_credit_player_wallet_once resolves the right club wallet) and the bounty
-- exclusion list from 20260902194500, so this file is the whole live body.
-- One statement, one transaction.

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
    RETURN jsonb_build_object('ok', true, 'paid', 0, 'already_paid', v_ob.amount_paid,
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

  -- R1-lite: the prize-pool kinds cannot exceed the pool in total.
  -- Only rows paid FROM the prize pool count; bounty-pool rows (see v_not_pool)
  -- are a different liability and are capped by their own pool.
  IF v_row_kind = ANY (v_pool_kinds) THEN
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
         updated_at  = now(),
         settled_at  = CASE WHEN amount_paid + v_pay >= amount_owed THEN now() ELSE settled_at END
   WHERE id = v_ob.id;

  RETURN jsonb_build_object('ok', true, 'paid', v_pay, 'already_paid', v_ob.amount_paid,
    'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', v_key);
END;
$function$;

-- ACL restated for the repo's definer gate; unchanged in production.
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid) TO service_role;

COMMIT;
