-- 20261003235228_the_union_sweep_refreshes_the_windowed_snapshot_again.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE UNION SWEEP REFRESHES THE WINDOWED SNAPSHOT AGAIN (phase 7 of 9).
-- Full account:
-- docs/changelog/2026-10-03-the-union-sweep-refreshes-the-windowed-snapshot-again.md.
--
-- Two fixes to the same hourly cost landed thirty minutes apart on
-- 2026-10-03. 20261003225101 (applied 23:05 UTC) took the open-week rake basis
-- rebuild out of fn_union_integrity_sweep_all, because the one-read rebuild
-- no longer finished inside job 123's 300 s and was cancelled every hour.
-- 20261003224956 (the accounting coordinator, merged 23:36) made that rebuild
-- incremental instead: fn_union_rake_basis_refresh now proves two-hour windows
-- (fn_union_rake_basis_windowed), keeps the closed ones, starts no closed
-- window 120 s and no tail window 180 s into the statement, and after warming
-- proves one new window and the open tail an hour. With the sweep no longer
-- calling it, that work never runs and the snapshot it was built for stays at
-- 2026-09-28.
--
-- This restores the sweep's live text of before 20261003225101, byte for byte
-- (md5 729a5617801d0038b1fa3c10f488c0bb): the money controls first, then the
-- refresh in its own subtransaction that traps query_canceled and stops for
-- the hour. It refuses to apply unless the refresh in force is the windowed
-- one, so the one-read rebuild can never be put back by this file.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) = '729a5617801d0038b1fa3c10f488c0bb')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) IS DISTINCT FROM '6000297c65bca53935705fbd6b8fd5d8' THEN
    RAISE EXCEPTION 'UNION_SWEEP_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_integrity_sweep_all(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SWEEP_AUTHORITY_CHANGED';
  END IF;
  IF position('fn_union_rake_basis_windowed' IN pg_get_functiondef('public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'THE_REFRESH_IS_NOT_WINDOWED_YET: apply 20261003224956 first';
  END IF;
END
$pre$;

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

REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep_all(integer) TO service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) IS DISTINCT FROM '729a5617801d0038b1fa3c10f488c0bb'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_integrity_sweep_all(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SWEEP_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
