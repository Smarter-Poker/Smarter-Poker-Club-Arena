-- THE TREASURY IS ASKED BEFORE THE RAKE IS COUNTED
-- =============================================================================
-- PHASE 5 of 8, part 4 - the second correction, and again the probe found it.
--
-- Part 3 moved the membership check ahead of the rake scan and added a
-- whole-club pre-flight for a treasury that cannot fund its SMALLEST pending
-- payout. The probe then measured Midway again:
--
--   FIXTURE_FAIL the unfundable club still costs 4035.9ms
--
-- The pre-flight did not fire, and it was right not to: Midway holds 0.66 and
-- its smallest pending payout is under that, so the club genuinely can pay
-- something. What it cannot pay is the other 1,768 periods - and each of those
-- was still computing a full rake basis, over days the rollup does not cover,
-- purely to arrive at a number fn_debit_treasury was always going to refuse.
-- The batch stopped at its 4s budget, correctly, having settled almost nothing
-- and spent the whole budget discovering that.
--
-- A club is not fundable or unfundable. It is fundable FOR A GIVEN PERIOD. So
-- the question is asked per period, and it is asked before the work:
-- rakeback_amount already holds what the writer last computed for this period,
-- and if the treasury cannot cover even that, there is nothing to learn from
-- recomputing it. Defer, cheaply, and pick it up on the pass after the club is
-- funded.
--
-- The estimate is only ever used to REFUSE. Nothing is paid on it - a period
-- that clears this gate still recomputes its basis and its rate from scratch,
-- and fn_debit_treasury is still the thing that decides whether the money
-- moves. A stale estimate can therefore cost a period one extra cycle of
-- waiting; it can never cost a player a wrong number.
-- =============================================================================

BEGIN;

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='fn_close_settlement_period' AND pronamespace='public'::regnamespace;

  v_a := E'  -- ---- NOW THE WORK ---------------------------------------------------------';

  v_r := E'  -- Can this club fund what this period is already believed to be worth? The\n'
      || E'  -- estimate is the writer''s own last computation, it is used ONLY to refuse,\n'
      || E'  -- and refusing here costs one indexed row where continuing costs a full rake\n'
      || E'  -- scan for a payment fn_debit_treasury would decline at the end of it.\n'
      || E'  IF COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN\n'
      || E'    SELECT COALESCE(c.chip_treasury, 0) INTO v_treasury\n'
      || E'      FROM public.clubs c WHERE c.id = v_period.club_id;\n'
      || E'    IF v_treasury < COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) THEN\n'
      || E'      UPDATE public.rakeback_periods\n'
      || E'         SET deferred_reason = ''insufficient_club_treasury'',\n'
      || E'             deferred_at = NOW(), defer_count = defer_count + 1\n'
      || E'       WHERE id = p_period_id;\n'
      || E'      RETURN jsonb_build_object(''success'', false, ''deferred'', ''insufficient_club_treasury'',\n'
      || E'        ''period_id'', p_period_id, ''club_id'', v_period.club_id,\n'
      || E'        ''estimated_payout'', COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0),\n'
      || E'        ''treasury'', round(v_treasury, 2), ''checked'', ''before_basis'');\n'
      || E'    END IF;\n'
      || E'  END IF;\n\n'
      || v_a;

  IF position(v_a in v_def) = 0 THEN
    RAISE EXCEPTION 'the work marker is not where this migration expects it';
  END IF;
  v_new := replace(v_def, v_a, v_r);
  IF v_new = v_def THEN RAISE EXCEPTION 'the treasury pre-check did not take'; END IF;

  -- it needs one more local
  v_new := replace(v_new,
    E'  v_debit          jsonb;',
    E'  v_debit          jsonb;\n  v_treasury       numeric;');
  IF v_new NOT LIKE '%v_treasury       numeric;%' THEN
    RAISE EXCEPTION 'could not declare v_treasury';
  END IF;

  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE v_src text; v_tre_at int; v_basis_at int; v_member_at int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_close_settlement_period' AND pronamespace='public'::regnamespace;

  v_member_at := position('no_membership_at_earning_club' in v_src);
  v_tre_at    := position('before_basis' in v_src);
  v_basis_at  := position('fn_rake_shares_for_record' in v_src);

  IF v_tre_at = 0 THEN RAISE EXCEPTION 'the treasury pre-check is not in the payer'; END IF;
  IF v_tre_at > v_basis_at THEN
    RAISE EXCEPTION 'the treasury pre-check still runs after the rake scan';
  END IF;
  IF v_member_at > v_tre_at THEN
    RAISE EXCEPTION 'membership is no longer the first refusal';
  END IF;
  -- fn_debit_treasury must STILL be what actually decides.
  IF v_src NOT LIKE '%fn_debit_treasury%' THEN
    RAISE EXCEPTION 'the estimate replaced the real debit instead of gating it';
  END IF;
  IF v_src NOT LIKE '%fn_player_rakeback_rate%' OR v_src NOT LIKE '%rakeback_daily_user%' THEN
    RAISE EXCEPTION 'the substitution lost the rate policy or the rollup';
  END IF;
END
$assert$;

COMMIT;
