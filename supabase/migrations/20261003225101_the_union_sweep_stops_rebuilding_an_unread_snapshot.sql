-- 20261003225101_the_union_sweep_stops_rebuilding_an_unread_snapshot.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE UNION SWEEP STOPS REBUILDING AN UNREAD SNAPSHOT (phase 7 of 9:
-- availability). Full account:
-- docs/changelog/2026-10-03-the-union-sweep-stops-rebuilding-an-unread-snapshot.md.
--
-- pg_cron union-integrity-sweep (35 * * * *) runs fn_union_integrity_sweep_all
-- under a 300 s statement_timeout. After the money controls (integrity sweep,
-- invoice ageing, stop-loss, lock hygiene, period closes) it rebuilt
-- union_rake_basis_snapshot for the open week. That rebuild is linear in the
-- week: 6.5 s on 2026-09-14, 74 s on 2026-09-28, and from 2026-09-29 it no
-- longer finished. Every run since lasts exactly 300 s (cron.job_run_details,
-- 09:35-22:35 UTC 2026-10-03): the rebuild is cancelled, its handler keeps the
-- 2026-09-28 21:35 snapshot, and about 250 s of a backend an hour is spent
-- for nothing. No function, view, job or client reads union_rake_basis_snapshot.
--
-- This removes the rebuild loop from the sweep and nothing else: the money
-- controls, their order and their handlers are the live text. The sweep's
-- answer keeps its rake_basis key (zeros, retired: true). The refresh
-- function, its table and its rows stay; a person can still call it.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) = '6000297c65bca53935705fbd6b8fd5d8')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) IS DISTINCT FROM '729a5617801d0038b1fa3c10f488c0bb' THEN
    RAISE EXCEPTION 'UNION_SWEEP_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_integrity_sweep_all(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SWEEP_AUTHORITY_CHANGED';
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

  /* THE SWEEP NO LONGER REBUILDS THE OPEN-WEEK SNAPSHOT (2026-10-03). The
     refresh of union_rake_basis_snapshot that ran here recomputed the whole
     open week every hour. By 2026-09-29 it no longer finished inside the
     job's 300 s, so every hour since spent the rest of the job's time on it,
     was cancelled, and kept the snapshot of 2026-09-28 21:35: about 250 s of
     database time an hour for a table nothing reads (no function, view, job
     or client selects from it). The money controls above are unchanged.
     fn_union_rake_basis_refresh remains for a person to call on demand. */

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals,
                            'clubs_suspended', v_suspended, 'clubs_restored', v_restored,
                            'rake_basis', jsonb_build_object('refreshed', 0, 'skipped', 0,
                                                             'failed', 0, 'out_of_time', false,
                                                             'retired', true),
                            'window_hours', p_hours, 'ran_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep_all(integer) TO service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) IS DISTINCT FROM '6000297c65bca53935705fbd6b8fd5d8'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_integrity_sweep_all(integer)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SWEEP_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
