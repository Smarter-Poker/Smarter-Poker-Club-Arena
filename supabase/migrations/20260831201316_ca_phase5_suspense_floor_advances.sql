-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831201316; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ZERO-DRIFT phase 5: the suspense-regression watchdog's floor advances to
-- 2026-08-31 20:10 UTC — the moment the opening-bank path (the one uncovered
-- producer, root-caused and fixed) stopped writing suspense. The two 19:53
-- rows are explained and resolved; without moving the floor the hourly
-- window would keep re-raising the same explained flow until it aged out.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_suspense_regression_check()'::regprocedure);
  v_new := replace(v_def, '2026-08-31 19:01:00+00', '2026-08-31 20:10:00+00');
  IF v_new <> v_def THEN EXECUTE v_new; END IF;
END $$;

SELECT public.fn_ca_incident_action(i.id, 'resolve',
  'Same root cause as the prior suspense-regression incident: the two 19:53 opening-bank rows (fixed at 20:09, ca_phase5_opening_bank_is_a_mint). Watchdog floor advanced past the fix so explained flow stops re-raising.',
  NULL, 'opening-bank rows, already fixed; watchdog floor advanced', NULL) AS r
FROM public.ca_drift_incidents i
WHERE i.source='fn_ca_suspense_regression_check' AND i.status<>'resolved';
