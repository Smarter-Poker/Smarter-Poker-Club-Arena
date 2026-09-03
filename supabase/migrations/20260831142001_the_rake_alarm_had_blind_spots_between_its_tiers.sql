CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb),
    (SELECT LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
       FROM public.ca_rake_tier t
      WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
      ORDER BY t.max_bb ASC NULLS LAST
      LIMIT 1)
  );
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY[0.07, 0.25, 0.9, 3.2, 8.5, 40.5, 0.011]::numeric[]) AS bb
  LOOP
    IF public.fn_effective_rake_cap(r.bb / 2, r.bb) IS NULL THEN
      RAISE EXCEPTION 'big blind % still resolves to no cap', r.bb;
    END IF;
  END LOOP;

  IF public.fn_effective_rake_cap(1, 2) IS DISTINCT FROM 5.0 THEN
    RAISE EXCEPTION '1/2 moved: %', public.fn_effective_rake_cap(1, 2);
  END IF;
  IF public.fn_effective_rake_cap(25, 50) IS DISTINCT FROM 20.00 THEN
    RAISE EXCEPTION '25/50 moved: %', public.fn_effective_rake_cap(25, 50);
  END IF;
  IF public.fn_effective_rake_cap(0.05, 0.10) IS DISTINCT FROM 1.50 THEN
    RAISE EXCEPTION '0.05/0.10 moved: %', public.fn_effective_rake_cap(0.05, 0.10);
  END IF;
  IF public.fn_effective_rake_cap(0.03, 0.07) IS DISTINCT FROM 1.05 THEN
    RAISE EXCEPTION 'unscheduled 0.03/0.07 should cap at 1.05, got %',
      public.fn_effective_rake_cap(0.03, 0.07);
  END IF;
END $$;