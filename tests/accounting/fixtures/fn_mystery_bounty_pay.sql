CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay(p_award_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_a record;
  v_r record;
  v_paid bigint := 0;
  v_credited boolean;
  v_refused integer := 0;
  v_chest_status text;
  v_prior numeric;
  v_settle jsonb;
BEGIN
  -- This award's tournament lane (2026-09-10). It used to take the GLOBAL
  -- lane - G and B exclusive - only because it is keyed by award id, so every
  -- call held every hand settlement on the platform, and inside the
  -- per-tournament bounty sweep it was a G shared -> exclusive upgrade. An
  -- award's tournament never changes, so read it, take that lane, and read it
  -- again under the lane. An award not found yet takes the whole lane (the
  -- helper's NULL branch), so a not-found answer is still only given after
  -- any in-flight writer has committed - exactly as before.
  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id=p_award_id;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(v_tournament_id);
  SELECT a.tournament_id INTO v_tournament_id
    FROM public.tournament_bounty_awards a WHERE a.id=p_award_id;
  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','award_not_found');
  END IF;
  PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  -- The unguarded payer owns the exact award before it writes obligation and
  -- wallet evidence. Own every terminal-visible set in the same canonical
  -- tournament -> obligations -> chests -> awards -> recipients order first;
  -- its later row locks are then transaction-local reacquisitions.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = v_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.user_id,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = v_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = v_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_award_recipients r
   JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = v_tournament_id
   ORDER BY r.user_id,r.id FOR UPDATE OF r;
  -- The payer itself is static in this root. Stage two can remove the
  -- temporary unguarded copy without leaving an undefined runtime call.
  SELECT * INTO v_a
    FROM public.tournament_bounty_awards
   WHERE id = p_award_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found');
  END IF;

  IF v_a.status = 'completed' THEN
    IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
         AND public.fn_bounty_obligation_has_complete_marker(o.id)
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','completed_award_marker_incomplete',
        'award_id',p_award_id);
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'award_id', p_award_id,
      'amount_cents', v_a.amount_cents);
  END IF;
  IF v_a.status = 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_revealed');
  END IF;
  IF v_a.status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'award_voided_by_settlement',
      'award_id', p_award_id);
  END IF;

  SELECT status INTO v_chest_status
    FROM public.tournament_bounty_chests
   WHERE id = v_a.chest_id;
  IF v_chest_status = 'void' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'chest_settled_to_champion',
      'award_id', p_award_id);
  END IF;

  FOR v_r IN
    SELECT * FROM public.tournament_bounty_award_recipients
     WHERE award_id = p_award_id
       AND paid_at IS NULL
       AND amount_cents > 0
     ORDER BY user_id
     FOR UPDATE
  LOOP
    v_prior := COALESCE((
      SELECT o.amount_paid FROM public.tournament_obligations o
       WHERE o.tournament_id = v_a.tournament_id
         AND o.kind = 'mystery_bounty'
         AND o.place IS NULL
         AND o.user_id = v_r.user_id), 0);
    v_settle := public.fn_settle_tournament_obligation(
      v_a.tournament_id, 'mystery_bounty', NULL, v_r.user_id,
      round(v_prior + (v_r.amount_cents / 100.0), 2),
      'fn_mystery_bounty_pay',
      'Mystery bounty revealed from eliminated player');
    v_credited := COALESCE((v_settle->>'ok')::boolean, false);

    IF COALESCE(v_credited, false)
       AND round(COALESCE((v_settle->>'paid')::numeric,0),2)
             = round((v_r.amount_cents / 100.0)::numeric,2) THEN
      UPDATE public.tournament_bounty_award_recipients
         SET paid_at = now()
       WHERE id = v_r.id;

      v_paid := v_paid + v_r.amount_cents;
      UPDATE public.tournament_players
         SET bounties_collected = COALESCE(bounties_collected, 0) + 1,
             bounty_winnings = round(
               COALESCE(bounty_winnings, 0)
                 + (v_r.amount_cents / 100.0), 2)
       WHERE tournament_id = v_a.tournament_id
         AND user_id = v_r.user_id;

      INSERT INTO public.tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id,
         bounty_amount, is_mystery_revealed, bounty_obligation_id)
      VALUES
        (v_a.tournament_id, v_a.eliminated_user_id, v_r.user_id,
         (v_r.amount_cents / 100.0)::numeric, true,
         v_a.bounty_obligation_id)
      ON CONFLICT DO NOTHING;
    ELSE
      RAISE EXCEPTION
        'fn_mystery_bounty_pay: recipient % refused for award % (%)',
        v_r.user_id, p_award_id,
        COALESCE(v_settle->>'refused_reason','unknown')
        USING ERRCODE='check_violation';
    END IF;
  END LOOP;

  IF v_paid > 0 THEN
    UPDATE public.tournaments
       SET bounty_pool_paid = round(
             COALESCE(bounty_pool_paid, 0) + (v_paid / 100.0), 2)
     WHERE id = v_a.tournament_id;
  END IF;

  UPDATE public.tournament_bounty_award_recipients
     SET paid_at=COALESCE(paid_at,now())
   WHERE award_id=p_award_id AND amount_cents=0;

  IF v_refused = 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_award_recipients
     WHERE award_id=p_award_id AND paid_at IS NULL
  ) THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'completed', paid_at = now()
     WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests
       SET status = 'paid'
     WHERE id = v_a.chest_id;
  ELSE
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES (
      'critical', 'fn_mystery_bounty_pay',
      'Mystery bounty award left incomplete: a recipient credit was refused',
      jsonb_build_object(
        'award_id', p_award_id,
        'tournament_id', v_a.tournament_id,
        'refused_recipients', v_refused,
        'paid_cents', v_paid,
        'award_cents', v_a.amount_cents,
        'refused_reason', v_settle->>'refused_reason',
        'detail', 'the award is NOT marked completed and the chest is NOT marked paid, so it stays retryable'));
  END IF;

  IF v_a.bounty_obligation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=v_a.bounty_obligation_id AND o.state='settled'
       AND public.fn_bounty_obligation_has_complete_marker(o.id)
  ) THEN
    RAISE EXCEPTION
      'mystery award % completed without its exact settled marker',p_award_id
      USING ERRCODE='check_violation';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'already', false, 'award_id', p_award_id,
    'amount_cents', v_a.amount_cents, 'paid_cents', v_paid,
    'refused_recipients', v_refused,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', user_id, 'amount_cents', amount_cents))
        FROM public.tournament_bounty_award_recipients
       WHERE award_id = p_award_id), '[]'::jsonb));
END;
$function$
