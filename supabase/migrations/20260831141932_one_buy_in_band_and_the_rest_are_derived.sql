-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831141932; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ONE BUY-IN BAND. THE REST ARE DERIVED. (Phase 2 of the live cash audit)
-- Applied 2026-08-31 by the Spins audit; see the repo file for the full
-- rationale. The file was merged to main but never reached the database, while
-- its companion code change (TableConfigPage no longer writing the derived
-- columns) was live - so the next cash table created would have been stamped
-- with the 2/25 DEFAULT and nothing left to correct it.
-- Pre-flight: 16 running cash tables, none with a zero/null blind or null band,
-- all deriving to exactly (40, 200), so both assertions below hold.
-- lock_timeout stays at the author's 4s, deliberately.

SET LOCAL lock_timeout = '4s';

ALTER TABLE public.tables
  DROP COLUMN min_buy_in_bb,
  DROP COLUMN max_buy_in_bb,
  DROP COLUMN min_buyin,
  DROP COLUMN max_buyin,
  ADD COLUMN min_buy_in_bb integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND min_buy_in IS NOT NULL
         THEN ceil(min_buy_in / big_blind)::integer
    END) STORED,
  ADD COLUMN max_buy_in_bb integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND max_buy_in IS NOT NULL
         THEN floor(max_buy_in / big_blind)::integer
    END) STORED,
  ADD COLUMN min_buyin integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND min_buy_in IS NOT NULL
         THEN ceil(min_buy_in / big_blind)::integer
    END) STORED,
  ADD COLUMN max_buyin integer GENERATED ALWAYS AS (
    CASE WHEN tournament_id IS NULL
          AND COALESCE(big_blind, 0) > 0
          AND max_buy_in IS NOT NULL
         THEN floor(max_buy_in / big_blind)::integer
    END) STORED;

COMMENT ON COLUMN public.tables.min_buy_in IS
  'CANONICAL. Smallest stack this table sells, in CHIPS. Enforced by atomic_table_buyin and read by the engine; every other buy-in column on this table is derived from this one.';
COMMENT ON COLUMN public.tables.max_buy_in IS
  'CANONICAL. Largest stack this table sells, in CHIPS. Enforced by atomic_table_buyin and read by the engine; every other buy-in column on this table is derived from this one.';
COMMENT ON COLUMN public.tables.min_buy_in_bb IS
  'DERIVED, read-only. ceil(min_buy_in / big_blind). NULL on tournament rows and on rows with no blinds. Write min_buy_in instead.';
COMMENT ON COLUMN public.tables.max_buy_in_bb IS
  'DERIVED, read-only. floor(max_buy_in / big_blind). NULL on tournament rows and on rows with no blinds. Write max_buy_in instead.';
COMMENT ON COLUMN public.tables.min_buyin IS
  'DERIVED, read-only. Legacy alias of min_buy_in_bb kept so external SELECT lists keep working. Write min_buy_in instead.';
COMMENT ON COLUMN public.tables.max_buyin IS
  'DERIVED, read-only. Legacy alias of max_buy_in_bb kept so external SELECT lists keep working. Write max_buy_in instead.';

DO $$
DECLARE
  v_disagree integer;
  v_live     integer;
BEGIN
  SELECT count(*) INTO v_disagree
    FROM public.tables
   WHERE tournament_id IS NULL
     AND COALESCE(big_blind, 0) > 0
     AND (min_buy_in_bb IS DISTINCT FROM min_buyin
       OR max_buy_in_bb IS DISTINCT FROM max_buyin);
  IF v_disagree > 0 THEN
    RAISE EXCEPTION 'the derived buy-in columns disagree on % cash rows', v_disagree;
  END IF;

  SELECT count(*) INTO v_live
    FROM public.tables
   WHERE tournament_id IS NULL
     AND status = 'running'
     AND (min_buy_in_bb, max_buy_in_bb) IS DISTINCT FROM (40, 200);
  IF v_live > 0 THEN
    RAISE EXCEPTION
      'expected every running cash table to derive to the 40-200BB band, % did not', v_live;
  END IF;
END $$;
