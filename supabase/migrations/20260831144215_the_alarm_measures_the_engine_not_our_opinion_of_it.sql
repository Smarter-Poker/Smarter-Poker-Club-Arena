-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831144215; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.ca_rake_schedule
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'engine_mirror';

ALTER TABLE public.ca_rake_schedule
  DROP CONSTRAINT IF EXISTS ca_rake_schedule_source_check;
ALTER TABLE public.ca_rake_schedule
  ADD CONSTRAINT ca_rake_schedule_source_check
  CHECK (source IN ('engine_mirror', 'proposed'));

UPDATE public.ca_rake_schedule
   SET source = 'proposed'
 WHERE (sb, bb) IN ((0.01,0.02), (0.02,0.05), (0.05,0.10), (0.10,0.25), (25,50), (50,100));

COMMENT ON COLUMN public.ca_rake_schedule.source IS
  'engine_mirror: this row exists in RAKE_SCHEDULE in src/config/RakeConfig.ts and is what the engine charges. proposed: a stake somebody thinks SHOULD be scheduled; never used to resolve a cap, only reported by fn_rake_schedule_drift().';

CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb AND s.source = 'engine_mirror'),
    (SELECT t.rake_cap FROM public.ca_rake_tier t
      WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
      ORDER BY t.max_bb ASC NULLS LAST
      LIMIT 1)
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_rake_schedule_drift()
RETURNS TABLE (
  small_blind    numeric,
  big_blind      numeric,
  charged_cap    numeric,
  proposed_cap   numeric,
  charged_cap_bb numeric,
  hands_48h      bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT p.sb, p.bb,
         public.fn_effective_rake_cap(p.sb, p.bb),
         p.rake_cap,
         round(public.fn_effective_rake_cap(p.sb, p.bb) / NULLIF(p.bb, 0), 2),
         (SELECT count(*) FROM public.hand_history h
            JOIN public.tables t ON t.id = h.table_id
           WHERE t.tournament_id IS NULL
             AND t.small_blind = p.sb AND t.big_blind = p.bb
             AND h.created_at > now() - interval '48 hours'
             AND COALESCE(h.rake_amount, 0) > 0)
    FROM public.ca_rake_schedule p
   WHERE p.source = 'proposed'
     AND public.fn_effective_rake_cap(p.sb, p.bb) IS DISTINCT FROM p.rake_cap
   ORDER BY p.bb;
$$;

REVOKE ALL ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_schedule_drift()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_unscheduled_cap_bb()                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_schedule_drift()                TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_unscheduled_cap_bb()                 TO service_role;

DO $$
DECLARE
  r        record;
  v_actual numeric;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (0.1::numeric, 0.2::numeric,  3.0::numeric),
      (0.2,  0.4,  3.0),  (0.25, 0.5,  3.0),  (0.3,  0.6,  5.0),
      (0.5,  1.0,  5.0),  (1,    2,    5.0),  (2,    4,    7.5),
      (2,    5,    7.5),  (5,    5,    7.5),  (3,    6,    8.0),
      (4,    8,   10.0),  (5,   10,   12.5),  (10,  20,   15.0),
      (10,  25,   15.0),
      (0.05, 0.10, 3.0),
      (0.10, 0.25, 3.0),
      (0.45, 0.9,  5.0),
      (1.6,  3.2,  8.0),
      (4.25, 8.5, 15.0),
      (25,  50,   20.0),
      (50, 100,   20.0)
    ) AS t(sb, bb, engine_cap)
  LOOP
    v_actual := public.fn_effective_rake_cap(r.sb, r.bb);
    IF v_actual IS DISTINCT FROM r.engine_cap THEN
      RAISE EXCEPTION 'stake %/%: the engine charges % but this function says %',
        r.sb, r.bb, r.engine_cap, v_actual;
    END IF;
  END LOOP;

  FOR r IN SELECT unnest(ARRAY[0.011, 0.07, 0.25, 0.9, 3.2, 8.5, 40.5, 1000]::numeric[]) AS bb
  LOOP
    IF public.fn_effective_rake_cap(r.bb / 2, r.bb) IS NULL THEN
      RAISE EXCEPTION 'big blind % resolves to no cap at all', r.bb;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.fn_rake_law_violations('2 hours'::interval)
              WHERE kind IN ('over_cap', 'over_percent')) THEN
    RAISE EXCEPTION 'the corrected cap still reports an over-cap hand in the cron window';
  END IF;
END $$;
