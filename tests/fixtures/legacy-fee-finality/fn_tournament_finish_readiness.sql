CREATE OR REPLACE FUNCTION public.fn_tournament_finish_readiness(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_t public.tournaments%ROWTYPE;
  v_finish public.tournament_finish_receipts%ROWTYPE;
  v_kind text;
  v_failures jsonb := '[]'::jsonb;
  v_winner_count integer := 0;
  v_position_one_count integer := 0;
  v_canonical_winner uuid;
  v_position_one_winner uuid;
  v_open_players integer := 0;
  v_unranked integer := 0;
  v_duplicate_positions integer := 0;
  v_unsettled_obligations integer := 0;
  v_bad_place_evidence integer := 0;
  v_bad_player_prizes integer := 0;
  v_place_owed numeric := 0;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_escrow_found boolean := false;
  v_rake_expected numeric := 0;
  v_rake_recorded numeric;
  v_rake_destination text;
  v_rake_settled_at timestamptz;
  v_rake_attributed_at timestamptz;
  v_rake_found boolean := false;
  v_bounty public.tournament_bounty_completion_receipts%ROWTYPE;
  v_place_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_deal public.tournament_final_table_deal_batches%ROWTYPE;
  v_satellite public.tournament_satellite_settlement_batches%ROWTYPE;
  v_domain_check jsonb;
  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;
  v_bad_satellite_outcomes integer := 0;
  v_satellite_award_gaps integer := 0;
BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found',
      'failures',jsonb_build_array(jsonb_build_object('code','tournament_not_found')));
  END IF;
  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
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


  SELECT * INTO v_finish FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_missing'));
  ELSIF v_finish.winner_user_id IS DISTINCT FROM p_winner_user_id
     OR v_finish.finish_kind IS DISTINCT FROM v_kind THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_conflict','claimed_winner',v_finish.winner_user_id,
      'claimed_kind',v_finish.finish_kind,'observed_kind',v_kind));
  END IF;

  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count, v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'winner' AND tp.position = 1;
  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_position_one_count, v_position_one_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.position = 1;
  IF v_winner_count <> 1 OR v_position_one_count <> 1
     OR v_canonical_winner IS DISTINCT FROM p_winner_user_id
     OR v_position_one_winner IS DISTINCT FROM p_winner_user_id THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','canonical_winner_not_proven','winner_rows',v_winner_count,
      'position_one_rows',v_position_one_count,'observed_winner',v_canonical_winner,
      'requested_winner',p_winner_user_id));
  END IF;

  SELECT count(*) FILTER (WHERE tp.status IN ('registered','playing')),
         count(*) FILTER (WHERE tp.position IS NULL)
    INTO v_open_players, v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_duplicate_positions
    FROM (
      SELECT tp.position FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL
       GROUP BY tp.position HAVING count(*) <> 1
    ) duplicates;
  IF v_open_players <> 0 OR v_unranked <> 0 OR v_duplicate_positions <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','standings_not_terminal','open_players',v_open_players,
      'unranked_players',v_unranked,'duplicate_positions',v_duplicate_positions));
  END IF;
  IF COALESCE(v_t.on_break,false) THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','terminal_break_flag_set'));
  END IF;

  SELECT count(*) INTO v_unsettled_obligations
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND abs(round(COALESCE(o.amount_paid,0),2)
           - round(COALESCE(o.amount_owed,0),2)) > 0.005;
  IF v_unsettled_obligations <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','unsettled_obligations','count',v_unsettled_obligations));
  END IF;

  -- Satellite prize history is one combined entitlement row (ticket value plus
  -- an optional cash remainder). Its format checker proves both constituent
  -- receipts exactly; comparing that cache to either receipt alone would
  -- falsely reject a short-field last-seat winner. The generic relation stays
  -- an independent certificate for every other format.
  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN
    SELECT count(*) INTO v_bad_place_evidence
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND o.amount_owed > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = o.tournament_id
            AND tp.position = o.place AND tp.user_id = o.user_id
            AND abs(round(COALESCE(tp.prize,0),2) - round(o.amount_owed,2)) <= 0.005
       );
    SELECT count(*) INTO v_bad_player_prizes
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND round(COALESCE(tp.prize,0),2) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
            AND o.place = tp.position AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'final_table_deal'
            AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       );
  END IF;
  IF v_bad_place_evidence <> 0 OR v_bad_player_prizes <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','prize_evidence_mismatch','place_obligations',v_bad_place_evidence,
      'player_prizes',v_bad_player_prizes));
  END IF;

  IF v_kind = 'normal' THEN
    SELECT * INTO v_place_batch
      FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_place_batch.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_place_batch_not_settled'));
    END IF;

    IF v_modern_place THEN
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

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';
    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','prize_pool_not_fully_obligated','prize_pool',v_t.prize_pool,
        'place_obligations',v_place_owed));
    END IF;
    IF round(COALESCE(v_t.guaranteed_prize,0),2)
         > round(COALESCE(v_t.prize_pool,0),2) + 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','guarantee_not_funded','guarantee',v_t.guaranteed_prize,
        'prize_pool',v_t.prize_pool));
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id;
  v_escrow_found := FOUND;
  IF NOT v_escrow_found THEN
    IF COALESCE(v_t.prize_pool,0) <> 0 OR COALESCE(v_t.bounty_pool,0) <> 0
       OR COALESCE(v_t.total_rake,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_payouts po
                   WHERE po.tournament_id = p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','escrow_evidence_missing'));
    END IF;
  ELSIF abs(round(v_escrow.prize_balance,2)) > 0.005
     OR abs(round(v_escrow.bounty_balance,2)) > 0.005
     OR abs(round(v_escrow.fee_balance,2)) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','escrow_not_zero','prize_balance',v_escrow.prize_balance,
      'bounty_balance',v_escrow.bounty_balance,'fee_balance',v_escrow.fee_balance));
  END IF;

  SELECT GREATEST(round(COALESCE(sum(rr.rake_amount),0),2),0) INTO v_rake_expected
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT amount,destination,settled_at,attributed_at
    INTO v_rake_recorded,v_rake_destination,v_rake_settled_at,v_rake_attributed_at
    FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  v_rake_found := FOUND;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF NOT v_rake_found OR v_rake_settled_at IS NULL
     OR (v_rake_attributed_at IS NULL AND NOT v_deferred) OR v_rake_destination = 'pending'
     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','rake_not_settled','expected',v_rake_expected,
      'recorded',CASE WHEN v_rake_found THEN v_rake_recorded ELSE NULL END,
      'destination',CASE WHEN v_rake_found THEN v_rake_destination ELSE NULL END,
      'attributed_at',CASE WHEN v_rake_found THEN v_rake_attributed_at ELSE NULL END));
  END IF;

  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','pending_bounty_obligations'));
    END IF;
    SELECT * INTO v_bounty FROM public.tournament_bounty_completion_receipts
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_bounty.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_bounty.pool_finalized_at IS NULL
       OR COALESCE((v_bounty.pool_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','bounty_pool_not_certified'));
    END IF;
    IF COALESCE(v_t.is_mystery_bounty,false)
       AND COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
       AND (v_bounty.mystery_settled_at IS NULL
            OR COALESCE((v_bounty.mystery_result->>'ok')::boolean,false) IS NOT TRUE
            OR COALESCE((v_bounty.mystery_result->>'balanced')::boolean,false) IS NOT TRUE) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','mystery_bounty_not_certified'));
    END IF;
  END IF;

  IF v_kind = 'final_table_deal' THEN
    SELECT * INTO v_deal FROM public.tournament_final_table_deal_batches
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_deal.chip_leader IS DISTINCT FROM p_winner_user_id
       OR v_deal.settled_at IS NULL OR v_deal.escrow_prize_after IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_final_table_deal_batch_not_settled'));
    ELSE
      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_final_table_deal_not_proven','detail',v_domain_check));
      END IF;
    END IF;
  END IF;

  IF v_kind = 'satellite' THEN
    SELECT * INTO v_satellite
      FROM public.tournament_satellite_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_satellite.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_satellite.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_satellite_batch_not_settled'));
    ELSE
      v_domain_check := public.fn_check_atomic_satellite_finish(p_tournament_id);
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_satellite_finish_not_proven','detail',v_domain_check));
      END IF;
    END IF;

    SELECT count(*) INTO v_bad_satellite_seats
      FROM public.tournament_players target_seat
     WHERE target_seat.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts po
          WHERE po.tournament_id = p_tournament_id
            AND po.source = 'satellite_seat'
            AND po.user_id = target_seat.user_id
            AND po.metadata->>'registration_id' = target_seat.id::text
       );
    IF v_bad_satellite_seats <> 0 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_seat_evidence_missing','count',v_bad_satellite_seats));
    END IF;

    -- Every in-kind payout names the original finisher/place and the exact
    -- target registration it funded. A payout row by itself is not a seat,
    -- and a target seat by itself is not a durable payout record.
    SELECT count(*) INTO v_bad_satellite_outcomes
      FROM public.tournament_payouts po
     WHERE po.tournament_id = p_tournament_id AND po.source = 'satellite_seat'
       AND (po."position" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players finisher
               WHERE finisher.tournament_id = p_tournament_id
                 AND finisher.user_id = po.user_id
                 AND finisher.position = po."position"
            )
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players target_seat
               WHERE target_seat.id::text = po.metadata->>'registration_id'
                 AND target_seat.user_id = po.user_id
                 AND target_seat.source_satellite_id = p_tournament_id
            ));

    -- Seat awards and cash ticket fallbacks form a top-finisher prefix. A gap
    -- means a lower place was paid while a higher promised place was skipped.
    WITH awarded_positions AS (
      SELECT po."position" AS place
        FROM public.tournament_payouts po
       WHERE po.tournament_id = p_tournament_id
         AND po.source = 'satellite_seat' AND po."position" IS NOT NULL
      UNION
      SELECT o.place
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
         AND o.place IS NOT NULL AND round(o.amount_paid,2) > 0
         AND abs(round(o.amount_paid,2)-round(o.amount_owed,2)) <= 0.005
    ), bounds AS (SELECT max(place) AS max_place FROM awarded_positions)
    SELECT count(*) INTO v_satellite_award_gaps
      FROM bounds b
      CROSS JOIN LATERAL generate_series(1,b.max_place) expected(place)
     WHERE b.max_place IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM awarded_positions a WHERE a.place=expected.place);

    IF v_bad_satellite_outcomes <> 0 OR v_satellite_award_gaps <> 0
       OR EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'satellite_remainder'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_players tp
               WHERE tp.tournament_id=p_tournament_id AND tp.user_id=o.user_id
            )
       ) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_awards_not_certified',
        'invalid_outcomes',v_bad_satellite_outcomes,
        'award_gaps',v_satellite_award_gaps));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',jsonb_array_length(v_failures) = 0,
    'reason',CASE WHEN jsonb_array_length(v_failures) = 0 THEN NULL
                  ELSE v_failures->0->>'code' END,
    'tournament_id',p_tournament_id,'winner_user_id',p_winner_user_id,
    'finish_kind',v_kind,'failures',v_failures,
    'financials',jsonb_build_object(
      'unsettled_obligations',v_unsettled_obligations,
      'place_obligations',v_place_owed,
      'rake_expected',v_rake_expected,
      'prize_balance',CASE WHEN v_escrow_found THEN v_escrow.prize_balance ELSE NULL END,
      'bounty_balance',CASE WHEN v_escrow_found THEN v_escrow.bounty_balance ELSE NULL END,
      'fee_balance',CASE WHEN v_escrow_found THEN v_escrow.fee_balance ELSE NULL END));
END;
$function$
