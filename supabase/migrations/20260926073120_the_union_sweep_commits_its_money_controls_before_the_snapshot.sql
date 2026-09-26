-- 20260926073120_the_union_sweep_commits_its_money_controls_before_the_snapshot
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 07:31:20 UTC.
--
-- ===========================================================================
--  THE UNION SWEEP COMMITS ITS MONEY CONTROLS BEFORE THE SNAPSHOT
-- ===========================================================================
--
-- What was wrong
-- --------------
-- pg_cron job 123 (union-integrity-sweep, :35 every hour) runs
-- public.fn_union_integrity_sweep_all() as ONE statement in ONE transaction,
-- under the postgres role's statement_timeout of 2 min (pg_db_role_setting).
-- Inside that transaction, per union, it ran:
--
--     fn_union_integrity_sweep -> fn_union_rake_basis_refresh
--       -> fn_union_age_invoices -> fn_union_enforce_stop_loss
--     then expire_settlement_locks / fn_settlement_lock_hygiene
--     then fn_close_due_settlement_periods
--
-- Each is wrapped in BEGIN ... EXCEPTION WHEN OTHERS, but OTHERS does not
-- match query_canceled. A statement timeout therefore rolls back EVERYTHING
-- the sweep did that hour: the stop-loss suspensions, the invoice ageing, the
-- lock hygiene and the period closes.
--
-- 20260926042119 made fn_union_rake_basis_refresh read the open week through
-- the rakeback settler's cursor instead of failing fast, so it now runs the
-- full certified plan (fn_accounting_union_earned_plan) every hour. Measured
-- 2026-09-26:
--   * sweep duration 06:35 = 85.3 s, 07:35 = 94.6 s (9-20 s while the refresh
--     failed fast);
--   * snapshot compute_ms 77,637 (06:35) and 69,160 (07:35) for 1.5 days of
--     the week (2026-09-21 07:00 .. cursor 2026-09-22 ~19:30);
--   * the plan alone, rolled back: 70.9 s (07:24), 29.5 s (07:27), 25.8 s and
--     14.8 s (07:40). It is load dependent and linear in the rows the cursor
--     has reached; the settler is catching up roughly 15x faster than real
--     time (19:39 -> 19:45 on the cursor in 25 s), so the window will grow from
--     1.5 days toward the whole week within hours, and the plan with it.
-- Past 120 s the stop-loss and period closes would roll back every hour.
--
-- What this changes
-- -----------------
-- 1. fn_union_integrity_sweep_all runs every money control FIRST (integrity,
--    ageing, stop-loss, lock hygiene, period closes; 1.2-1.3 s measured) and
--    refreshes the open-week snapshot LAST, in its own subtransaction that also
--    traps query_canceled. If the refresh runs out of the statement's time,
--    only the refresh is rolled back, ONE open warning says so (deduplicated on
--    the unresolved row), no further union is refreshed that hour (the timer
--    is spent), and the sweep returns normally so everything above commits.
--    Nothing the money controls read comes from the snapshot: pg_proc names
--    fn_union_rake_basis_refresh as the only function touching
--    union_rake_basis_snapshot, and no client, engine or World Hub code reads
--    it, so moving it after them changes none of their outcomes.
--
-- 2. fn_union_rake_basis_refresh records what it refreshed against
--    (input_stamp: the cursor-bounded `through` and the row counts of the
--    append-only tables the plan reads inside the window) and does NOT
--    recompute when the stamp is unchanged. Every one of those tables carries
--    an immutability trigger (accounting_cash_rake_sources,
--    accounting_tournament_recognized_sources, accounting_tournament_fee_*,
--    accounting_cash_bank_receipts, accounting_cash_accrual_batches,
--    accounting_agreement_history, union_wallet_transactions), so the same
--    `through` and the same counts mean the same rows, and the plan's detail
--    is a function of those rows: a recompute would write the same detail. A
--    moved cursor or any new row in the window changes the stamp and the plan
--    runs exactly as before. What a skip does not re-run is the plan's refusal
--    checks against rows OUTSIDE those tables (rake_records, clubs); those
--    checks can only refuse, which leaves the snapshot as it was - the same
--    thing a skip does.
--
-- Proved in rolled-back probes (one DO block each, ending in RAISE EXCEPTION,
-- with the new bodies as pg_temp functions; no DDL on a real object):
--   * cursor moved between two calls -> recomputed; cursor unchanged ->
--     skipped (sweep result rake_basis {refreshed 0, skipped 1});
--   * union_club_terms before/after identical: Club JAQK and SHARK CLUB stay
--     'suspended'; clubs_suspended 0, clubs_restored 0; every union
--     settlement_invoices row and every settlement_periods row unchanged;
--   * statement_timeout 8 s: the timer fired inside the refresh at 8.0 s, the
--     handler trapped it, the sweep returned normally, and a write made after
--     the money controls and before the refresh survived.
--
-- Nothing else moves: no chip, no invoice, no status. fn_union_enforce_stop_loss
-- itself is untouched.
-- docs/changelog/2026-09-26-the-union-sweep-commits-its-money-controls-before-the-snapshot.md

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_union_integrity_sweep_all(integer)'::regprocedure)
     IS DISTINCT FROM '9c30a4e71afe57fc694c797df7d0c6e0' THEN
    RAISE EXCEPTION 'PREIMAGE: fn_union_integrity_sweep_all is not the body this migration reorders';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure)
     IS DISTINCT FROM 'a9e223cf5ae32957b58f92806167f625' THEN
    RAISE EXCEPTION 'PREIMAGE: fn_union_rake_basis_refresh is not the cursor-bounded body of 20260926042119';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'union_rake_basis_snapshot'
                AND column_name = 'input_stamp') THEN
    RAISE EXCEPTION 'PREIMAGE: union_rake_basis_snapshot already has input_stamp';
  END IF;
END
$pre$;

ALTER TABLE public.union_rake_basis_snapshot ADD COLUMN input_stamp jsonb;
COMMENT ON COLUMN public.union_rake_basis_snapshot.input_stamp IS
  'What fn_union_rake_basis_refresh read: the cursor-bounded through and the row counts of the append-only plan inputs in the window. An unchanged stamp is not recomputed (20260926073120).';

CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_refresh(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through timestamptz; v_t0 timestamptz := clock_timestamp(); v_detail jsonb; v_n int;
  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;
  IF LEAST(p_end, now()) <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'window_not_open_yet');
  END IF;

  -- Cash earning sources are written by the rakeback settler as its durable
  -- cursor advances; every bank receipt below the cursor has been accrued and
  -- none above it is claimed. Read through that instant, never through now().
  SELECT d.high_water_mark INTO v_accrued FROM public.daemon_state d WHERE d.daemon = 'rakeback_settler';
  IF v_accrued IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_cursor_unknown');
  END IF;
  v_through := LEAST(p_end, now(), v_accrued);
  IF v_through <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_not_yet_in_window',
                              'accrued_through', v_accrued);
  END IF;

  -- WHAT THIS REFRESH WOULD READ (2026-09-26). Every table the plan reads its
  -- rows from is append-only, so the same through and the same counts in the
  -- window are the same rows, and the same rows are the same detail. An
  -- unchanged stamp is not recomputed; a moved cursor or a new row is.
  v_stamp := jsonb_build_object(
    'through', v_through,
    'bank', (SELECT jsonb_build_array(count(*), COALESCE(sum(t.amount), 0))
               FROM public.union_wallet_transactions t
              WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet' AND t.direction = 'credit'
                AND t.tx_type = 'rake' AND t.created_at >= p_start AND t.created_at < v_through),
    'cash_receipts', (SELECT count(*) FROM public.accounting_cash_bank_receipts c
                       WHERE c.union_id = p_union_id AND c.banked_at >= p_start AND c.banked_at < v_through),
    'recognitions', (SELECT count(*) FROM public.accounting_tournament_fee_recognitions f
                      WHERE f.union_id = p_union_id AND f.recognized_at >= p_start AND f.recognized_at < v_through),
    'sources', (SELECT jsonb_build_array(count(*), COALESCE(sum(s.rake_credit), 0))
                  FROM public.accounting_payable_earning_sources s
                 WHERE s.union_id = p_union_id AND s.earned_at >= p_start AND s.earned_at < v_through),
    'agreements', (SELECT jsonb_build_array(count(*), max(h.id)) FROM public.accounting_agreement_history h));

  SELECT s.input_stamp INTO v_prev FROM public.union_rake_basis_snapshot s
   WHERE s.union_id = p_union_id AND s.period_start = p_start AND s.period_end = p_end;
  IF v_prev IS NOT NULL AND v_prev = v_stamp THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'inputs_unchanged',
                              'union_id', p_union_id, 'period_start', p_start, 'period_end', p_end,
                              'through', v_through, 'accrued_through', v_accrued,
                              'check_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;

  INSERT INTO public.union_rake_basis_snapshot (union_id, period_start, period_end, through, computed_at, compute_ms, detail, input_stamp)
  VALUES (p_union_id, p_start, p_end, v_through, now(),
          (extract(epoch from clock_timestamp() - v_t0) * 1000)::int, v_detail, v_stamp)
  ON CONFLICT (union_id, period_start, period_end) DO UPDATE
    SET through = EXCLUDED.through, computed_at = EXCLUDED.computed_at,
        compute_ms = EXCLUDED.compute_ms, detail = EXCLUDED.detail,
        input_stamp = EXCLUDED.input_stamp;

  RETURN jsonb_build_object('success', true, 'skipped', false, 'union_id', p_union_id, 'period_start', p_start,
                            'period_end', p_end, 'through', v_through, 'rows', v_n,
                            'accrued_through', v_accrued,
                            'compute_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep_all(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u record; v_one jsonb; v_signals int := 0; v_unions int := 0; v_failed int := 0;
  v_suspended int := 0; v_restored int := 0; v_sl jsonb;
  v_rb jsonb; v_rb_refreshed int := 0; v_rb_skipped int := 0; v_rb_failed int := 0;
  v_rb_out_of_time boolean := false;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR u IN SELECT id FROM unions LOOP
    BEGIN
      v_one := public.fn_union_integrity_sweep(u.id, p_hours);
      v_signals := v_signals + COALESCE((v_one->>'signals')::int, 0);
      v_unions := v_unions + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;

    -- Age and chase what is past due, before enforcement reads it.
    BEGIN
      PERFORM public.fn_union_age_invoices(u.id);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_age_invoices', 'warning',
              'Ageing unpaid statements failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;

    -- Stop-loss enforcement rides the sweep rather than taking a schedule of
    -- its own (World Hub CLAUDE.md 11.3). It must never be able to stop the
    -- integrity sweep from finishing.
    BEGIN
      v_sl := public.fn_union_enforce_stop_loss(u.id);
      v_suspended := v_suspended + COALESCE((v_sl->>'suspended')::int, 0);
      v_restored  := v_restored  + COALESCE((v_sl->>'restored')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_enforce_stop_loss', 'warning',
              'Stop-loss enforcement failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;
  END LOOP;

  -- Expire locks whose time has passed. expire_settlement_locks() has
  -- existed since long before this and was called by nothing at all.
  BEGIN
    PERFORM public.expire_settlement_locks();
    PERFORM public.fn_settlement_lock_hygiene();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_settlement_lock_hygiene', 'warning',
            'Settlement lock hygiene failed',
            jsonb_build_object('error', SQLERRM));
  END;

  -- Close what is due. Never allowed to stop the sweep finishing.
  BEGIN
    PERFORM public.fn_close_due_settlement_periods();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_close_due_settlement_periods', 'warning',
            'Closing due settlement periods failed',
            jsonb_build_object('error', SQLERRM));
  END;

  -- THE OPEN-WEEK SNAPSHOT RUNS LAST (2026-09-26). It is a reporting read of
  -- the certified plan, linear in the week the settler has reached, and
  -- nothing above reads it. It runs after every money control so that its
  -- cost can never roll them back: a statement timeout (query_canceled, which
  -- WHEN OTHERS does not match) is trapped here, rolls back only this
  -- refresh, and ends the refreshing for this hour because the timer is spent.
  FOR u IN SELECT id FROM unions ORDER BY id LOOP
    BEGIN
      v_rb := public.fn_union_rake_basis_refresh(u.id, public.fn_union_week_start(now()),
                                                 public.fn_union_week_start(now()) + interval '7 days');
      IF COALESCE((v_rb->>'skipped')::boolean, false) THEN
        v_rb_skipped := v_rb_skipped + 1;
      ELSIF COALESCE((v_rb->>'success')::boolean, false) THEN
        v_rb_refreshed := v_rb_refreshed + 1;
      END IF;
    EXCEPTION
      WHEN query_canceled THEN
        v_rb_out_of_time := true;
        -- One open warning says so, not one an hour (the table has no reader
        -- but this warning; its readers are people).
        IF NOT EXISTS (SELECT 1 FROM financial_alerts a
                        WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
                          AND a.context->>'kind' = 'out_of_time'
                          AND a.context->>'union_id' = u.id::text) THEN
          INSERT INTO financial_alerts (source, severity, message, context)
          VALUES ('fn_union_rake_basis_refresh', 'warning',
                  'Refreshing the open-week rake basis snapshot ran out of the sweep''s time; the money controls committed and the snapshot keeps its previous refresh',
                  jsonb_build_object('kind', 'out_of_time', 'union_id', u.id, 'error', SQLERRM));
        END IF;
        EXIT;
      WHEN OTHERS THEN
        v_rb_failed := v_rb_failed + 1;
        INSERT INTO financial_alerts (source, severity, message, context)
        VALUES ('fn_union_rake_basis_refresh', 'warning',
                'Refreshing the open-week rake basis snapshot failed for a union',
                jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals,
                            'clubs_suspended', v_suspended, 'clubs_restored', v_restored,
                            'rake_basis', jsonb_build_object('refreshed', v_rb_refreshed,
                                                             'skipped', v_rb_skipped,
                                                             'failed', v_rb_failed,
                                                             'out_of_time', v_rb_out_of_time),
                            'window_hours', p_hours, 'ran_at', now());
END $function$;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_union_integrity_sweep_all(integer)'::regprocedure
                    AND p.prosecdef AND p.proconfig::text = '{search_path=public}'
                    AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure
                    AND p.prosecdef AND p.proconfig::text = '{search_path=public}'
                    AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'POSTIMAGE: the sweep or the refresh lost its owner, grants or settings';
  END IF;
END
$post$;

COMMIT;
