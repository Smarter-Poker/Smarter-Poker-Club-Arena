-- Weekly settlement must use the same Pacific calendar as its statements.
-- The scheduled cursor applied a UTC-midnight floor after aligning weeks,
-- then stepped by fixed seven-day UTC intervals. This could close misaligned
-- ranges, skip hours on the next pass, and drift across daylight saving time.
-- A direct close also admitted overlapping ranges under different identities.
-- Keep the existing reset floor and fund sources; align to complete union
-- weeks and reject overlap after taking the existing union-wallet lock.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $precondition$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) <> 'df70d876f28640a1332a9dd0e4d043f7' THEN
 RAISE EXCEPTION 'fn_union_weekly_rakeback_close changed since inspection'; END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_rw_before    numeric;
  v_cb_before    numeric;
  v_clubs_before numeric := 0;
  v_clubs_after  numeric := 0;
  v_credit       jsonb;
  v_sref         text;
  v_sid          uuid;
  v_sstate       text;
  v_actor        uuid;
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f
              WHERE f.union_id = p_union_id
                AND p_period_start < f.earliest_period_start) THEN
    RETURN jsonb_build_object('success', false, 'error', 'before_settlement_floor');
  END IF;

  -- Every entry point uses the union's calendar, including DST boundaries.
  IF p_period_start <> public.fn_union_week_start(p_period_start)
     OR p_period_end <> public.fn_union_week_start(p_period_end)
     OR p_period_end > public.fn_union_week_start(now()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_not_closed_union_weeks');
  END IF;

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  -- settlement walk: one row per (union, period), resumable after 'failed'
  v_sref := p_union_id::text || ':'
    || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_period_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT id, state INTO v_sid, v_sstate
    FROM ca_settlements
   WHERE settlement_type = 'union_rakeback_close' AND external_ref = v_sref
   FOR UPDATE;
  IF v_sid IS NULL THEN
    INSERT INTO ca_settlements (id, settlement_type, external_ref, state, union_id, totals)
    VALUES (gen_random_uuid(), 'union_rakeback_close', v_sref, 'open', p_union_id, '{}'::jsonb)
    RETURNING id INTO v_sid;
  ELSIF v_sstate = 'final' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed', 'settlement_id', v_sid);
  ELSIF v_sstate = 'failed' THEN
    UPDATE ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_sid;  -- resume
  ELSE
    -- intermediate states never persist (single transaction), so anything
    -- else here is a concurrent close of the same period. Refuse loudly.
    RETURN jsonb_build_object('success', false, 'error', 'close_already_in_state_' || v_sstate,
                              'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'locked_for_calculation' WHERE id = v_sid;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'no_wallet' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet', 'settlement_id', v_sid);
  END IF;

  -- Recheck after the union wallet lock: concurrent overlapping closes cannot
  -- both consume the same rake credits under different period identities.
  IF EXISTS (SELECT 1 FROM public.union_rakeback_log l
              WHERE l.union_id = p_union_id
                AND l.period_start < p_period_end AND l.period_end > p_period_start) THEN
    UPDATE public.ca_settlements SET state = 'failed', error_detail = 'overlapping_closed_period' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'overlapping_closed_period', 'settlement_id', v_sid);
  END IF;

  /* THE PERIOD (unchanged): everything the rake treasury received. Each credit
     now also carries the GAME TYPE it came from: the named tournament's
     tournament_type, or cash when it names none. */
  DROP TABLE IF EXISTS _uwrb_credits;
  CREATE TEMP TABLE _uwrb_credits ON COMMIT DROP AS
  WITH raw AS (
    SELECT t.id, t.amount, t.notes, t.created_at,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_period_start AND t.created_at < p_period_end
  )
  SELECT r.id, r.amount, r.notes, r.created_at, r.tournament_id,
         CASE WHEN r.tournament_id IS NULL THEN 'cash'
              ELSE COALESCE(lower(tr.tournament_type), 'other') END AS game_type
    FROM raw r
    LEFT JOIN tournaments tr ON tr.id = r.tournament_id;

  DROP TABLE IF EXISTS _uwrb_by_type;
  /* THE BASIS (Dan, 2026-09-03) lives in fn_union_club_rake_basis since
     Phase 6 (20260907): the statement and the reconciliation report read
     the same function, so what is paid and what is described cannot
     diverge. The block that used to be here is that function, verbatim. */
  CREATE TEMP TABLE _uwrb_by_type ON COMMIT DROP AS
  SELECT b.club_id, b.game_type, b.rake_in, b.rate, b.payout
    FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true) b;

  /* The per-club roll-up the money section pays from. */
  DROP TABLE IF EXISTS _uwrb;
  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT club_id,
         round(sum(rake_in), 2) AS rake_in,
         round(sum(payout), 2)  AS payout
    FROM _uwrb_by_type
   GROUP BY club_id;

  SELECT round(COALESCE(SUM(amount), 0), 2) INTO v_period_total FROM _uwrb_credits;
  SELECT round(COALESCE(SUM(payout), 0), 2) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;
  v_retained := round(v_period_total - v_payout_total, 2);

  /* a share can never exceed what the treasury received: the attribution is
     a view of the same credits, so this only trips on a data fault */
  IF v_payout_total > v_period_total THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'attribution_exceeds_treasury' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'attribution_exceeds_treasury',
      'period_rake', v_period_total, 'payout', v_payout_total, 'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements
     SET state = 'calculated',
         totals = jsonb_build_object('period_rake', v_period_total, 'payout_total', v_payout_total,
                                     'retained', v_retained,
                                     'basis', 'players_of_the_club_at_union_tables',
                                     'rate_model', 'per_game_type',
                                     'basis_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, rake_in), '{}'::jsonb) FROM _uwrb),
                                     'payout_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, payout), '{}'::jsonb) FROM _uwrb),
                                     'basis_detail', (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', club_id, 'game_type', game_type, 'rake_in', rake_in, 'rate', rate, 'payout', payout) ORDER BY club_id, game_type), '[]'::jsonb) FROM _uwrb_by_type),
                                     'basis_by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type, x), '{}'::jsonb)
                                                              FROM (SELECT game_type,
                                                                           jsonb_build_object('basis', round(sum(rake_in), 2),
                                                                                              'payout', round(sum(payout), 2)) AS x
                                                                      FROM _uwrb_by_type GROUP BY game_type) g),
                                     'rates', (SELECT COALESCE(jsonb_object_agg(club_id::text || ':' || game_type, rate), '{}'::jsonb)
                                                 FROM _uwrb_by_type))
   WHERE id = v_sid;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake',
      'settlement_id', v_sid);
  END IF;

  /* SEPARATE POTS (Phase 2.1). The rake treasury owes the whole period: the
     clubs' share leaves it as rakeback, the union's share leaves it for the
     general bank. The general bank is never a source. A treasury that cannot
     cover the period refuses the close whole - never partial, never from the
     bank - and says so. Who eats a short treasury is Dan's ruling
     (roadmap decision 4). */
  IF v_period_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'insufficient_rake_treasury' WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-insufficient:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      v_period_total - COALESCE(v_wallet.rake_wallet, 0),
      v_period_total,
      COALESCE(v_wallet.rake_wallet, 0),
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      'union rake treasury cannot cover the period it owes; close refused before any movement (the general bank is never a source)',
      true,
      jsonb_build_object('rake_wallet', v_wallet.rake_wallet,
                         'chip_balance', v_wallet.chip_balance,
                         'period_total', v_period_total,
                         'payout', v_payout_total, 'retained', v_retained,
                         'period_start', p_period_start, 'period_end', p_period_end));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_rake_treasury', 'retryable', true,
      'period_rake', v_period_total, 'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance,
      'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;

  -- guarded money section: all of it lands, or none of it does
  BEGIN
    /* One declaration for every balance write below. The union_wallets
       auto-ledger is skipped: the union side of each club credit is the
       from-leg of the club's own row, and the retained share is written
       explicitly. */
    PERFORM public.fn_ca_declare_ledger('rakeback', 'union_wallet', p_union_id, v_sid, NULL,
                                        ARRAY['union_wallets']);
    v_actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

    v_rw_before := round(COALESCE(v_wallet.rake_wallet, 0), 2);
    v_cb_before := round(COALESCE(v_wallet.chip_balance, 0), 2);
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_before
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    FOR v_club IN
      SELECT club_id, rake_in, payout FROM _uwrb
       WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0
    LOOP
      v_credit := fn_credit_treasury(
        v_club.club_id, v_club.payout,
        'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
          || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
        jsonb_build_object('union_id', p_union_id,
                           'period_start', p_period_start, 'period_end', p_period_end,
                           'rake_basis', v_club.rake_in, 'rate', 'per_game_type',
                           'by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type,
                                                     jsonb_build_object('basis', rake_in, 'rate', rate, 'payout', payout)), '{}'::jsonb)
                                              FROM _uwrb_by_type g WHERE g.club_id = v_club.club_id),
                           'settlement_id', v_sid),
        'union_close:' || v_sid::text || ':' || v_club.club_id::text
      );
      IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
      END IF;
      v_clubs_paid := v_clubs_paid + 1;
    END LOOP;

    -- one debit per pot: the treasury pays the whole period; the retained
    -- share moves to the general bank
    UPDATE union_wallets
       SET rake_wallet       = rake_wallet - v_period_total,
           chip_balance      = chip_balance + v_retained,
           total_settlements = COALESCE(total_settlements, 0) + v_payout_total,
           updated_at        = now()
     WHERE union_id = p_union_id
     RETURNING round(rake_wallet, 2), round(chip_balance, 2) INTO v_new_rw, v_new_cb;

    INSERT INTO union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
           'Weekly rakeback to club at the per-game-type rate (period '
             || to_char(p_period_start, 'YYYY-MM-DD') || '..'
             || to_char(p_period_end, 'YYYY-MM-DD') || ')'
      FROM _uwrb
     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

    IF v_retained > 0 THEN
      INSERT INTO union_wallet_transactions
        (union_id, amount, tx_type, wallet, direction, balance_after, notes)
      VALUES
        (p_union_id, v_retained, 'rake_hold', 'rake_wallet', 'debit', v_new_rw,
         'Union retained share + self-club rake, out of the rake treasury (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')'),
        (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
         'Union retained share + self-club rake, into the general bank (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')');

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, union_id, description, idempotency_key, metadata)
      VALUES
        (v_actor, 'union_wallet', p_union_id, 'union_bank', p_union_id,
         v_retained, 'treasury_transfer', p_union_id,
         'Weekly union close ' || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD')
           || ': retained share ' || v_retained || ' of period rake ' || v_period_total
           || ' moves from the rake treasury to the general bank (clubs paid '
           || v_payout_total || ')',
         'union_close:' || v_sid::text || ':retained',
         jsonb_build_object('settlement_id', v_sid, 'period_start', p_period_start,
                            'period_end', p_period_end, 'period_rake', v_period_total,
                            'payout_total', v_payout_total, 'clubs_paid', v_clubs_paid));
    END IF;

    /* CONSERVATION, ASSERTED ON THE BALANCES THEMSELVES (not on the plan).
       What left the treasury must equal what the clubs and the bank received,
       to the cent, or none of it lands. */
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_after
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    IF round((v_new_rw - v_rw_before) + (v_new_cb - v_cb_before) + (v_clubs_after - v_clubs_before), 2) <> 0
       OR round(v_new_rw - v_rw_before, 2) <> round(-v_period_total, 2)
       OR round(v_clubs_after - v_clubs_before, 2) <> round(v_payout_total, 2)
       OR round(v_new_cb - v_cb_before, 2) <> round(v_retained, 2) THEN
      RAISE EXCEPTION 'conservation violation in the weekly union close: treasury % -> %, bank % -> %, clubs % -> %, period % payout % retained %',
        v_rw_before, v_new_rw, v_cb_before, v_new_cb, v_clubs_before, v_clubs_after,
        v_period_total, v_payout_total, v_retained;
    END IF;

    UPDATE ca_settlements
       SET state = 'ledger_posted',
           totals = totals || jsonb_build_object('clubs_paid', v_clubs_paid,
                                                 'retained', v_retained,
                                                 'rw_debit', v_period_total,
                                                 'conservation', 'asserted')
     WHERE id = v_sid;

    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  EXCEPTION WHEN OTHERS THEN
    -- every money movement above just rolled back to the section start
    UPDATE ca_settlements
       SET state = 'failed', error_detail = left(SQLERRM, 2000)
     WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-close-failed:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      0, NULL, NULL,
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      left('weekly rakeback close aborted mid-flight and rolled back cleanly: ' || SQLERRM, 500),
      true,
      jsonb_build_object('sqlstate', SQLSTATE,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'clubs_paid_before_abort', v_clubs_paid));
    RETURN jsonb_build_object('success', false, 'error', 'close_failed', 'retryable', true,
      'detail', SQLERRM, 'settlement_id', v_sid);
  END;

  UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'retained_to_bank', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb,
    'conservation', 'asserted',
    'settlement_id', v_sid);
END
$function$
;
REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) TO service_role;
DO $precondition$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close_all(uuid)'::regprocedure)) <> '1b87f103e4332c28f680897d10e077ec' THEN
 RAISE EXCEPTION 'fn_union_weekly_rakeback_close_all changed since inspection'; END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close_all(p_union_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union        record;
  v_cursor       timestamptz;
  v_current_week timestamptz := public.fn_union_week_start(now());
  v_result       jsonb;
  v_next         timestamptz;
  v_boundary     timestamptz;
  v_results      jsonb := '[]'::jsonb;
  v_guard        integer;
BEGIN
  FOR v_union IN
    SELECT id FROM unions WHERE p_union_id IS NULL OR id = p_union_id
  LOOP
    SELECT MAX(period_end) INTO v_cursor
      FROM union_rakeback_log WHERE union_id = v_union.id;
    IF v_cursor IS NULL THEN
      SELECT MIN(created_at) INTO v_cursor
        FROM union_wallet_transactions
       WHERE union_id = v_union.id
         AND wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake';
      IF v_cursor IS NULL THEN CONTINUE; END IF;
      v_cursor := public.fn_union_week_start(v_cursor);

    END IF;

    -- Never resume before the union's settlement floor. GREATEST ignores
    -- NULLs, so a union with no floor row is unaffected.
    v_cursor := GREATEST(v_cursor, (SELECT f.earliest_period_start
                                      FROM public.union_settlement_floor f
                                     WHERE f.union_id = v_union.id));

    -- The reset floor and legacy cursor may be UTC-midnight timestamps.
    -- Round UP once to a real union Monday, after applying the floor.
    v_boundary := public.fn_union_week_start(v_cursor);
    IF v_boundary < v_cursor THEN
      v_boundary := public.fn_union_week_start(v_boundary + interval '8 days');
    END IF;
    v_cursor := v_boundary;

    v_guard := 0;
    v_next := public.fn_union_week_start(v_cursor + interval '8 days');
    WHILE v_next <= v_current_week AND v_guard < 60 LOOP
      v_result := fn_union_weekly_rakeback_close(
        v_union.id, v_cursor, v_next);
      IF COALESCE(v_result->>'error', '') NOT IN ('', 'already_executed') THEN
        v_results := v_results || jsonb_build_object(
          'union_id', v_union.id, 'period_start', v_cursor, 'result', v_result);
        EXIT;
      END IF;
      IF (v_result->>'success')::boolean IS TRUE THEN
        v_results := v_results || jsonb_build_object(
          'union_id', v_union.id, 'period_start', v_cursor, 'result', v_result);
      END IF;
      v_cursor := v_next;
      v_next := public.fn_union_week_start(v_cursor + interval '8 days');
      v_guard := v_guard + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'closes', v_results);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close_all(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_weekly_rakeback_close_all(uuid) TO service_role;
COMMIT;
