-- The live body of public.fn_union_integrity_sweep_all(integer) before
-- 20260926073120, read from pg_get_functiondef on production at 07:25 UTC
-- 2026-09-26 (prosrc md5 9c30a4e71afe57fc694c797df7d0c6e0). It was built by
-- string splicing in 20260908020401, so no single migration declares it; this
-- fixture is the negative proof for
-- tests/the-union-sweep-commits-its-money-controls-before-the-snapshot.law.test.ts.
CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep_all(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u record; v_one jsonb; v_signals int := 0; v_unions int := 0; v_failed int := 0;
  v_suspended int := 0; v_restored int := 0; v_sl jsonb;
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

    -- The open week's rake basis, snapshotted so every reader with an
    -- eight-second budget gets the rows the one function computed within
    -- the hour (Phase 6 verification, 20260908). Never stops the sweep.
    BEGIN
      PERFORM public.fn_union_rake_basis_refresh(u.id, public.fn_union_week_start(now()),
                                                 public.fn_union_week_start(now()) + interval '7 days');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_rake_basis_refresh', 'warning',
              'Refreshing the open-week rake basis snapshot failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
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

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals,
                            'clubs_suspended', v_suspended, 'clubs_restored', v_restored,
                            'window_hours', p_hours, 'ran_at', now());
END $function$
