INSERT INTO public.ca_rake_schedule (sb, bb, rake_percent, rake_cap, bbj_fee_bb) VALUES
  (0.01, 0.02, 10,  0.30, 0.6),
  (0.02, 0.05, 10,  0.75, 0.6),
  (0.05, 0.10, 10,  1.50, 0.6),
  (0.10, 0.25, 10,  3.00, 0.6),
  (25,   50,   10, 20.00, 0.03),
  (50,  100,   10, 20.00, 0.03)
ON CONFLICT (sb, bb) DO UPDATE
  SET rake_percent = EXCLUDED.rake_percent,
      rake_cap     = EXCLUDED.rake_cap,
      bbj_fee_bb   = EXCLUDED.bbj_fee_bb;

CREATE OR REPLACE FUNCTION public.fn_unscheduled_cap_bb()
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(max(s.rake_cap / s.bb), 0)
    FROM public.ca_rake_schedule s
   WHERE s.bb > 0;
$$;

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
      WHERE p_bb >= t.min_bb AND (t.max_bb IS NULL OR p_bb <= t.max_bb)
      ORDER BY t.min_bb DESC LIMIT 1)
  );
$$;

DO $$
DECLARE
  v_rows integer; v_bound numeric; v_default numeric; v_2550 numeric; v_odd numeric;
BEGIN
  SELECT count(*) INTO v_rows FROM public.ca_rake_schedule;
  IF v_rows <> 20 THEN
    RAISE EXCEPTION 'expected 20 schedule rows after the insert, found %', v_rows;
  END IF;
  v_bound := public.fn_unscheduled_cap_bb();
  IF v_bound <> 15 THEN
    RAISE EXCEPTION 'the derived proportion should be 15 BB, got %', v_bound;
  END IF;
  v_default := public.fn_effective_rake_cap(0.05, 0.10);
  IF v_default <> 1.50 THEN
    RAISE EXCEPTION '0.05/0.10 should cap at 1.50, got %', v_default;
  END IF;
  v_2550 := public.fn_effective_rake_cap(25, 50);
  IF v_2550 <> 20 THEN
    RAISE EXCEPTION '25/50 should still cap at 20, got %', v_2550;
  END IF;
  v_odd := public.fn_effective_rake_cap(0.03, 0.07);
  IF v_odd <> 1.05 THEN
    RAISE EXCEPTION 'unscheduled 0.03/0.07 should cap at 1.05, got %', v_odd;
  END IF;
END $$;