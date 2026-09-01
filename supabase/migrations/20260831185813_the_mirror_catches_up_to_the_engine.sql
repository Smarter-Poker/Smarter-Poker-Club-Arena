-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831185813; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

UPDATE public.ca_rake_schedule
   SET source = 'engine_mirror'
 WHERE source = 'proposed';

CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb AND s.source = 'engine_mirror'),
    (SELECT LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
       FROM public.ca_rake_tier t
      WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
      ORDER BY t.max_bb ASC NULLS LAST
      LIMIT 1)
  );
$$;

DO $$
DECLARE
  v_proposed int;
  v_bound numeric;
BEGIN
  SELECT count(*) INTO v_proposed FROM public.ca_rake_schedule WHERE source <> 'engine_mirror';
  IF v_proposed <> 0 THEN
    RAISE EXCEPTION '% row(s) still parked outside engine_mirror', v_proposed;
  END IF;

  v_bound := public.fn_unscheduled_cap_bb();
  IF v_bound IS DISTINCT FROM 15 THEN
    RAISE EXCEPTION 'derived ratio should be 15 BB, got %', v_bound;
  END IF;

  IF public.fn_effective_rake_cap(0.05, 0.10) IS DISTINCT FROM 1.50 THEN
    RAISE EXCEPTION '0.05/0.10 should now cap at 1.50, got %',
      public.fn_effective_rake_cap(0.05, 0.10);
  END IF;

  IF public.fn_effective_rake_cap(1, 2) IS DISTINCT FROM 5.0 THEN
    RAISE EXCEPTION '1/2 moved: %', public.fn_effective_rake_cap(1, 2);
  END IF;
  IF public.fn_effective_rake_cap(2, 5) IS DISTINCT FROM 7.5 THEN
    RAISE EXCEPTION '2/5 moved: %', public.fn_effective_rake_cap(2, 5);
  END IF;
  IF public.fn_effective_rake_cap(25, 50) IS DISTINCT FROM 20.00 THEN
    RAISE EXCEPTION '25/50 moved: %', public.fn_effective_rake_cap(25, 50);
  END IF;

  IF public.fn_effective_rake_cap(0.03, 0.07) IS DISTINCT FROM 1.05 THEN
    RAISE EXCEPTION 'unscheduled 0.03/0.07 should cap at 1.05, got %',
      public.fn_effective_rake_cap(0.03, 0.07);
  END IF;
  IF public.fn_effective_rake_cap(0.45, 0.9) IS NULL THEN
    RAISE EXCEPTION 'a stake in the old nano/micro gap resolves to no cap again';
  END IF;
END $$;
