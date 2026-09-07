-- A CLOSED PERIOD IS CLOSED
-- =============================================================================
-- PHASE 2 of 8, part 2 of 3.
--
-- settlement_periods.status allowed open / processing / settled / disputed.
-- There was no CLOSED state, so "settled" was never final: any writer could
-- restate a settled period's figures afterwards and nothing would object. The
-- oldest non-settled period on this platform is 2026-08-10, stuck in
-- 'processing' for four weeks, because nothing advances a period either.
--
-- 1. NOTHING EVER ADVANCED A PERIOD. Only fn_union_issue_weekly_invoices
--    created period rows, as a side effect of invoicing, with status
--    'processing'. Since round 4 is currently gated off, a completed settlement
--    now creates no period record at all. A period is an accounting object, not
--    an artefact of a statement, so the CASCADE owns it:
--    fn_union_mark_period_settled writes one row per member club and marks it
--    settled once the money rounds and the conservation assertion have passed.
--
-- 2. THERE WAS NO CLOSE. fn_close_due_settlement_periods moves a settled period
--    to 'closed' once it is past end_at plus the same three-day grace the
--    invoice uses for due_at, and never touches a disputed one. It runs from
--    the existing hourly union-integrity-sweep (World Hub CLAUDE.md 11.3).
--
-- 3. CLOSED MEANT NOTHING. zz_closed_period_is_immutable refuses any change to
--    a closed period's dates, club, union, settled_at, status or totals, and
--    refuses to delete one. Notes stay editable, because annotating history is
--    not rewriting it. A platform admin can still reopen deliberately - the
--    guard blocks automation, not people - which keeps CLAUDE.md 10.9's "correct
--    it forward, never edit history quiet" enforceable rather than aspirational.
--
-- A unique index on (club_id, union_id, start_at, end_at) comes with this,
-- because "two period rows for the same club and window" is a corruption we had
-- no constraint against, and the upsert needs a conflict target.
--
-- EXPECTED DATA EFFECT, and it happened: the first close run sealed the three
-- long-settled periods that already existed (SHARK 2026-04-20, and the two
-- 2026-08-20 rows). The two 2026-08-10 rows stayed 'processing' and the
-- 2026-03-04 row stayed 'disputed'; neither was touched.
-- =============================================================================

BEGIN;

DO $precheck$
DECLARE v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT club_id, union_id, start_at, end_at
      FROM settlement_periods
     GROUP BY 1,2,3,4 HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'settlement_periods already holds % duplicate (club, union, window) group(s)', v_dupes;
  END IF;
END
$precheck$;

ALTER TABLE public.settlement_periods
  DROP CONSTRAINT IF EXISTS settlement_periods_status_check;
ALTER TABLE public.settlement_periods
  ADD CONSTRAINT settlement_periods_status_check
  CHECK (status = ANY (ARRAY['open'::text, 'processing'::text, 'settled'::text, 'disputed'::text, 'closed'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS settlement_periods_club_union_window_uidx
  ON public.settlement_periods (club_id, union_id, start_at, end_at);

CREATE OR REPLACE FUNCTION public.fn_union_mark_period_settled(
  p_union_id uuid,
  p_from     timestamp with time zone,
  p_to       timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows int := 0;
BEGIN
  INSERT INTO settlement_periods (club_id, union_id, period_number, year,
                                  start_at, end_at, status, settled_at)
  SELECT uc.club_id, p_union_id,
         EXTRACT(week FROM p_from)::int, EXTRACT(isoyear FROM p_from)::int,
         p_from, p_to, 'settled', now()
    FROM union_clubs uc
   WHERE uc.union_id = p_union_id
  ON CONFLICT (club_id, union_id, start_at, end_at) DO UPDATE
     SET status     = CASE WHEN settlement_periods.status IN ('closed','disputed')
                           THEN settlement_periods.status ELSE 'settled' END,
         settled_at = COALESCE(settlement_periods.settled_at, now()),
         updated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('periods_marked_settled', v_rows,
                            'period_start', p_from, 'period_end', p_to);
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_mark_period_settled(uuid, timestamp with time zone, timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_mark_period_settled(uuid, timestamp with time zone, timestamp with time zone)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_close_due_settlement_periods(p_grace_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_closed int := 0;
  v_ids uuid[];
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  WITH due AS (
    UPDATE settlement_periods sp
       SET status = 'closed', updated_at = now()
     WHERE sp.status = 'settled'
       AND sp.end_at + make_interval(days => p_grace_days) < now()
     RETURNING sp.id
  )
  SELECT array_agg(id), count(*) INTO v_ids, v_closed FROM due;

  RETURN jsonb_build_object('periods_closed', COALESCE(v_closed, 0),
                            'grace_days', p_grace_days,
                            'closed_ids', COALESCE(to_jsonb(v_ids), '[]'::jsonb),
                            'ran_at', now());
END $function$;

COMMENT ON FUNCTION public.fn_close_due_settlement_periods(integer) IS
  'Moves a settled settlement period to closed once it is past end_at plus the grace period. Never touches a disputed period. Runs hourly from fn_union_integrity_sweep_all.';

REVOKE ALL ON FUNCTION public.fn_close_due_settlement_periods(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_due_settlement_periods(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.zz_closed_period_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'closed' AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
      RAISE EXCEPTION 'PERIOD_CLOSED: settlement period % is closed and cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'closed' AND NOT COALESCE(public.fn_is_platform_admin(), false) THEN
    IF NEW.status                 IS DISTINCT FROM OLD.status
       OR NEW.club_id             IS DISTINCT FROM OLD.club_id
       OR NEW.union_id            IS DISTINCT FROM OLD.union_id
       OR NEW.start_at            IS DISTINCT FROM OLD.start_at
       OR NEW.end_at              IS DISTINCT FROM OLD.end_at
       OR NEW.settled_at          IS DISTINCT FROM OLD.settled_at
       OR NEW.total_rake_collected     IS DISTINCT FROM OLD.total_rake_collected
       OR NEW.total_commissions_paid   IS DISTINCT FROM OLD.total_commissions_paid
       OR NEW.total_player_winnings    IS DISTINCT FROM OLD.total_player_winnings
       OR NEW.total_player_losses      IS DISTINCT FROM OLD.total_player_losses
       OR NEW.total_bbj_contributions  IS DISTINCT FROM OLD.total_bbj_contributions
    THEN
      RAISE EXCEPTION
        'PERIOD_CLOSED: settlement period % is closed. Correct it forward with an adjusting entry; do not edit a closed period.',
        OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS zz_closed_period_is_immutable ON public.settlement_periods;
CREATE TRIGGER zz_closed_period_is_immutable
  BEFORE UPDATE OR DELETE ON public.settlement_periods
  FOR EACH ROW EXECUTE FUNCTION public.zz_closed_period_is_immutable();

DO $migrate$
DECLARE v_def text; v_new text; v_anchor text; v_repl text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;

  v_anchor := E'  IF public.fn_union_eco_enabled(p_union_id) THEN';
  v_repl := E'  -- The period is an accounting object, not a by-product of invoicing.\n  PERFORM public.fn_union_mark_period_settled(p_union_id, v_from, v_to);\n\n  IF public.fn_union_eco_enabled(p_union_id) THEN';

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'the ECO anchor was not found in the cascade';
  END IF;
  v_new := replace(v_def, v_anchor, v_repl);
  IF v_new = v_def THEN RAISE EXCEPTION 'period wiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

DO $migrate2$
DECLARE v_def text; v_new text; v_anchor text; v_repl text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;

  v_anchor := E'  RETURN jsonb_build_object(\'unions_swept\', v_unions,';
  v_repl := E'  -- Close what is due. Never allowed to stop the sweep finishing.\n  BEGIN\n    PERFORM public.fn_close_due_settlement_periods();\n  EXCEPTION WHEN OTHERS THEN\n    INSERT INTO financial_alerts (source, severity, message, context)\n    VALUES (\'fn_close_due_settlement_periods\', \'warning\',\n            \'Closing due settlement periods failed\',\n            jsonb_build_object(\'error\', SQLERRM));\n  END;\n\n  RETURN jsonb_build_object(\'unions_swept\', v_unions,';

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'the sweep return anchor was not found';
  END IF;
  v_new := replace(v_def, v_anchor, v_repl);
  IF v_new = v_def THEN RAISE EXCEPTION 'sweep wiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate2$;

DO $assert$
DECLARE v_src text; v_res jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.settlement_periods'::regclass
                    AND conname='settlement_periods_status_check'
                    AND pg_get_constraintdef(oid) LIKE '%closed%') THEN
    RAISE EXCEPTION 'closed is not an allowed status';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_mark_period_settled%' THEN
    RAISE EXCEPTION 'the cascade does not mark the period settled';
  END IF;
  IF v_src NOT LIKE '%fn_union_settlement_conservation_assert%' THEN
    RAISE EXCEPTION 'the conservation assertion was lost';
  END IF;
  IF v_src NOT LIKE '%before_settlement_floor%' OR v_src NOT LIKE '%round1_failed%' THEN
    RAISE EXCEPTION 'the floor or round-1 guard was lost';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_close_due_settlement_periods%' THEN
    RAISE EXCEPTION 'the hourly sweep does not close due periods';
  END IF;
  IF v_src NOT LIKE '%fn_union_enforce_stop_loss%' THEN
    RAISE EXCEPTION 'the sweep lost stop-loss enforcement';
  END IF;

  v_res := public.fn_close_due_settlement_periods(3);
  IF (v_res->>'periods_closed') IS NULL THEN
    RAISE EXCEPTION 'the close function did not report a count: %', v_res::text;
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_periods
              WHERE status='closed' AND end_at + interval '3 days' >= now()) THEN
    RAISE EXCEPTION 'a period inside its grace window was closed';
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_periods WHERE status='disputed'
              AND id::text IN (SELECT jsonb_array_elements_text(v_res->'closed_ids'))) THEN
    RAISE EXCEPTION 'a disputed period was closed';
  END IF;
END
$assert$;

-- The trigger is exercised on a throwaway row inside its OWN subtransaction, so
-- the fixture is rolled back without taking the migration with it.
DO $trigger_test$
DECLARE v_id uuid; v_raised boolean; v_msg text;
BEGIN
  BEGIN
    INSERT INTO settlement_periods (club_id, union_id, period_number, year, start_at, end_at, status)
    VALUES (NULL, NULL, 1, 1999, '1999-01-04 00:00:00+00', '1999-01-11 00:00:00+00', 'settled')
    RETURNING id INTO v_id;

    UPDATE settlement_periods SET status='closed' WHERE id = v_id;

    v_raised := false;
    BEGIN
      UPDATE settlement_periods SET total_rake_collected = 123.45 WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'PERIOD_CLOSED%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL a closed period accepted a change to its totals'; END IF;

    v_raised := false;
    BEGIN
      DELETE FROM settlement_periods WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      v_raised := v_msg LIKE 'PERIOD_CLOSED%';
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FIXTURE_FAIL a closed period was deleted'; END IF;

    UPDATE settlement_periods SET notes = 'annotation is allowed' WHERE id = v_id;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'FIXTURE_ROLLBACK' THEN
      RAISE EXCEPTION 'closed-period trigger test failed: %', v_msg;
    END IF;
  END;
END
$trigger_test$;

COMMIT;
