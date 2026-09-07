-- COMPLETED MEANS FINANCIALLY CERTIFIED.
--
-- A tournament used to reach COMPLETED through several independent client
-- writes.  The atomic place, satellite and final-table-deal domain RPCs now own
-- the money and the terminal transition together.  This migration deliberately
-- owns neither: it persists the canonical finish claim and writes an independent
-- financial certificate in the SAME transaction as the domain RPC's status
-- update.  A direct or partially settled terminal write is refused.
--
-- This migration makes the database own both boundaries:
--
--   fn_claim_tournament_finish
--     locks RUNNING -> COMPLETING and persists one immutable canonical winner.
--
--   fn_certify_tournament_finish
--     is a read-only certificate lookup kept at its established RPC signature
--     for DB-first/application-first rolling compatibility.  It never pays and
--     never changes tournament status.
--
-- The trigger re-proves the sole winner, complete standings, exact obligations,
-- zeroed escrow, synchronously settled and attributed rake, bounty completion,
-- and the format-specific atomic settlement batch.  A refusal leaves the domain
-- transaction uncommitted and therefore every payment re-drivable.  No cron,
-- compensating write or optimistic status is involved.

BEGIN;
SET LOCAL lock_timeout = '250ms';

CREATE TABLE IF NOT EXISTS public.tournament_finish_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  winner_user_id uuid NOT NULL,
  finish_kind text NOT NULL CHECK (finish_kind IN ('normal','satellite','final_table_deal')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claim_source text NOT NULL,
  certified_at timestamptz,
  completed_at timestamptz,
  certification_version integer NOT NULL DEFAULT 1 CHECK (certification_version = 1),
  evidence jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((certified_at IS NULL AND completed_at IS NULL AND evidence IS NULL)
      OR (certified_at IS NOT NULL AND completed_at IS NOT NULL
          AND jsonb_typeof(evidence) = 'object'))
);

ALTER TABLE public.tournament_finish_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_finish_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.tournament_finish_receipts TO service_role;

COMMENT ON TABLE public.tournament_finish_receipts IS
  'Immutable winner claim and same-transaction financial completion certificate. '
  'Only fn_claim_tournament_finish and the COMPLETED guard may write it.';

-- The certificate layer is intentionally ordered after the three format-owned
-- atomic settlement contracts.  Failing here is safer than silently restoring
-- a second payer or accepting a terminal state with no domain receipt.
DO $dependencies$
BEGIN
  IF to_regprocedure('public.fn_settle_tournament_places_atomic(uuid,text)') IS NULL
     OR to_regclass('public.tournament_place_settlement_batches') IS NULL
     OR to_regprocedure('public.fn_settle_final_table_deal_atomic(uuid)') IS NULL
     OR to_regprocedure('public.fn_check_atomic_final_table_deal(uuid)') IS NULL
     OR to_regclass('public.tournament_final_table_deal_batches') IS NULL
     OR to_regprocedure('public.fn_settle_satellite_finish_atomic(uuid,text)') IS NULL
     OR to_regprocedure('public.fn_check_atomic_satellite_finish(uuid)') IS NULL
     OR to_regclass('public.tournament_satellite_settlement_batches') IS NULL THEN
    RAISE EXCEPTION
      'atomic place, final-table-deal and satellite settlement migrations must precede the finish certificate';
  END IF;
END;
$dependencies$;

CREATE OR REPLACE FUNCTION public.fn_tournament_finish_kind(p_tournament_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches d
       WHERE d.tournament_id = p_tournament_id
    ) THEN 'final_table_deal'
    WHEN lower(COALESCE(t.variant,'')) = 'satellite'
      OR upper(COALESCE(t.tournament_type,'')) = 'SATELLITE'
      OR t.satellite_target_id IS NOT NULL THEN 'satellite'
    ELSE 'normal'
  END
  FROM public.tournaments t
  WHERE t.id = p_tournament_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_finish(
  p_tournament_id uuid,
  p_winner_user_id uuid,
  p_source text DEFAULT 'engine'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_finish_receipts%ROWTYPE;
  v_kind text;
  v_rows integer := 0;
  v_live_count integer := 0;
  v_live_winner uuid;
  v_position_one uuid;
BEGIN
  IF p_tournament_id IS NULL OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','missing_ids');
  END IF;

  SELECT * INTO v_t FROM public.tournaments
   WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  v_kind := public.fn_tournament_finish_kind(p_tournament_id);

  SELECT * INTO v_receipt FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id THEN
      RETURN jsonb_build_object('ok',false,'reason','canonical_winner_conflict',
        'winner_user_id',v_receipt.winner_user_id,'status',v_t.status);
    END IF;
    IF v_receipt.finish_kind IS DISTINCT FROM v_kind THEN
      RETURN jsonb_build_object('ok',false,'reason','finish_kind_conflict',
        'finish_kind',v_receipt.finish_kind,'observed_kind',v_kind,'status',v_t.status);
    END IF;
    IF v_t.status = 'COMPLETED' THEN
      RETURN jsonb_build_object('ok',v_receipt.certified_at IS NOT NULL,
        'reason',CASE WHEN v_receipt.certified_at IS NULL
                      THEN 'completed_without_certificate' ELSE NULL END,
        'winner_user_id',v_receipt.winner_user_id,'finish_kind',v_kind,
        'status',v_t.status,'already_completed',true);
    END IF;
  END IF;

  IF upper(COALESCE(v_t.status,'')) NOT IN ('RUNNING','COMPLETING') THEN
    RETURN jsonb_build_object('ok',false,'reason','finish_status_not_claimable',
      'status',v_t.status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_winner_user_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','winner_not_in_tournament');
  END IF;

  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_live_count, v_live_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status IN ('registered','playing');
  IF v_live_count = 1 AND v_live_winner IS DISTINCT FROM p_winner_user_id THEN
    RETURN jsonb_build_object('ok',false,'reason','winner_is_not_sole_survivor',
      'survivor_user_id',v_live_winner);
  END IF;
  IF v_live_count > 1 AND v_kind <> 'final_table_deal' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_decided',
      'live_players',v_live_count);
  END IF;

  SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_position_one
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.position = 1;
  IF v_position_one IS NOT NULL AND v_position_one IS DISTINCT FROM p_winner_user_id THEN
    RETURN jsonb_build_object('ok',false,'reason','position_one_conflict',
      'position_one_user_id',v_position_one);
  END IF;

  IF v_kind = 'final_table_deal' AND NOT EXISTS (
    SELECT 1 FROM public.tournament_final_table_deal_batches d
     WHERE d.tournament_id = p_tournament_id
       AND d.chip_leader = p_winner_user_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','deal_winner_conflict');
  END IF;

  INSERT INTO public.tournament_finish_receipts
    (tournament_id,winner_user_id,finish_kind,claim_source)
  VALUES
    (p_tournament_id,p_winner_user_id,v_kind,
     COALESCE(NULLIF(btrim(p_source),''),'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;

  SELECT * INTO v_receipt FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF v_receipt.winner_user_id IS DISTINCT FROM p_winner_user_id
     OR v_receipt.finish_kind IS DISTINCT FROM v_kind THEN
    RETURN jsonb_build_object('ok',false,'reason','finish_claim_conflict');
  END IF;

  IF v_t.status = 'RUNNING' THEN
    UPDATE public.tournaments SET status = 'COMPLETING'
     WHERE id = p_tournament_id AND status = 'RUNNING';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'finish claim CAS changed % rows for tournament %',
        v_rows, p_tournament_id USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok',true,'reason',NULL,
    'winner_user_id',p_winner_user_id,'finish_kind',v_kind,
    'status','COMPLETING','claimed',true,'resumed',(v_t.status = 'COMPLETING'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_finish_readiness(
  p_tournament_id uuid,
  p_winner_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
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
  IF v_kind <> 'satellite' THEN
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

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';
    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN
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
  IF NOT v_rake_found OR v_rake_settled_at IS NULL
     OR v_rake_attributed_at IS NULL OR v_rake_destination = 'pending'
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
      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completed_certificate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_winner uuid;
  v_kind text;
  v_ready jsonb;
  v_existing public.tournament_finish_receipts%ROWTYPE;
BEGIN
  IF COALESCE(NEW.on_break,false) THEN
    RAISE EXCEPTION 'tournament % cannot complete while on_break remains true', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  v_kind := public.fn_tournament_finish_kind(NEW.id);

  IF v_kind = 'final_table_deal' THEN
    -- The final-table-deal domain RPC owns RUNNING -> COMPLETED directly. Its
    -- settled immutable batch is the canonical winner claim and exists only in
    -- that same transaction before this trigger runs.
    IF OLD.status IS DISTINCT FROM 'RUNNING' THEN
      RAISE EXCEPTION 'final-table-deal tournament % cannot complete from status %',
        NEW.id, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT b.chip_leader INTO v_winner
      FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id = NEW.id AND b.settled_at IS NOT NULL;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION 'final-table-deal tournament % has no settled atomic winner claim', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.tournament_finish_receipts
      (tournament_id,winner_user_id,finish_kind,claim_source)
    VALUES (NEW.id,v_winner,v_kind,'atomic_final_table_deal')
    ON CONFLICT (tournament_id) DO NOTHING;
  ELSE
    -- Normal and satellite settlement consume an immutable RUNNING ->
    -- COMPLETING claim made before their domain plan is frozen. The certificate
    -- layer does not invent a missing claim for an out-of-band writer.
    IF OLD.status IS DISTINCT FROM 'COMPLETING' THEN
      RAISE EXCEPTION 'tournament % cannot complete from status %', NEW.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_winner
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id
       AND tp.status = 'winner' AND tp.position = 1;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION 'tournament % has no canonical winner', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.tournament_finish_receipts
   WHERE tournament_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable finish claim', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_existing.winner_user_id IS DISTINCT FROM v_winner
     OR v_existing.finish_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION 'tournament % completion conflicts with finish claim', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  v_ready := public.fn_tournament_finish_readiness(NEW.id,v_winner);
  IF COALESCE((v_ready->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % is not financially certified: %',
      NEW.id, COALESCE(v_ready->'failures','[]'::jsonb)
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.tournament_finish_receipts
     SET certified_at = COALESCE(certified_at,now()),
         completed_at = COALESCE(completed_at,COALESCE(NEW.ended_at,now())),
         evidence = COALESCE(evidence,v_ready),
         updated_at = now()
   WHERE tournament_id = NEW.id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_certify_tournament_finish(
  p_tournament_id uuid,
  p_winner_user_id uuid,
  p_source text DEFAULT 'engine'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_finish public.tournament_finish_receipts%ROWTYPE;
  v_ready jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'certified',false,'reason','missing_ids');
  END IF;
  SELECT * INTO v_t FROM public.tournaments
   WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'certified',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_finish FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'certified',false,
      'reason','finish_certificate_missing','status',v_t.status,'rows_updated',0);
  END IF;
  IF v_finish.winner_user_id IS DISTINCT FROM p_winner_user_id THEN
    RETURN jsonb_build_object('ok',false,'certified',false,
      'reason','canonical_winner_conflict','winner_user_id',v_finish.winner_user_id,
      'finish_kind',v_finish.finish_kind,'status',v_t.status,'rows_updated',0);
  END IF;
  IF v_t.status <> 'COMPLETED' THEN
    RETURN jsonb_build_object('ok',false,'certified',false,
      'reason','domain_settlement_required','winner_user_id',v_finish.winner_user_id,
      'finish_kind',v_finish.finish_kind,'status',v_t.status,'rows_updated',0,
      'already_completed',false);
  END IF;
  IF v_finish.certified_at IS NULL OR v_finish.completed_at IS NULL
     OR v_finish.evidence IS NULL THEN
    RETURN jsonb_build_object('ok',false,'certified',false,
      'reason','completed_without_certificate','winner_user_id',v_finish.winner_user_id,
      'finish_kind',v_finish.finish_kind,'status',v_t.status,'rows_updated',0,
      'already_completed',true);
  END IF;

  -- Re-read the proof as a defence against privileged post-completion drift.
  -- The atomic domain migrations freeze their plan, results and obligation
  -- ledger, so this is a pure verification pass and can never repair money.
  v_ready := public.fn_tournament_finish_readiness(p_tournament_id,p_winner_user_id);
  IF COALESCE((v_ready->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok',false,'certified',false,
      'reason','certificate_evidence_no_longer_valid','winner_user_id',v_finish.winner_user_id,
      'finish_kind',v_finish.finish_kind,'status',v_t.status,'rows_updated',0,
      'already_completed',true,'evidence',v_ready);
  END IF;

  RETURN jsonb_build_object('ok',true,'certified',true,'reason',NULL,
    'status','COMPLETED','rows_updated',0,'already_completed',true,
    'winner_user_id',p_winner_user_id,'finish_kind',v_finish.finish_kind,
    'evidence',v_finish.evidence,
    'requested_by',COALESCE(NULLIF(btrim(p_source),''),'engine'));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_finish_kind(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_finish_readiness(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_completed_certificate()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_claim_tournament_finish(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_certify_tournament_finish(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_finish(uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_certify_tournament_finish(uuid,uuid,text)
  TO service_role;

-- Install the only hot-table object as the final mutation in the transaction.
-- CREATE/DROP TRIGGER takes ACCESS EXCLUSIVE on tournaments. The transaction's
-- 250 ms lock budget makes a busy table abort the complete migration cleanly;
-- no partial catalogue can become visible. PostgreSQL executes same-kind
-- triggers alphabetically. Six leading z's put this receipt writer after the
-- atomic domain guards; it records their already-proven result and never
-- becomes their substitute.
DROP TRIGGER IF EXISTS tournaments_z_financial_certificate ON public.tournaments;
DROP TRIGGER IF EXISTS zzzzzz_tournaments_financial_certificate ON public.tournaments;
CREATE TRIGGER zzzzzz_tournaments_financial_certificate
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.fn_guard_tournament_completed_certificate();

DO $verify$
DECLARE
  v_src text;
BEGIN
  IF to_regclass('public.tournament_finish_receipts') IS NULL THEN
    RAISE EXCEPTION 'tournament_finish_receipts missing';
  END IF;
  IF to_regprocedure('public.fn_claim_tournament_finish(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_certify_tournament_finish(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'tournament finish contract function missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzzzz_tournaments_financial_certificate' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'financial completion trigger missing';
  END IF;
  IF has_table_privilege('service_role','public.tournament_finish_receipts','INSERT')
     OR has_table_privilege('service_role','public.tournament_finish_receipts','UPDATE')
     OR has_table_privilege('service_role','public.tournament_finish_receipts','DELETE') THEN
    RAISE EXCEPTION 'service_role can forge a tournament finish certificate';
  END IF;
  IF has_function_privilege('anon','public.fn_claim_tournament_finish(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_claim_tournament_finish(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.fn_certify_tournament_finish(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_certify_tournament_finish(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'browser role can claim or certify a tournament finish';
  END IF;
  SELECT pg_get_functiondef('public.fn_certify_tournament_finish(uuid,uuid,text)'::regprocedure)
    INTO v_src;
  IF position('fn_tournament_payout_reconcile' in v_src) > 0
     OR position('fn_settle_tournament_obligation' in v_src) > 0
     OR position('fn_settle_tournament_rake' in v_src) > 0
     OR position('fn_attribute_tournament_rake' in v_src) > 0
     OR position('UPDATE public.tournaments' in v_src) > 0
     OR position('UPDATE public.tournament_players' in v_src) > 0
     OR position('UPDATE public.tournament_rake_settlements' in v_src) > 0 THEN
    RAISE EXCEPTION 'finish certificate lookup regained a payer or status mutation';
  END IF;
  IF position('domain_settlement_required' in v_src) = 0
     OR position('already_completed' in v_src) = 0 THEN
    RAISE EXCEPTION 'finish certificate lookup lost its read-only domain/replay contract';
  END IF;
  SELECT pg_get_functiondef('public.fn_guard_tournament_completed_certificate()'::regprocedure)
    INTO v_src;
  IF position('NEW.on_break' in v_src) = 0 THEN
    RAISE EXCEPTION 'financial completion guard no longer rejects an active break';
  END IF;
END;
$verify$;

-- Atomic domain migrations are installed immediately before this certificate
-- layer. A live engine can finish in that narrow deploy interval. Installing
-- the trigger above first closes the forward edge; this same transaction then
-- certifies only already-COMPLETED rows carrying a settled atomic domain batch.
-- It never pays, changes standings, or rewrites tournament status. Any batch
-- that cannot pass today's full proof aborts deployment instead of being
-- grandfathered into a false certificate.
DO $certificate_atomic_deploy_window$
DECLARE
  r record;
  v_kind text;
  v_winner uuid;
  v_receipt public.tournament_finish_receipts%ROWTYPE;
  v_ready jsonb;
BEGIN
  FOR r IN
    SELECT t.id,t.ended_at
      FROM public.tournaments t
     WHERE t.status='COMPLETED'
       AND (
         EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
                  WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b
                     WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                     WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_finish_receipts f
          WHERE f.tournament_id=t.id AND f.certified_at IS NOT NULL
       )
     ORDER BY t.id
  LOOP
    v_kind:=public.fn_tournament_finish_kind(r.id);
    IF v_kind='final_table_deal' THEN
      SELECT b.chip_leader INTO v_winner
        FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id=r.id AND b.settled_at IS NOT NULL;
    ELSE
      SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1] INTO v_winner
        FROM public.tournament_players tp
       WHERE tp.tournament_id=r.id AND tp.status='winner' AND tp.position=1;
    END IF;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION 'completed atomic tournament % has no unique domain winner',r.id
        USING ERRCODE='check_violation';
    END IF;

    INSERT INTO public.tournament_finish_receipts(
      tournament_id,winner_user_id,finish_kind,claim_source)
    VALUES(r.id,v_winner,v_kind,'certificate_deploy_backfill')
    ON CONFLICT (tournament_id) DO NOTHING;
    SELECT * INTO v_receipt FROM public.tournament_finish_receipts
     WHERE tournament_id=r.id FOR UPDATE;
    IF v_receipt.winner_user_id IS DISTINCT FROM v_winner
       OR v_receipt.finish_kind IS DISTINCT FROM v_kind THEN
      RAISE EXCEPTION 'completed atomic tournament % conflicts with its finish receipt',r.id
        USING ERRCODE='check_violation';
    END IF;

    v_ready:=public.fn_tournament_finish_readiness(r.id,v_winner);
    IF COALESCE((v_ready->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'completed atomic tournament % cannot be backfill-certified: %',
        r.id,COALESCE(v_ready->'failures','[]'::jsonb)
        USING ERRCODE='check_violation';
    END IF;
    UPDATE public.tournament_finish_receipts
       SET certified_at=COALESCE(certified_at,now()),
           completed_at=COALESCE(completed_at,COALESCE(r.ended_at,now())),
           evidence=COALESCE(evidence,v_ready),updated_at=now()
     WHERE tournament_id=r.id;
  END LOOP;
END;
$certificate_atomic_deploy_window$;

COMMIT;
