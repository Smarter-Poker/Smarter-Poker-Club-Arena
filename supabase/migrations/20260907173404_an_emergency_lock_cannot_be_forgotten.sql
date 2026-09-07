-- AN EMERGENCY LOCK CANNOT BE FORGOTTEN
-- =============================================================================
-- PHASE 2 of 8, part 3 of 3.
--
-- A GLOBAL_SETTLEMENT_FREEZE was raised on 2026-08-26 with unlock_at set to
-- 2099-01-01 and sat there for twelve days, silently refusing every weekly
-- settlement. Nothing expired it, nothing aged it, and nothing said a word.
--
-- expire_settlement_locks() has existed the whole time and is called by
-- NOTHING - no function, no cron. Another control that reads as armed and is
-- not wired to anything. It is wired here.
--
-- It would not have helped in that case, because unlock_at was a century out,
-- which is the second half of the problem: a lock with no realistic expiry is a
-- lock nobody will remember. So fn_settlement_lock_hygiene ages them:
--
--   active GLOBAL_SETTLEMENT_FREEZE older than 12 hours   -> critical
--   any active lock whose unlock_at is over 30 days out   -> critical
--   any other active lock older than 7 days               -> warning
--
-- Alerting is idempotent per lock: it will not re-raise while an unresolved
-- alert already names that lock id, so an hourly sweep cannot turn a real
-- signal into 24 rows a day of noise. That matters here - there are already 173
-- unresolved criticals on this platform, and the way a real one gets missed is
-- being buried by a chatty one.
--
-- Both run from the existing hourly union-integrity-sweep. No new pg_cron
-- (World Hub CLAUDE.md 11.3).
--
-- NOTHING FIRES TODAY. The three 2099 rows are already deactivated, and the
-- rules only look at active locks, so history stays history.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_settlement_lock_hygiene()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record;
  v_raised int := 0;
  v_seen   int := 0;
  v_sev    text;
  v_why    text;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR l IN
    SELECT s.id, s.lock_type, s.club_id, s.locked_at, s.unlock_at, s.lock_reason,
           round(EXTRACT(epoch FROM (now() - s.locked_at)) / 3600.0, 1) AS age_hours
      FROM settlement_locks s
     WHERE s.is_active
  LOOP
    v_seen := v_seen + 1;
    v_sev := NULL;

    IF l.lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND l.age_hours > 12 THEN
      v_sev := 'critical';
      v_why := 'A global settlement freeze has been active for ' || l.age_hours
               || ' hours. Every weekly settlement is being refused while it stands.';
    ELSIF l.unlock_at > now() + interval '30 days' THEN
      v_sev := 'critical';
      v_why := 'Lock ' || l.lock_type || ' has unlock_at ' || l.unlock_at::date
               || ', which is more than 30 days out. A lock with no realistic expiry '
               || 'is a lock nobody will remember to lift.';
    ELSIF l.age_hours > 168 THEN
      v_sev := 'warning';
      v_why := 'Lock ' || l.lock_type || ' has been active for ' || l.age_hours || ' hours.';
    END IF;

    IF v_sev IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM financial_alerts a
                        WHERE a.source = 'fn_settlement_lock_hygiene'
                          AND NOT a.resolved
                          AND a.context->>'lock_id' = l.id::text) THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_settlement_lock_hygiene', v_sev,
              v_why || ' Reason given: ' || COALESCE(l.lock_reason, '(none)'),
              jsonb_build_object('lock_id', l.id, 'lock_type', l.lock_type,
                                 'club_id', l.club_id, 'locked_at', l.locked_at,
                                 'unlock_at', l.unlock_at, 'age_hours', l.age_hours));
      v_raised := v_raised + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('active_locks', v_seen, 'alerts_raised', v_raised, 'ran_at', now());
END $function$;

COMMENT ON FUNCTION public.fn_settlement_lock_hygiene() IS
  'Ages active settlement locks and raises one alert per lock: a global freeze over 12h, any lock with unlock_at more than 30 days out, or any other lock over 7 days. Idempotent per lock id. Runs hourly from fn_union_integrity_sweep_all.';

REVOKE ALL ON FUNCTION public.fn_settlement_lock_hygiene() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settlement_lock_hygiene() TO service_role;

DO $migrate$
DECLARE v_def text; v_new text; v_anchor text; v_repl text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;

  v_anchor := E'  -- Close what is due. Never allowed to stop the sweep finishing.';
  v_repl := E'  -- Expire locks whose time has passed. expire_settlement_locks() has\n  -- existed since long before this and was called by nothing at all.\n  BEGIN\n    PERFORM public.expire_settlement_locks();\n    PERFORM public.fn_settlement_lock_hygiene();\n  EXCEPTION WHEN OTHERS THEN\n    INSERT INTO financial_alerts (source, severity, message, context)\n    VALUES (\'fn_settlement_lock_hygiene\', \'warning\',\n            \'Settlement lock hygiene failed\',\n            jsonb_build_object(\'error\', SQLERRM));\n  END;\n\n  -- Close what is due. Never allowed to stop the sweep finishing.';

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'the close-due anchor was not found in the sweep';
  END IF;
  v_new := replace(v_def, v_anchor, v_repl);
  IF v_new = v_def THEN RAISE EXCEPTION 'lock hygiene wiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE v_src text; v_res jsonb;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;

  IF v_src NOT LIKE '%expire_settlement_locks%' THEN
    RAISE EXCEPTION 'expire_settlement_locks is still orphaned';
  END IF;
  IF v_src NOT LIKE '%fn_settlement_lock_hygiene%' THEN
    RAISE EXCEPTION 'the sweep does not run lock hygiene';
  END IF;
  IF v_src NOT LIKE '%fn_close_due_settlement_periods%'
     OR v_src NOT LIKE '%fn_union_enforce_stop_loss%'
     OR v_src NOT LIKE '%fn_union_integrity_sweep(%' THEN
    RAISE EXCEPTION 'the sweep lost one of its existing jobs';
  END IF;

  v_res := public.fn_settlement_lock_hygiene();
  IF (v_res->>'active_locks')::int <> 0 OR (v_res->>'alerts_raised')::int <> 0 THEN
    RAISE EXCEPTION 'lock hygiene alerted on inactive history: %', v_res::text;
  END IF;
END
$assert$;

DO $lock_test$
DECLARE
  v_id uuid; v_res jsonb; v_msg text; v_sev text;
BEGIN
  BEGIN
    INSERT INTO settlement_locks (club_id, lock_type, locked_at, unlock_at, is_active, lock_reason)
    VALUES ('a0000000-0000-0000-0000-000000000001'::uuid, 'GLOBAL_SETTLEMENT_FREEZE',
            now() - interval '20 hours', '2099-01-01 00:00:00+00', true,
            'fixture: a freeze nobody lifted')
    RETURNING id INTO v_id;

    v_res := public.fn_settlement_lock_hygiene();
    IF (v_res->>'alerts_raised')::int <> 1 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL a 20-hour-old active freeze did not alert: %', v_res::text;
    END IF;

    SELECT severity INTO v_sev FROM financial_alerts
     WHERE source='fn_settlement_lock_hygiene' AND context->>'lock_id' = v_id::text;
    IF v_sev <> 'critical' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL a stale global freeze was not critical, got %', COALESCE(v_sev,'(none)');
    END IF;

    v_res := public.fn_settlement_lock_hygiene();
    IF (v_res->>'alerts_raised')::int <> 0 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL lock hygiene re-alerted on the same lock: %', v_res::text;
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'FIXTURE_ROLLBACK' THEN
      RAISE EXCEPTION 'lock hygiene test failed: %', v_msg;
    END IF;
  END;
END
$lock_test$;

COMMIT;
