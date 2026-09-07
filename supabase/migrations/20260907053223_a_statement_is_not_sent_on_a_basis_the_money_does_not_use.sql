-- A STATEMENT IS NOT SENT ON A BASIS THE MONEY DOES NOT USE
-- =============================================================================
-- ROUND 1 AND THE INVOICE DISAGREE ABOUT HOW MUCH RAKE A CLUB GENERATED.
--
-- Round 1 (fn_union_weekly_rakeback_close) computes each club's share from
-- ca_union_rake_attribution - "the seat the player sat through, captured
-- hourly". Its own header records that as Dan's ruling of 2026-09-03.
--
-- The invoice computes it from fn_union_rake_paid_readonly, which attributes a
-- player's rake to the club they joined FIRST:
--     SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
--       FROM club_members cm ... ORDER BY cm.user_id, cm.joined_at ASC
--
-- For a player who belongs to more than one member club those two answers are
-- different, and for the week closing 2026-09-07 they are very different:
--
--   club         round 1 basis     invoice says     difference
--   Club JAQK       144,229.35        14,865.78      -129,363.57
--   SHARK CLUB      155,299.61       627,668.70      +472,369.09
--
-- It is not only the informational lines. outstanding = eco_amount + presettled,
-- eco_amount = -rate * (rake_earned - cash_players_won), and rake_earned comes
-- from the same wrong basis - so THE AMOUNT BILLED is on it too.
--
-- One of these has a written rule behind it and one does not. CLAUDE.md 10.8:
-- deployed code is not a law. Round 1 follows the ruling; the invoice follows
-- nothing, so the invoice is the defect.
--
-- WHY THIS IS A GATE AND NOT A FIX. Correcting the invoice means changing which
-- source feeds fn_union_eco_adjustment, which changes what every club is
-- billed. That is a real change to money and it needs to be reconciled against
-- round 1's actual output and reviewed - not written forty minutes before the
-- run. And it CANNOT be corrected afterwards: 20260907044041 made a delivered
-- invoice immutable precisely so a delivered statement cannot be silently
-- restated, so a wrong statement sent tonight would be frozen wrong.
--
-- So tonight the money moves and the statement waits. Rounds 1, 2 and 3 run on
-- the sanctioned basis and are untouched by this migration. Round 4 records
-- that it was held, and why.
--
-- TO RE-ENABLE, one statement:
--
--   UPDATE unions
--      SET settings = settings - 'weekly_invoices_enabled'
--    WHERE id = 'fade0000-0000-0000-0000-000000000001';
--
-- The gate defaults to ENABLED for every union, so no other union is affected
-- and a new union is unaffected.
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
BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      v_eco := jsonb_build_object('success', false, 'error', SQLERRM);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  -- ROUND 4 - the weekly square-up statement.
  -- Held while the invoice's rake basis disagrees with the basis round 1 pays
  -- on. A delivered invoice is immutable, so a wrong one cannot be taken back.
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
      v_inv := jsonb_build_object('success', false, 'error', SQLERRM);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0),
          0, v_inv)
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

-- Hold statements for Midway Union only.
UPDATE unions
   SET settings = COALESCE(settings, '{}'::jsonb)
                  || jsonb_build_object('weekly_invoices_enabled', 0)
 WHERE id = 'fade0000-0000-0000-0000-000000000001';

INSERT INTO financial_alerts (source, severity, message, context)
VALUES ('fn_union_club_invoice', 'critical',
        'Weekly statements are HELD for Midway Union: the invoice computes club rake from '
        || 'fn_union_rake_paid_readonly (player first-joined club) while round 1 pays from '
        || 'ca_union_rake_attribution (seat played). For the week closing 2026-09-07 that is '
        || 'Club JAQK 144,229.35 vs 14,865.78 and SHARK CLUB 155,299.61 vs 627,668.70. '
        || 'Money still moves; the statement waits. Re-enable with: UPDATE unions SET settings '
        || '= settings - ''weekly_invoices_enabled'' WHERE id = ''fade0000-0000-0000-0000-000000000001'';',
        jsonb_build_object(
          'union_id', 'fade0000-0000-0000-0000-000000000001',
          'period_start', '2026-08-31 07:00:00+00', 'period_end', '2026-09-07 07:00:00+00',
          'round1_basis', 'ca_union_rake_attribution',
          'invoice_basis', 'fn_union_rake_paid_readonly',
          'club_jaqk', jsonb_build_object('round1', 144229.35, 'invoice', 14865.78),
          'shark_club', jsonb_build_object('round1', 155299.61, 'invoice', 627668.70)));

DO $assert$
DECLARE v_gate numeric; v_src text;
BEGIN
  v_gate := public.fn_union_setting('fade0000-0000-0000-0000-000000000001', 'weekly_invoices_enabled', 1);
  IF v_gate <> 0 THEN
    RAISE EXCEPTION 'the invoice gate did not take: %', v_gate;
  END IF;

  -- Every other union must still default to enabled.
  IF EXISTS (SELECT 1 FROM unions u
              WHERE u.id <> 'fade0000-0000-0000-0000-000000000001'
                AND public.fn_union_setting(u.id, 'weekly_invoices_enabled', 1) <> 1) THEN
    RAISE EXCEPTION 'the gate leaked onto another union';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_union_settlement_cascade' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%weekly_invoices_enabled%' THEN
    RAISE EXCEPTION 'the cascade does not consult the gate';
  END IF;
  IF v_src NOT LIKE '%fn_union_weekly_rakeback_close%'
     OR v_src NOT LIKE '%fn_settle_round2_club_to_agents%'
     OR v_src NOT LIKE '%fn_settle_round3_agents_to_players%' THEN
    RAISE EXCEPTION 'a money round went missing from the cascade';
  END IF;
END
$assert$;

COMMIT;
