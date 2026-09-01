-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827060121; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE RAKE COLUMNS STOP LYING
-- ═══════════════════════════════════════════════════════════════════════════
-- The `clubs` table carries TWO pairs of rake columns:
--
--     default_rake_percent / rake_cap        <- the engine reads THESE
--     rake_percent         / rake_cap_bb     <- legacy duplicate, read by NOTHING
--
-- Right now, on all three clubs:
--     default_rake_percent = -1.00   (sentinel: "inherit")
--     rake_cap             = -1.00   (sentinel: "inherit")
--     rake_percent         =  5.00   <- looks authoritative, is not
--     rake_cap_bb          =  3.00   <- looks authoritative, is not
--
-- So every table says "inherit from club", every club says "inherit from the
-- schedule", and the chain falls through to server/src/config/RakeConfig.ts,
-- where RAKE_SCHEDULE is 10% at every stake. Players are raked 10% while two
-- columns sitting in the clubs table read 5%.
--
-- That is not a bug in the engine -- the -1 sentinel is correctly implemented
-- on both sides (RakeConfig.ts isRakeSet, ServerTableEngineBase pick) and the
-- 10% is the documented schedule default. It is a TRAP for whoever reads the
-- database next. It caught this audit: the first pass measured live rake
-- against clubs.rake_percent, found 4,350 hands "over the limit", and was
-- wrong.
--
-- No value is changed here. Whether the platform should take 10% or 5% is a
-- commercial decision, and silently rewriting a rake number is not a thing an
-- audit gets to do. What changes is that the columns now say what they are,
-- and there is one function that answers "what rake will actually be taken"
-- without anyone having to know which of the four columns is real.
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN public.clubs.default_rake_percent IS
  'AUTHORITATIVE. The engine reads this (ServerTableEngineBase.refreshRakeConfig). -1 or NULL means inherit from the RAKE_SCHEDULE in server/src/config/RakeConfig.ts, which is 10% at every stake. The club settings UI writes this column.';

COMMENT ON COLUMN public.clubs.rake_cap IS
  'AUTHORITATIVE. The engine reads this as a cap in BIG BLINDS despite the name. -1 or NULL means inherit from the schedule cap.';

COMMENT ON COLUMN public.clubs.rake_percent IS
  'LEGACY DUPLICATE - NOTHING READS THIS. The engine reads clubs.default_rake_percent. A value here has no effect on rake taken and will mislead anyone auditing the database (it misled the 2026-08-27 rake audit). Do not write it; prefer default_rake_percent.';

COMMENT ON COLUMN public.clubs.rake_cap_bb IS
  'LEGACY DUPLICATE - NOTHING READS THIS. The engine reads clubs.rake_cap. Do not write it.';

COMMENT ON COLUMN public.tables.rake_percent IS
  'Per-table override. -1 (RAKE_INHERIT) or NULL means inherit from clubs.default_rake_percent, then from the schedule. An override can only LOWER the schedule rate (RakeConfig.ts applies Math.min).';

COMMENT ON COLUMN public.tables.rake_cap_bb IS
  'Per-table cap override in BIG BLINDS. -1 or NULL means inherit from clubs.rake_cap, then the schedule cap.';

-- One place to ask what will actually be taken, so nobody has to know which of
-- the four columns is real.
CREATE OR REPLACE FUNCTION public.fn_effective_rake_config(p_table_id uuid)
RETURNS TABLE (
  table_id           uuid,
  club_name          text,
  source             text,
  effective_percent  numeric,
  effective_cap_bb   numeric,
  note               text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id,
         c.name,
         CASE
           WHEN t.rake_percent IS NOT NULL AND t.rake_percent >= 0 THEN 'table override'
           WHEN c.default_rake_percent IS NOT NULL AND c.default_rake_percent >= 0 THEN 'club default'
           ELSE 'engine schedule (RakeConfig.ts)'
         END,
         CASE
           WHEN t.rake_percent IS NOT NULL AND t.rake_percent >= 0 THEN t.rake_percent
           WHEN c.default_rake_percent IS NOT NULL AND c.default_rake_percent >= 0 THEN c.default_rake_percent
           ELSE 10::numeric   -- RAKE_SCHEDULE is 10% at every stake
         END,
         CASE
           WHEN t.rake_cap_bb IS NOT NULL AND t.rake_cap_bb >= 0 THEN t.rake_cap_bb
           WHEN c.rake_cap IS NOT NULL AND c.rake_cap >= 0 THEN c.rake_cap
           ELSE NULL          -- schedule cap is per-stake, in dollars, not BB
         END,
         CASE
           WHEN (t.rake_percent IS NULL OR t.rake_percent < 0)
            AND (c.default_rake_percent IS NULL OR c.default_rake_percent < 0)
           THEN 'Falling through to the hardcoded 10% schedule. clubs.rake_percent='
                || coalesce(c.rake_percent::text,'null')
                || ' is a LEGACY column and is NOT what is being charged.'
           ELSE 'Configured.'
         END
  FROM public.tables t
  LEFT JOIN public.clubs c ON c.id = t.club_id
  WHERE t.id = p_table_id;
$$;

COMMENT ON FUNCTION public.fn_effective_rake_config(uuid) IS
  'What rake will ACTUALLY be taken at this table, and where the number came from. Added 2026-08-27 because the clubs table carries two rake column pairs and only one is read.';

REVOKE ALL ON FUNCTION public.fn_effective_rake_config(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake_config(uuid) TO service_role, authenticated;

DO $$
DECLARE v_pct numeric; v_src text;
BEGIN
  SELECT effective_percent, source INTO v_pct, v_src
  FROM public.fn_effective_rake_config((SELECT id FROM public.tables LIMIT 1));
  IF v_pct IS NULL THEN RAISE EXCEPTION 'effective rake could not be resolved'; END IF;
  RAISE NOTICE 'effective rake resolves: %%% from %', v_pct, v_src;
END $$;
