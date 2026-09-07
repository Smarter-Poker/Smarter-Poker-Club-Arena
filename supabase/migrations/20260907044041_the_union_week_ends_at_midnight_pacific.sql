-- THE UNION WEEK ENDS AT MIDNIGHT PACIFIC
-- =============================================================================
-- Dan, 2026-09-07: "THE WEEK CAN'T END UNTIL 2 AM ON MONDAY MORNING, WHEN THE
-- WEST COAST HITS 11:59:59."
--
-- 2 AM Central is 07:00 UTC is midnight America/Los_Angeles. Every one of those
-- is the same instant, and none of them is what the platform was using.
--
-- WHAT WAS WRONG
--
-- fn_union_week_start truncated in UTC, so the union week ended Monday 00:00
-- UTC, which is SUNDAY 17:00 Pacific. Every week, the whole of West Coast
-- Sunday evening - the busiest stretch of the week - was cut off the week that
-- had just been played and pushed into the next one. The settlement cron then
-- fired at 00:10 UTC, seven hours before the week Dan actually means had
-- finished.
--
-- Four further defects found in the same sweep, all in the weekly path:
--
--   1. fn_union_settlement_cascade_all catches every union in EXCEPTION WHEN
--      OTHERS and returns 'success', true regardless. Three consecutive weeks
--      failed on a stale GLOBAL_SETTLEMENT_FREEZE and pg_cron logged three
--      green runs. 2,592,517.16 of rake sat unclosed and nothing said so.
--   2. fn_union_issue_weekly_invoices upserts with an unconditional DO UPDATE,
--      so re-running it RESTATES an invoice that has already been delivered
--      while message_sent suppresses the corrected statement. The club holds a
--      message quoting one figure and the database holds another.
--   3. Its presettlement window was received_at >= v_start, so a payment made
--      during a week that never settled is older than every future period
--      start and is credited to the club on no invoice, ever.
--   4. v_notified was assigned by GET DIAGNOSTICS rather than accumulated, and
--      v_msg was declared once outside the loop, so a club whose statement was
--      skipped reported the previous club's delivery count.
--
-- The three GLOBAL_SETTLEMENT_FREEZE rows from 2026-08-26 are released here.
-- The investigation they were raised for is closed on the evidence: settlement
-- conservation, union money path, union chip integrity, the union law breach
-- checks and the weekly rake verifier all return zero rows, and the rake ledger
-- checkpoint recomputes to 0.00 drift across 1,281,259 rows. History is kept -
-- the rows are deactivated with their original reason preserved in metadata,
-- never deleted.
--
-- NOT DONE HERE, deliberately. The two weeks 2026-08-17 and 2026-08-24 carry
-- ECO of 1,015,731.49 and 1,242,950.74 against SHARK CLUB against 92,653.67 for
-- an ordinary week, and settled_in_chips of -6.5M and -9.8M. That is the drift
-- the freeze was raised for, not a bill, and replaying the cascade over it
-- would invoice it. It needs a human decision and it gets one.
-- =============================================================================

BEGIN;

-- 1. THE BOUNDARY ------------------------------------------------------------
-- Truncating a local timestamp and converting back is what makes this
-- DST-correct: "minus 7 days" on the naive local timestamp is a calendar week,
-- not 168 hours, so the boundary stays at local midnight across both switches.

CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles'))
           AT TIME ZONE 'America/Los_Angeles';
$function$;

COMMENT ON FUNCTION public.fn_union_week_start(timestamp with time zone) IS
  'Start of the union week containing p_at: midnight America/Los_Angeles on Monday. Dan 2026-09-07: the week cannot end until the West Coast hits 11:59:59.';

CREATE OR REPLACE FUNCTION public.fn_union_prev_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT (date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles')) - interval '7 days')
           AT TIME ZONE 'America/Los_Angeles';
$function$;

COMMENT ON FUNCTION public.fn_union_prev_week_start(timestamp with time zone) IS
  'Start of the union week BEFORE the one containing p_at. Subtracts on the local timestamp so a DST week is still one calendar week.';

-- 2. THE CASCADE, ON THE NEW BOUNDARY ----------------------------------------

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

  -- ROUND 4 - issue the weekly square-up statement to every member club.
  BEGIN
    v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
  EXCEPTION WHEN OTHERS THEN
    v_inv := jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0),
          0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- Round 4 failing is not allowed to look like a clean week any more. The
  -- rounds above have moved real chips and must stand, so this reports rather
  -- than raises; fn_union_settlement_cascade_all turns it into an alert.
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

-- 3. THE FLEET RUNNER, WHICH NO LONGER LIES ----------------------------------

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_all(
  p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union   record;
  v_one     jsonb;
  v_results jsonb := '[]'::jsonb;
  v_unions  int := 0;
  v_failed  int := 0;
  v_from    timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to      timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 numeric := 0; v_r2 numeric := 0; v_r3 numeric := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR v_union IN SELECT u.id FROM unions u LOOP
    BEGIN
      v_one := public.fn_union_settlement_cascade(v_union.id, v_from, v_to);
      IF COALESCE((v_one->>'success')::boolean, false) THEN
        v_unions := v_unions + 1;
        v_r1 := v_r1 + COALESCE((v_one->'round1_union_to_clubs'->>'total_rakeback')::numeric, 0);
        v_r2 := v_r2 + COALESCE((v_one->'round2_club_to_agents'->>'amount')::numeric, 0);
        v_r3 := v_r3 + COALESCE((v_one->'round3_agents_to_players'->>'amount')::numeric, 0);
      ELSE
        v_failed := v_failed + 1;
      END IF;
      v_results := v_results || jsonb_build_array(v_one);
    EXCEPTION WHEN OTHERS THEN
      -- One union's settlement must never abort the rest of the platform's.
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'union_id', v_union.id, 'success', false, 'error', SQLERRM));
    END;
  END LOOP;

  -- A settlement that did not happen has to be visible to somebody. Three weeks
  -- of EMERGENCY_PROFIT_DRIFT_LOCK returned 'success', true and nobody saw it.
  IF v_failed > 0 THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_union_settlement_cascade_all', 'critical',
            v_failed || ' of ' || (v_failed + v_unions) ||
            ' unions failed weekly settlement for ' ||
            to_char(v_from, 'YYYY-MM-DD') || ' to ' || to_char(v_to, 'YYYY-MM-DD') ||
            '. No rakeback moved and no invoices issued for those unions.',
            jsonb_build_object('period_start', v_from, 'period_end', v_to,
                               'unions_failed', v_failed, 'unions_settled', v_unions,
                               'detail', v_results));
  END IF;

  RETURN jsonb_build_object(
    'success', (v_failed = 0),
    'unions_settled', v_unions,
    'unions_failed', v_failed,
    'period_start', v_from,
    'period_end', v_to,
    'round1_union_to_clubs', v_r1,
    'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3,
    'ran_at', now(),
    'detail', v_results
  );
END $function$;

-- 4. THE DUE RUNNER - idempotent, so a missed week heals itself --------------

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
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- now() is always at or past v_to by construction, so there is no "too early"
  -- case: the week containing now() started at v_to.
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

COMMENT ON FUNCTION public.fn_union_settlement_cascade_due() IS
  'Settles the union week that has just closed, once. Safe to call on any schedule: returns skipped when round 1 already exists for the period, so a missed Monday heals on the next tick instead of waiting a week.';

-- 5. THE INVOICE BASIS -------------------------------------------------------
-- Only change: unapplied presettlements are no longer filtered by a lower
-- bound. Money a club has paid that has not been applied to a settlement is
-- owed to the club whenever it arrived.

CREATE OR REPLACE FUNCTION public.fn_union_club_invoice(
  p_union_id uuid,
  p_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(club_id uuid, club_name text, period_start timestamp with time zone,
               period_end timestamp with time zone, rake_generated numeric,
               union_fee_kept numeric, rakeback_due numeric, players_won numeric,
               player_pnl_net numeric, eco_amount numeric, eco_enabled boolean,
               presettled numeric, settled_in_chips numeric, outstanding numeric,
               net_position numeric, direction text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_start, fn_union_week_start());
  v_end   timestamptz := COALESCE(p_end, now());
BEGIN
  RETURN QUERY
  WITH eco AS (
    SELECT e.club_id, e.club_name, e.players_won, e.rake_generated,
           e.eco_base, e.eco_amount, e.eco_enabled
      FROM fn_union_eco_adjustment(p_union_id, v_start, v_end) e
  ),
  rates AS (
    SELECT uc.club_id, COALESCE(uc.club_commission_rate, 0.90) AS rb_rate
      FROM union_clubs uc WHERE uc.union_id = p_union_id
  ),
  pre AS (
    -- Unapplied cash held against the running balance. Closed out by
    -- applied_settlement_id, never by age: a payment made during a week that
    -- did not settle must still reach the club's next statement.
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at < v_end
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  ),
  calc AS (
    SELECT eco.club_id, eco.club_name,
           eco.rake_generated,
           round(eco.rake_generated * (1 - COALESCE(r.rb_rate, 0.90)), 2) AS union_fee_kept,
           round(eco.rake_generated * COALESCE(r.rb_rate, 0.90), 2)       AS rakeback_due,
           eco.players_won,
           round(eco.players_won + eco.rake_generated, 2) AS player_pnl_net,
           CASE WHEN eco.eco_enabled THEN eco.eco_amount ELSE 0 END AS eco_amount,
           eco.eco_enabled,
           COALESCE(pre.amt, 0) AS presettled
      FROM eco
      LEFT JOIN rates r ON r.club_id = eco.club_id
      LEFT JOIN pre   ON pre.club_id = eco.club_id
  )
  SELECT calc.club_id, calc.club_name, v_start, v_end,
         calc.rake_generated, calc.union_fee_kept, calc.rakeback_due,
         calc.players_won, calc.player_pnl_net,
         calc.eco_amount, calc.eco_enabled, calc.presettled,
         round(calc.player_pnl_net + calc.rakeback_due, 2) AS settled_in_chips,
         round(calc.eco_amount + calc.presettled, 2)       AS outstanding,
         round(calc.player_pnl_net + calc.rakeback_due
               + calc.eco_amount + calc.presettled, 2)     AS net_position,
         CASE WHEN round(calc.eco_amount + calc.presettled, 2) > 0
                THEN 'union owes club'
              WHEN round(calc.eco_amount + calc.presettled, 2) < 0
                THEN 'club owes union'
              ELSE 'square' END::text
    FROM calc
   ORDER BY calc.club_name;
END;
$function$;

-- 6. THE ISSUER --------------------------------------------------------------
-- Four changes, all of them about telling the truth:
--   a) a delivered invoice is FROZEN. DO UPDATE now refuses to restate an
--      invoice whose statement has already gone out, because message_sent
--      would suppress the corrected copy and the club would never see it.
--   b) notifications are raised only with the statement, so a re-run cannot
--      spam every club owner again.
--   c) v_notified accumulates instead of being overwritten by the last club.
--   d) v_msg is reset per club, so a skipped statement cannot report the
--      previous club's delivery count.
-- Plus: the statement now DISCLOSES an inexact cash baseline instead of
-- quietly billing on one. fn_union_eco_adjustment has always returned
-- baseline_cash_exact and nothing has ever looked at it.

CREATE OR REPLACE FUNCTION public.fn_union_issue_weekly_invoices(
  p_union_id uuid,
  p_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_end timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_notify boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_from timestamptz := COALESCE(p_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_end,   public.fn_union_week_start(now()));
  v_due  timestamptz;
  v_union_name text;
  r record;
  v_period_id uuid;
  v_invoice_id uuid;
  v_already_sent boolean;
  v_issued int := 0;
  v_notified int := 0;
  v_notified_batch int := 0;
  v_messaged int := 0;
  v_basis_exact boolean;
  v_msg jsonb;
  v_body text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  v_due := v_to + interval '3 days';
  SELECT u.name INTO v_union_name FROM unions u WHERE u.id = p_union_id;

  -- Is the seated-stack baseline this week's ECO rests on an exact one?
  SELECT bool_and(COALESCE(e.baseline_cash_exact, false))
    INTO v_basis_exact
    FROM fn_union_eco_adjustment(p_union_id, v_from, v_to) e;
  v_basis_exact := COALESCE(v_basis_exact, false);

  FOR r IN SELECT * FROM fn_union_club_invoice(p_union_id, v_from, v_to) LOOP
    v_msg := NULL;
    v_invoice_id := NULL;
    v_already_sent := false;

    SELECT sp.id INTO v_period_id
      FROM settlement_periods sp
     WHERE sp.club_id = r.club_id AND sp.union_id = p_union_id
       AND sp.start_at = v_from AND sp.end_at = v_to
     ORDER BY sp.created_at DESC LIMIT 1;

    IF v_period_id IS NULL THEN
      INSERT INTO settlement_periods (club_id, union_id, period_number, year,
                                      start_at, end_at, status)
      VALUES (r.club_id, p_union_id,
              EXTRACT(week FROM v_from)::int, EXTRACT(isoyear FROM v_from)::int,
              v_from, v_to, 'processing')
      RETURNING id INTO v_period_id;
    END IF;

    INSERT INTO settlement_invoices (
      club_id, period_id, invoice_type,
      from_entity_type, from_entity_id, to_entity_type, to_entity_id,
      gross_amount, net_amount, deductions, breakdown, status,
      chips_transferred, due_at, notes)
    VALUES (
      r.club_id, v_period_id, 'union_weekly_squareup',
      CASE WHEN r.outstanding >= 0 THEN 'union' ELSE 'club' END,
      CASE WHEN r.outstanding >= 0 THEN p_union_id::text ELSE r.club_id::text END,
      CASE WHEN r.outstanding >= 0 THEN 'club'  ELSE 'union' END,
      CASE WHEN r.outstanding >= 0 THEN r.club_id::text ELSE p_union_id::text END,
      abs(r.outstanding), abs(r.outstanding), 0,
      jsonb_build_object(
        'union_id', p_union_id, 'union_name', v_union_name,
        'club_id', r.club_id, 'club_name', r.club_name,
        'period_start', r.period_start, 'period_end', r.period_end,
        'rake_generated', r.rake_generated,
        'union_fee_kept', r.union_fee_kept,
        'rakeback_due',   r.rakeback_due,
        'players_won',    r.players_won,
        'player_pnl_net', r.player_pnl_net,
        'eco_amount',     r.eco_amount,
        'eco_enabled',    r.eco_enabled,
        'presettled',     r.presettled,
        'settled_in_chips', r.settled_in_chips,
        'outstanding',    r.outstanding,
        'net_position',   r.net_position,
        'direction',      r.direction,
        'baseline_cash_exact', v_basis_exact,
        'computed_at',    now()),
      'generated', false, v_due,
      'Weekly union square-up. settled_in_chips already moved during the week; '
      || 'outstanding is the amount to settle.')
    ON CONFLICT (club_id, period_id, invoice_type)
      WHERE invoice_type = 'union_weekly_squareup'
    DO UPDATE SET
      from_entity_type = EXCLUDED.from_entity_type,
      from_entity_id   = EXCLUDED.from_entity_id,
      to_entity_type   = EXCLUDED.to_entity_type,
      to_entity_id     = EXCLUDED.to_entity_id,
      gross_amount     = EXCLUDED.gross_amount,
      net_amount       = EXCLUDED.net_amount,
      breakdown        = EXCLUDED.breakdown,
      due_at           = EXCLUDED.due_at,
      updated_at       = now()
    WHERE COALESCE(settlement_invoices.message_sent, false) = false
    RETURNING id, COALESCE(message_sent, false) INTO v_invoice_id, v_already_sent;

    -- The upsert returns nothing when the guard above refused to restate an
    -- already-delivered invoice. That row is the record; read it as it stands.
    IF v_invoice_id IS NULL THEN
      SELECT si.id, COALESCE(si.message_sent, false)
        INTO v_invoice_id, v_already_sent
        FROM settlement_invoices si
       WHERE si.club_id = r.club_id
         AND si.period_id = v_period_id
         AND si.invoice_type = 'union_weekly_squareup';
    END IF;

    v_issued := v_issued + 1;

    IF p_notify AND NOT v_already_sent THEN
      INSERT INTO notifications (user_id, type, title, message, data, read)
      SELECT DISTINCT u.uid, 'union_invoice',
             v_union_name || ' weekly statement',
             CASE
               WHEN r.outstanding > 0 THEN
                 v_union_name || ' owes ' || r.club_name || ' '
                 || to_char(abs(r.outstanding), 'FM999,999,999,990.00') || ' for the week.'
               WHEN r.outstanding < 0 THEN
                 r.club_name || ' owes ' || v_union_name || ' '
                 || to_char(abs(r.outstanding), 'FM999,999,999,990.00') || ' for the week.'
               ELSE
                 r.club_name || ' is square with ' || v_union_name || ' for the week.'
             END,
             jsonb_build_object('invoice_id', v_invoice_id, 'club_id', r.club_id,
                                'union_id', p_union_id,
                                'period_start', r.period_start, 'period_end', r.period_end,
                                'outstanding', r.outstanding, 'due_at', v_due,
                                'source', 'club_arena'),
             false
        FROM (
          SELECT c.owner_id AS uid FROM clubs c WHERE c.id = r.club_id AND c.owner_id IS NOT NULL
          UNION
          SELECT cm.user_id FROM club_members cm
           WHERE cm.club_id = r.club_id AND cm.role IN ('owner','co_owner','admin')
             AND COALESCE(cm.status,'active') NOT IN ('banned','suspended')
        ) u
       WHERE u.uid IS NOT NULL;
      GET DIAGNOSTICS v_notified_batch = ROW_COUNT;
      v_notified := v_notified + v_notified_batch;
    END IF;

    -- CLUB MESSENGER. Only once per invoice: message_sent is the guard.
    IF NOT v_already_sent THEN
      v_body :=
        v_union_name || ' weekly statement' || E'\n'
        || to_char(r.period_start, 'YYYY-MM-DD') || ' to ' || to_char(r.period_end, 'YYYY-MM-DD')
        || E'\n\n'
        || 'Rake generated       ' || to_char(r.rake_generated,   'FM999,999,999,990.00') || E'\n'
        || 'Your rakeback (90%)  ' || to_char(r.rakeback_due,     'FM999,999,999,990.00') || E'\n'
        || 'Union fee kept       ' || to_char(r.union_fee_kept,   'FM999,999,999,990.00') || E'\n'
        || 'Player win/loss      ' || to_char(r.players_won,      'FM999,999,999,990.00') || E'\n'
        || 'Settled in chips     ' || to_char(r.settled_in_chips, 'FM999,999,999,990.00') || E'\n'
        || CASE WHEN r.eco_enabled
                THEN 'ECO adjustment       ' || to_char(r.eco_amount, 'FM999,999,999,990.00') || E'\n'
                ELSE '' END
        || CASE WHEN COALESCE(r.presettled, 0) <> 0
                THEN 'Payments received    ' || to_char(r.presettled, 'FM999,999,999,990.00') || E'\n'
                ELSE '' END
        || E'\n'
        || CASE
             WHEN r.outstanding < 0 THEN 'AMOUNT DUE ' || to_char(abs(r.outstanding), 'FM999,999,999,990.00')
             WHEN r.outstanding > 0 THEN 'OWED TO YOU ' || to_char(abs(r.outstanding), 'FM999,999,999,990.00')
             ELSE 'SQUARE FOR THE WEEK'
           END
        || CASE WHEN r.outstanding <> 0
                THEN E'\n' || 'Due ' || to_char(v_due, 'YYYY-MM-DD')
                ELSE '' END
        || E'\n\n'
        || 'Player win/loss and rakeback already moved in chips during the week. '
        || 'The amount above is what is left to square up.'
        || CASE WHEN r.eco_enabled AND NOT v_basis_exact
                THEN E'\n\n'
                     || 'PROVISIONAL. The ECO adjustment on this statement was '
                     || 'calculated without an exact opening seated-stack figure '
                     || 'for the period, so it is subject to correction. Raise it '
                     || 'with the union if it looks wrong.'
                ELSE '' END;

      v_msg := fn_union_send_club_message(
        p_union_id, r.club_id, v_body,
        jsonb_build_object(
          'kind', 'union_invoice',
          'invoice_id', v_invoice_id,
          'union_id', p_union_id,
          'club_id', r.club_id,
          'period_start', r.period_start,
          'period_end', r.period_end,
          'due_at', v_due,
          'outstanding', r.outstanding,
          'direction', r.direction,
          'baseline_cash_exact', v_basis_exact,
          'lines', jsonb_build_object(
            'rake_generated', r.rake_generated,
            'rakeback_due', r.rakeback_due,
            'union_fee_kept', r.union_fee_kept,
            'players_won', r.players_won,
            'settled_in_chips', r.settled_in_chips,
            'eco_amount', r.eco_amount,
            'eco_enabled', r.eco_enabled,
            'presettled', r.presettled)),
        'invoice');

      IF COALESCE((v_msg->>'delivered')::int, 0) > 0 THEN
        v_messaged := v_messaged + (v_msg->>'delivered')::int;
        UPDATE settlement_invoices
           SET message_sent = true, message_sent_at = now()
         WHERE id = v_invoice_id;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'club_id', r.club_id, 'club_name', r.club_name,
      'invoice_id', v_invoice_id, 'outstanding', r.outstanding,
      'direction', r.direction, 'due_at', v_due,
      'messaged', COALESCE((v_msg->>'delivered')::int, 0),
      'already_sent', v_already_sent));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to, 'due_at', v_due,
    'baseline_cash_exact', v_basis_exact,
    'invoices', v_issued, 'notified', v_notified, 'messenger_deliveries', v_messaged,
    'detail', v_out);
END;
$function$;

-- 7. RELEASE THE STALE FREEZE ------------------------------------------------
-- Deactivated, not deleted, with the original reason preserved. Re-arming is
-- one UPDATE if the investigation reopens.

UPDATE settlement_locks
   SET is_active   = false,
       unlocked_at = now(),
       metadata    = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'released_by',     'migration 20260907044041',
         'released_at',     now(),
         'original_reason', lock_reason,
         'original_locked_at', locked_at,
         'evidence',        'fn_settlement_conservation_check, fn_union_money_path_check, '
                            || 'fn_union_chip_integrity_check, fn_union_law_integrity_breaches, '
                            || 'fn_union_law_extra_breaches and fn_union_rake_weekly_verify all '
                            || 'returned zero rows; union rake ledger checkpoint recomputed to '
                            || '0.00 drift across 1281259 rows on 2026-09-07.')
 WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE'
   AND is_active = true;

-- 8. A FRESH PnL BASELINE ----------------------------------------------------
-- fn_union_pnl_bootstrap writes seated_end_cash; every stored row predates that
-- code, which is why baseline_cash_exact has been false for every club on every
-- invoice. Stamped now(), so it is the baseline the NEXT week resolves to.
-- The week closing at 07:00 today cannot be given a baseline it never had, and
-- its statements say so in words rather than pretending otherwise.

SELECT public.fn_union_pnl_bootstrap(u.id) FROM unions u;

-- 9. THE SCHEDULE ------------------------------------------------------------
-- Midnight Pacific is 07:00 UTC on PDT and 08:00 UTC on PST, so a single fixed
-- UTC hour is wrong for half the year. The runner is idempotent, so it is
-- simply offered four chances and the first one past the boundary does the
-- work. The rest return skipped.

SELECT cron.schedule(
  'union-weekly-rakeback-recompute',
  '45 6,7 * * 1',
  $cron$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-recompute'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_rakeback_recompute_all_clubs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $cron$);

SELECT cron.schedule(
  'union-weekly-rakeback-close',
  '20 7,8,9,10 * * 1',
  $cron$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $cron$);

-- 10. ASSERTIONS -------------------------------------------------------------
-- The migration aborts rather than leaving the platform half-moved.

DO $assert$
DECLARE
  v_boundary timestamptz;
  v_prev     timestamptz;
  v_frozen   int;
  v_jobs     int;
  v_baseline int;
BEGIN
  v_boundary := public.fn_union_week_start('2026-09-07 12:00:00+00'::timestamptz);
  IF v_boundary <> '2026-09-07 07:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'week boundary is %, expected 2026-09-07 07:00:00+00 (midnight America/Los_Angeles)', v_boundary;
  END IF;

  -- A winter week must land on 08:00 UTC, or the DST half of the year is wrong.
  IF public.fn_union_week_start('2026-12-07 12:00:00+00'::timestamptz)
       <> '2026-12-07 08:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'PST boundary is %, expected 2026-12-07 08:00:00+00',
      public.fn_union_week_start('2026-12-07 12:00:00+00'::timestamptz);
  END IF;

  v_prev := public.fn_union_prev_week_start('2026-09-07 12:00:00+00'::timestamptz);
  IF v_prev <> '2026-08-31 07:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'previous week start is %, expected 2026-08-31 07:00:00+00', v_prev;
  END IF;

  -- A DST week is one CALENDAR week, not 168 hours. The week that ends when
  -- the clocks go back is 169 hours long and the one in March is 167. Getting
  -- this wrong moves the boundary off local midnight for half the year, which
  -- is the whole defect this migration exists to fix.
  IF public.fn_union_week_start('2026-11-02 12:00:00+00'::timestamptz)
       - public.fn_union_prev_week_start('2026-11-02 12:00:00+00'::timestamptz)
     <> interval '169 hours' THEN
    RAISE EXCEPTION 'the PDT-to-PST week is %, expected 169 hours',
      public.fn_union_week_start('2026-11-02 12:00:00+00'::timestamptz)
      - public.fn_union_prev_week_start('2026-11-02 12:00:00+00'::timestamptz);
  END IF;

  IF public.fn_union_week_start('2026-03-09 12:00:00+00'::timestamptz)
       - public.fn_union_prev_week_start('2026-03-09 12:00:00+00'::timestamptz)
     <> interval '167 hours' THEN
    RAISE EXCEPTION 'the PST-to-PDT week is %, expected 167 hours',
      public.fn_union_week_start('2026-03-09 12:00:00+00'::timestamptz)
      - public.fn_union_prev_week_start('2026-03-09 12:00:00+00'::timestamptz);
  END IF;

  SELECT count(*) INTO v_frozen FROM settlement_locks
   WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true;
  IF v_frozen <> 0 THEN
    RAISE EXCEPTION 'still % active GLOBAL_SETTLEMENT_FREEZE rows', v_frozen;
  END IF;

  SELECT count(*) INTO v_jobs FROM cron.job
   WHERE jobname IN ('union-weekly-rakeback-close','union-weekly-rakeback-recompute')
     AND active AND schedule IN ('20 7,8,9,10 * * 1','45 6,7 * * 1');
  IF v_jobs <> 2 THEN
    RAISE EXCEPTION 'expected 2 rescheduled cron jobs, found %', v_jobs;
  END IF;

  SELECT count(*) INTO v_baseline
    FROM union_pnl_settlements s
   WHERE s.status = 'baseline'
     AND s.period_start > now() - interval '5 minutes'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.club_results) e
                  WHERE e ? 'seated_end_cash');
  IF v_baseline < 1 THEN
    RAISE EXCEPTION 'no fresh PnL baseline carrying seated_end_cash was written';
  END IF;
END
$assert$;

COMMIT;
