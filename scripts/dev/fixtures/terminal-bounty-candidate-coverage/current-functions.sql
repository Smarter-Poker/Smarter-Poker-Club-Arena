CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_t public.tournaments%ROWTYPE;
  v_canonical_winner uuid;
  v_winner_count integer;
  v_receipt public.tournament_bounty_completion_receipts%ROWTYPE;
  v_core_t record;
  v_residual numeric;
  v_own numeric;
  v_paid numeric;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND pool_finalized_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.pool_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.pool_result;
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND pool_finalized_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.pool_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.pool_result;
  END IF;
  SELECT count(DISTINCT tp.user_id),(array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count,v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='winner' AND tp.position=1;
  IF v_winner_count<>1 OR p_winner_user_id IS DISTINCT FROM v_canonical_winner THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_tournament_winner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
              WHERE r.tournament_id=p_tournament_id
                AND r.winner_user_id IS DISTINCT FROM p_winner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','completion_winner_conflict');
  END IF;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  IF COALESCE(v_t.is_mystery_bounty,false)
     AND v_t.mystery_bounty_stage IS DISTINCT FROM 'pending'
     AND NOT EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
                      WHERE r.tournament_id=p_tournament_id
                        AND r.mystery_settled_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','mystery_bounty_not_settled');
  END IF;
  -- Keep the complete audited payer in this public root. The temporary
  -- rolling-deployment body can therefore be dropped after engine cutover
  -- without taking tournament completion with it.
  <<finalize_bounty_core>>
  BEGIN
    SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_pool,
           bounty_pool_paid
      INTO v_core_t
      FROM tournaments
     WHERE id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'not_found');
      EXIT finalize_bounty_core;
    END IF;
    IF NOT (COALESCE(v_core_t.is_bounty,false)
            OR COALESCE(v_core_t.is_pko,false)
            OR COALESCE(v_core_t.is_mystery_bounty,false)) THEN
      v_result := jsonb_build_object(
        'ok', true, 'residual', 0, 'reason', 'not_a_bounty_tournament');
      EXIT finalize_bounty_core;
    END IF;

    IF COALESCE(v_core_t.bounty_pool, 0) <= 0 THEN
      SELECT COALESCE(NULLIF(current_bounty,0),
                      NULLIF(mystery_bounty_value,0), 0)
        INTO v_own
        FROM tournament_players
       WHERE tournament_id = p_tournament_id
         AND user_id = p_winner_user_id;
      IF COALESCE(v_own,0) <= 0 OR p_winner_user_id IS NULL THEN
        v_result := jsonb_build_object(
          'ok', true, 'residual', 0, 'funded', false);
        EXIT finalize_bounty_core;
      END IF;
      v_prior := COALESCE((
        SELECT debt.amount_paid FROM public.tournament_obligations debt
         WHERE debt.tournament_id = p_tournament_id
           AND debt.kind = 'bounty_residual'
           AND debt.place IS NULL
           AND debt.user_id = p_winner_user_id), 0);
      v_settle := public.fn_settle_tournament_obligation(
        p_tournament_id, 'bounty_residual', NULL, p_winner_user_id,
        round(v_prior + v_own, 2), 'fn_finalize_bounty_pool',
        'Tournament champion: own bounty head collected');
      IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
        RAISE EXCEPTION
          'fn_finalize_bounty_pool: own bounty head of % to % in tournament % refused (%)',
          v_own, p_winner_user_id, p_tournament_id,
          COALESCE(v_settle->>'refused_reason', 'unknown');
      END IF;
      UPDATE tournament_players
         SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_own, 2),
             current_bounty = 0
       WHERE tournament_id = p_tournament_id
         AND user_id = p_winner_user_id;
      v_result := jsonb_build_object(
        'ok', true, 'residual', v_own, 'funded', false,
        'paid_to', p_winner_user_id);
      EXIT finalize_bounty_core;
    END IF;

    SELECT round(COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                  ELSE wt.amount END), 0), 2)
      INTO v_paid
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';
    -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
      SELECT e.bounty_out INTO v_paid
        FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
    END IF;

    v_residual := round(
      COALESCE(v_core_t.bounty_pool,0) - COALESCE(v_paid,0), 2);

    IF COALESCE(v_core_t.bounty_pool_paid,0)
         IS DISTINCT FROM COALESCE(v_paid,0) THEN
      UPDATE tournaments
         SET bounty_pool_paid = COALESCE(v_paid,0)
       WHERE id = p_tournament_id;
    END IF;

    IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
      v_result := jsonb_build_object(
        'ok', true, 'residual', GREATEST(v_residual,0),
        'funded', true, 'ledger_paid', v_paid);
      EXIT finalize_bounty_core;
    END IF;

    v_prior := COALESCE((
      SELECT debt.amount_paid FROM public.tournament_obligations debt
       WHERE debt.tournament_id = p_tournament_id
         AND debt.kind = 'bounty_residual'
         AND debt.place IS NULL
         AND debt.user_id = p_winner_user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      p_tournament_id, 'bounty_residual', NULL, p_winner_user_id,
      round(v_prior + v_residual, 2), 'fn_finalize_bounty_pool',
      'Unclaimed bounty pool awarded to champion');
    IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
      RAISE EXCEPTION
        'fn_finalize_bounty_pool: residual of % to % in tournament % refused (%)',
        v_residual, p_winner_user_id, p_tournament_id,
        COALESCE(v_settle->>'refused_reason', 'unknown');
    END IF;

    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(v_paid,0) + v_residual, 2)
     WHERE id = p_tournament_id;
    UPDATE tournament_players
       SET bounty_winnings = round(
             COALESCE(bounty_winnings,0) + v_residual, 2),
           current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND user_id = p_winner_user_id;

    v_result := jsonb_build_object(
      'ok', true, 'residual', v_residual, 'funded', true,
      'ledger_paid', v_paid, 'paid_to', p_winner_user_id);
  END finalize_bounty_core;

  IF COALESCE((v_result->>'ok')::boolean,false) THEN
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,pool_finalized_at,pool_result,updated_at)
    VALUES (p_tournament_id,p_winner_user_id,now(),v_result,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET pool_finalized_at=COALESCE(public.tournament_bounty_completion_receipts.pool_finalized_at,EXCLUDED.pool_finalized_at),
          pool_result=COALESCE(public.tournament_bounty_completion_receipts.pool_result,EXCLUDED.pool_result),
          winner_user_id=COALESCE(public.tournament_bounty_completion_receipts.winner_user_id,EXCLUDED.winner_user_id),
          updated_at=now();
  END IF;
  RETURN v_result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_settle(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_step jsonb;
  v_canonical_winner uuid;
  v_winner_count integer;
  v_receipt public.tournament_bounty_completion_receipts%ROWTYPE;
  v_award record;
  v_pool bigint;
  v_paid bigint;
  v_unclaimed bigint;
  v_stage text;
  v_core_award record;
  v_funded numeric;
  v_ledger numeric;
  v_room bigint;
  v_residual bigint;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_global();
  -- A completed terminal receipt is the answer even after awards were voided,
  -- the stage changed, or standings were archived.  Those mutable rows cannot
  -- be used to reconstruct a prior result.
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND mystery_settled_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.mystery_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.mystery_result;
  END IF;
  PERFORM 1 FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO v_receipt FROM public.tournament_bounty_completion_receipts
   WHERE tournament_id=p_tournament_id AND mystery_settled_at IS NOT NULL;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR jsonb_typeof(v_receipt.mystery_result) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'reason','completion_receipt_conflict');
    END IF;
    RETURN v_receipt.mystery_result;
  END IF;
  SELECT count(DISTINCT tp.user_id),(array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count,v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='winner' AND tp.position=1;
  IF v_winner_count<>1 OR p_winner_user_id IS DISTINCT FROM v_canonical_winner THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_tournament_winner');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
              WHERE r.tournament_id=p_tournament_id
                AND r.winner_user_id IS DISTINCT FROM p_winner_user_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','completion_winner_conflict');
  END IF;
  -- Reserved/revealed awards are earned debts, not inventory the champion may
  -- absorb.  Resolve each exact award under the tournament lock before the
  -- historical terminal body calculates the genuinely unclaimed inventory.
  FOR v_award IN
    SELECT a.id,a.status FROM public.tournament_bounty_awards a
     WHERE a.tournament_id=p_tournament_id
       AND a.status IN ('reserved','revealed','paid')
     ORDER BY a.id FOR UPDATE
  LOOP
    IF v_award.status='reserved' THEN
      v_step := public.fn_mystery_bounty_reveal(v_award.id,NULL,true);
      IF NOT COALESCE((v_step->>'ok')::boolean,false) THEN
        RAISE EXCEPTION 'terminal mystery reveal refused for award %: %',
          v_award.id,COALESCE(v_step::text,'null') USING ERRCODE='check_violation';
      END IF;
    END IF;
    v_step := public.fn_mystery_bounty_pay(v_award.id);
    IF NOT COALESCE((v_step->>'ok')::boolean,false)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.id=v_award.id AND a.status='completed'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_bounty_award_recipients r
               WHERE r.award_id=a.id AND r.paid_at IS NULL
            )
       ) THEN
      RAISE EXCEPTION 'terminal mystery payment incomplete for award %: %',
        v_award.id,COALESCE(v_step::text,'null') USING ERRCODE='check_violation';
    END IF;
  END LOOP;
  IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_bounty_obligations');
  END IF;
  -- Inline the complete audited closeout. Stage two removes the temporary
  -- unguarded body, so the live terminal root must retain no hidden delegate.
  <<mystery_settle_core>>
  BEGIN
    SELECT mystery_bounty_stage,
           COALESCE(mystery_bounty_pool_cents, 0),
           COALESCE(bounty_pool, 0)
      INTO v_stage, v_pool, v_funded
      FROM public.tournaments
     WHERE id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'tournament_not_found');
      EXIT mystery_settle_core;
    END IF;
    IF v_stage = 'pending' THEN
      v_result := jsonb_build_object(
        'ok', true, 'reason', 'never_activated', 'unclaimed_cents', 0,
        'pool_cents', 0, 'settled_cents', 0, 'balanced', true,
        'variance_cents', 0);
      EXIT mystery_settle_core;
    END IF;

    FOR v_core_award IN
      SELECT id FROM public.tournament_bounty_awards
       WHERE tournament_id = p_tournament_id
         AND status = 'revealed'
       ORDER BY id
       FOR UPDATE
    LOOP
      PERFORM public.fn_mystery_bounty_pay(v_core_award.id);
    END LOOP;

    SELECT COALESCE(sum(r.amount_cents), 0)
      INTO v_paid
      FROM public.tournament_bounty_award_recipients r
      JOIN public.tournament_bounty_awards a ON a.id = r.award_id
     WHERE a.tournament_id = p_tournament_id
       AND r.paid_at IS NOT NULL;

    SELECT COALESCE(sum(amount_cents), 0)
      INTO v_unclaimed
      FROM public.tournament_bounty_chests
     WHERE tournament_id = p_tournament_id
       AND status IN ('available','reserved','revealed');

    v_residual := v_unclaimed;
    IF v_residual > 0 AND v_funded > 0 THEN
      SELECT round(COALESCE(SUM(
               CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                    ELSE wt.amount END), 0), 2)
        INTO v_ledger
        FROM wallet_transactions wt
       WHERE wt.related_entity_id = p_tournament_id
         AND wt.category = 'bounty';
      -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
      IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
        SELECT e.bounty_out INTO v_ledger
          FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
      END IF;

      v_room := GREATEST(
        0, floor((v_funded - COALESCE(v_ledger, 0)) * 100))::bigint;
      IF v_residual > v_room THEN
        INSERT INTO financial_alerts (severity, source, message, context)
        VALUES (
          'critical', 'fn_mystery_bounty_settle',
          'Champion residual clamped: the unclaimed chests are worth more than the bounty pool still holds',
          jsonb_build_object(
            'tournament_id', p_tournament_id,
            'unclaimed_cents', v_unclaimed,
            'room_cents', v_room,
            'ledger_paid', v_ledger,
            'bounty_pool', v_funded,
            'detail', 'the clamp is not the bug, it is the seatbelt -- find the payer that already spent the pool'));
        v_residual := v_room;
      END IF;
    END IF;

    IF p_winner_user_id IS NOT NULL THEN
      IF v_residual > 0 THEN
        v_prior := COALESCE((
          SELECT debt.amount_paid FROM public.tournament_obligations debt
           WHERE debt.tournament_id = p_tournament_id
             AND debt.kind = 'mystery_bounty'
             AND debt.place IS NULL
             AND debt.user_id = p_winner_user_id), 0);
        v_settle := public.fn_settle_tournament_obligation(
          p_tournament_id, 'mystery_bounty', NULL, p_winner_user_id,
          round(v_prior + (v_residual / 100.0), 2),
          'fn_mystery_bounty_settle',
          'Unclaimed mystery bounty chests awarded to champion');
        IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
          RAISE EXCEPTION
            'fn_mystery_bounty_settle: residual of % cents to % in tournament % refused (%)',
            v_residual, p_winner_user_id, p_tournament_id,
            COALESCE(v_settle->>'refused_reason', 'unknown');
        END IF;
        UPDATE public.tournament_players
           SET bounty_winnings = round(
                 COALESCE(bounty_winnings, 0) + (v_residual / 100.0), 2)
         WHERE tournament_id = p_tournament_id
           AND user_id = p_winner_user_id;
        UPDATE public.tournaments
           SET bounty_pool_paid = round(
                 COALESCE(bounty_pool_paid, 0) + (v_residual / 100.0), 2)
         WHERE id = p_tournament_id;
        v_paid := v_paid + v_residual;
      END IF;

      UPDATE public.tournament_bounty_awards a
         SET status = 'void'
       WHERE a.tournament_id = p_tournament_id
         AND a.status <> 'completed'
         AND EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.id = a.chest_id
              AND c.status IN ('available','reserved','revealed'));

      UPDATE public.tournament_bounty_chests
         SET status = 'void'
       WHERE tournament_id = p_tournament_id
         AND status IN ('available','reserved','revealed');
    END IF;

    UPDATE public.tournaments
       SET mystery_bounty_stage = 'complete'
     WHERE id = p_tournament_id;

    v_result := jsonb_build_object(
      'ok', true, 'pool_cents', v_pool, 'settled_cents', v_paid,
      'unclaimed_cents', v_unclaimed, 'residual_paid_cents', v_residual,
      'balanced', v_paid = v_pool, 'variance_cents', v_paid - v_pool);
  END mystery_settle_core;

  IF NOT COALESCE((v_result->>'ok')::boolean,false)
     OR NOT COALESCE((v_result->>'balanced')::boolean,false) THEN
    -- The historical body can already have paid a clamp/residual or voided a
    -- chest before reporting imbalance. A normal RETURN would commit that
    -- partial terminal state. The guarded contract is all-or-nothing.
    RAISE EXCEPTION 'mystery bounty settlement refused or unbalanced: %',v_result
      USING ERRCODE='check_violation';
  END IF;
  INSERT INTO public.tournament_bounty_completion_receipts
    (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
  VALUES (p_tournament_id,p_winner_user_id,now(),v_result,now())
  ON CONFLICT (tournament_id) DO UPDATE
    SET mystery_settled_at=COALESCE(public.tournament_bounty_completion_receipts.mystery_settled_at,EXCLUDED.mystery_settled_at),
        mystery_result=COALESCE(public.tournament_bounty_completion_receipts.mystery_result,EXCLUDED.mystery_result),
        winner_user_id=COALESCE(public.tournament_bounty_completion_receipts.winner_user_id,EXCLUDED.winner_user_id),
        updated_at=now();
  RETURN v_result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_tournament_has_unsettled_bounties(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.state='pending'
    )
    OR EXISTS (
      -- `settled` is only a cache of the marker trigger's last verdict. The
      -- canonical ledger/award can never be allowed to drift underneath it:
      -- finalisation re-proves the complete generation marker every time.
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.state='settled'
         AND NOT public.fn_bounty_obligation_has_complete_marker(o.id)
    )
    OR EXISTS (
      SELECT 1 FROM public.tournament_bounty_awards a
       WHERE a.tournament_id=p_tournament_id AND a.status IN ('reserved','revealed','paid')
    );
$function$
;
