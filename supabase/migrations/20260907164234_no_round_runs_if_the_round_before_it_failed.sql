-- NO ROUND RUNS IF THE ROUND BEFORE IT FAILED
-- =============================================================================
-- PHASE 1 of 8, correction. This migration exists because of a defect I shipped
-- and it moved real chips.
--
-- WHAT HAPPENED. At 2026-09-07 16:35 the settlement ran for the week
-- 2026-08-31 07:00 to 2026-09-07 07:00. Round 1 refused, correctly, with
-- 'before_settlement_floor': union_settlement_floor carries
-- earliest_period_start = 2026-09-07 00:00 with the reason
--
--   "Dan 2026-09-02: start clean with the first week. Rake attribution became
--    correct at 2026-09-02 17:13 UTC, so 2026-09-07 is the first fully clean
--    Monday-to-Monday week. The weeks of 08-17, 08-24 and 08-31 are
--    deliberately never settled - they would pay out on the old basis, which
--    credited the union-as-a-club and zero to the member clubs."
--
-- The cascade ignored that refusal, recorded round 1 as amount 0, and carried
-- straight on. Round 2 then moved 441,230.51 out of club treasuries to 83
-- agents and stamped settled_at on 1,118,785 agent_commissions rows, for a week
-- the floor says must never settle - and without the round 1 rakeback that is
-- supposed to fund the clubs first.
--
-- TWO DEFECTS, both mine.
--
-- 1. THE FLOOR WAS ONLY CHECKED INSIDE ROUND 1. fn_union_weekly_rakeback_close
--    honours it; nothing above it does. The due-runner happily selected a
--    floored period, and the cascade ran three more rounds on it.
--
-- 2. NO ROUND CHECKED WHETHER THE PREVIOUS ROUND SUCCEEDED. Rounds 1 to 3
--    signal failure by RETURNING success:false, not by raising - so the
--    per-union exception handler never saw anything, and the sequencing the
--    cascade exists to enforce was not enforced at all. I had made round 4's
--    failure surface and left the three money rounds able to fail in silence.
--
-- WHAT THIS CHANGES.
--
--   fn_union_settlement_cascade_due  refuses a period that starts before the
--                                    union's settlement floor, and says so.
--   fn_union_settlement_cascade      checks the floor up front, and ABORTS
--                                    after any round that reports failure
--                                    instead of continuing to the next one.
--
-- 'already_executed' is not a failure - it means that round's money has already
-- moved - so it is the one non-success that is allowed to continue.
--
-- THE 441,230.51 IS NOT REVERSED. The commissions were genuinely owed to those
-- agents; what went wrong is that they were paid early, for a floored week, out
-- of club treasuries that the union had not funded. Clawing back from 83 agents
-- to correct our own defect is precisely what CLAUDE.md 10.9 forbids, no club
-- went short (round 2 reported 0 shortfalls, and both treasuries remain over
-- 940,000), and the rows are now stamped settled_at so the 2026-09-07 week
-- cannot pay them a second time. Whether the union compensates the two clubs
-- for the un-offset outlay sets what a club is owed, which is Dan's decision
-- and not an agent's. It is written up rather than acted on.
--
-- NOTE: this migration shipped with an editing artefact in the DECLARE block,
-- an unused "FUNCTION_BODY_MARKER boolean := true;". It is inert and every
-- assertion below passed with it present; 20260907164413 removes it.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid,
  p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_floor timestamptz;
  v_sqlstate text; v_msg text; v_detail text; v_context text;

  -- A round has "failed" unless it succeeded, or it is telling us its money
  -- already moved. Anything else stops the cascade.
  FUNCTION_BODY_MARKER boolean := true;
BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- THE FLOOR, checked before anything moves. Round 1 has always honoured it;
  -- nothing above round 1 did, so three further rounds ran on a floored week.
  SELECT f.earliest_period_start INTO v_floor
    FROM union_settlement_floor f WHERE f.union_id = p_union_id;

  IF v_floor IS NOT NULL AND v_from < v_floor THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.');
  END IF;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_r1->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r1->>'error','') <> 'already_executed' THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round1_failed: ' || COALESCE(v_r1->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1,
      'note', 'Rounds 2, 3 and 4 were not run. A club is not asked to pay its '
              || 'agents out of a treasury the union has not funded.');
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r2->>'error','') <> 'already_executed' THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.');
  END IF;

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r3->>'error','') <> 'already_executed' THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.');
  END IF;

  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_eco := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: invoice rake basis '
                || '(fn_union_rake_paid_readonly, first-joined club) disagrees with the '
                || 'basis round 1 pays on (ca_union_rake_attribution, seat played). '
                || 'Money moved; statement held pending reconciliation.');
  ELSE
    BEGIN
      v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_inv := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0), 0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_inv->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv);
  END IF;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_to    timestamptz := public.fn_union_week_start(now());
  v_from  timestamptz := public.fn_union_prev_week_start(now());
  v_total int;
  v_done  int;
  v_eligible int;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'platform_frozen', 'period_start', v_from, 'period_end', v_to);
  END IF;

  IF EXTRACT(minute FROM now()) >= 45 THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'too_close_to_maintenance_break', 'period_start', v_from, 'period_end', v_to);
  END IF;

  IF v_to < now() - interval '3 days' THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'period_closed_more_than_three_days_ago',
      'period_start', v_from, 'period_end', v_to, 'now', now());
  END IF;

  -- THE FLOOR. A period below every union's floor is not "due" at all.
  SELECT count(*) INTO v_eligible
    FROM unions u
    LEFT JOIN union_settlement_floor f ON f.union_id = u.id
   WHERE f.earliest_period_start IS NULL OR v_from >= f.earliest_period_start;

  IF v_eligible = 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'note', 'Every union floors this period. Nothing was run.');
  END IF;

  SELECT count(*) INTO v_total FROM unions;
  SELECT count(*) INTO v_done
    FROM union_settlement_rounds
   WHERE period_start = v_from AND period_end = v_to AND round_no = 1;

  IF v_total > 0 AND v_done >= v_total THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'already_settled', 'period_start', v_from, 'period_end', v_to);
  END IF;

  RETURN public.fn_union_settlement_cascade_all(v_from, v_to);
END $function$;

DO $assert$
DECLARE v_src text; v_res jsonb;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%before_settlement_floor%' THEN
    RAISE EXCEPTION 'the cascade still does not check the settlement floor';
  END IF;
  IF v_src NOT LIKE '%round1_failed%' OR v_src NOT LIKE '%round2_failed%' OR v_src NOT LIKE '%round3_failed%' THEN
    RAISE EXCEPTION 'the cascade still continues past a failed money round';
  END IF;

  v_res := public.fn_union_settlement_cascade(
             'fade0000-0000-0000-0000-000000000001',
             '2026-08-24 07:00:00+00', '2026-08-31 07:00:00+00');
  IF (v_res->>'success')::boolean IS NOT FALSE
     OR v_res->>'error' <> 'before_settlement_floor' THEN
    RAISE EXCEPTION 'a floored period was not refused: %', v_res::text;
  END IF;
  IF EXISTS (SELECT 1 FROM union_settlement_rounds
              WHERE period_start='2026-08-24 07:00:00+00' AND period_end='2026-08-31 07:00:00+00') THEN
    RAISE EXCEPTION 'the refused period still wrote round rows';
  END IF;
END
$assert$;

COMMIT;
