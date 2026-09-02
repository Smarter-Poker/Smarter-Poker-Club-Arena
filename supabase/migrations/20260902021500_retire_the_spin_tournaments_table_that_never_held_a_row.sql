-- ═══════════════════════════════════════════════════════════════════════════
--  RETIRE public.spin_tournaments - IT HAS NEVER HELD A ROW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A duplicate of the Spin concept that predates `tournaments.variant = 'spin'`
-- and lost. Every Spin the platform has ever run lives in `tournaments`; this
-- table has held ZERO rows for its entire life.
--
-- It is not merely unused, it is a hazard. It carries `multiplier`,
-- `prize_pool`, `buy_in` and `status` columns whose names match the live ones
-- exactly, and an RLS policy of `USING (true)` that makes it world-readable.
-- The next agent to grep for "spin" and "multiplier" finds a plausible,
-- readable, permanently empty table, and a report built on it reads a real
-- zero. Duplicate tables with the right column names are how a zero gets
-- believed.
--
-- CHECKED BEFORE DROPPING, all against the live catalog:
--   rows lifetime ......... 0
--   inbound foreign keys .. 0
--   triggers .............. 0
--   dependent views ....... 0
--   functions naming it ... 0
--   RLS policies .......... 1  (spin_tournaments_public_select, USING true)
--   code references ....... 0  (grep across src, server/src, scripts, tests)
--
-- ROLLBACK (Tier 3 - a DROP must carry the way back):
--
--   CREATE TABLE public.spin_tournaments (
--     id uuid NOT NULL,
--     club_id uuid NOT NULL,
--     buy_in integer NOT NULL,
--     player_count integer,
--     max_players integer,
--     prize_pool integer,
--     multiplier integer,
--     multipliers integer[],
--     status text,
--     start_at timestamptz,
--     created_at timestamptz
--   );
--   ALTER TABLE public.spin_tournaments ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY spin_tournaments_public_select ON public.spin_tournaments
--     FOR SELECT USING (true);
--
--   There is no data to restore: there has never been any.

DO $$
DECLARE v_rows bigint;
BEGIN
  -- Refuse to drop a table that has acquired a row since this was written.
  SELECT count(*) INTO v_rows FROM public.spin_tournaments;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'spin_tournaments now holds % row(s) - do not drop it', v_rows;
  END IF;
END $$;

DROP TABLE public.spin_tournaments;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='spin_tournaments') THEN
    RAISE EXCEPTION 'spin_tournaments is still present';
  END IF;
END $$;;
