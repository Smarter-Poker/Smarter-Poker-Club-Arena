-- ═══════════════════════════════════════════════════════════════════════════
-- A COLUMN THAT CONTRADICTS THE TRUTH, AND A VIEW WITH NO HORIZON (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── 1. `tables.bomb_pots` ───────────────────────────────────────────────────
--
-- A duplicate of `bomb_pot_enabled` that nothing writes and nothing reads, and
-- which is WRONG on precisely the rows where it matters. Measured on live data:
--
--   bomb_pots IS DISTINCT FROM bomb_pot_enabled ...... 2 rows
--   bomb_pots = true ................................. 0 rows
--   tables ........................................... 97,944 rows
--
-- Those 2 disagreeing rows are the only 2 bomb-pot tables on the platform. So
-- the column says "no bomb pots here" about every table that has them, and
-- agrees with reality only where there is nothing to be right about.
--
-- `src/components/lobby/lobbyEntries.ts` already carries a comment recording
-- that the pair disagrees on live rows. That comment is the whole reason to
-- delete rather than repair: a second spelling of a boolean has no correct
-- value, only a currently-less-wrong one, and the next reader who picks the
-- wrong spelling gets a lobby that hides every bomb-pot table on the platform.
--
-- Dropped rather than backfilled. There is no reader to keep working.
--
-- ── 2. `tables.double_board` ────────────────────────────────────────────────
--
-- Write-only. `TableConfigPage` set it on every double-board table it created;
-- nothing in either repo has ever read it (the lobby reads the settings-BLOB
-- key of the same name, and the engine reads `bomb_pot_double_board`). It is
-- `true` on 0 rows, which is the proof: tables were created with two boards
-- and the column still says none of them exist.
--
-- The write is removed in the same PR. The column is left in place here and
-- only commented, because unlike `bomb_pots` it does not CONTRADICT anything —
-- and `triple_board`, retired the same way in 2026-08-27, is still sitting
-- there as the precedent for how this repo retires a column: stop writing it,
-- say so, drop it once a release has passed with nobody noticing.
--
-- ── 3. `v_bomb_pot_outcomes` has no time filter ─────────────────────────────
--
-- Its two siblings bound themselves to 30 and 7 days. This one aggregates
-- `bomb_pot_award_units` from the beginning of time, so it gets strictly slower
-- every day the platform runs and never gets faster. 90 days is well past any
-- question anybody asks of it, and `fn_club_bomb_pot_report` is where a real
-- per-club answer comes from now.
--
-- Tier 3 (a DROP COLUMN). ROLLBACK at the foot of the file.

-- ── 1. Drop the duplicate that lies ─────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'bomb_pots'
  ) THEN
    -- Refuse if it ever gained a true value we would be discarding.
    IF EXISTS (SELECT 1 FROM public.tables WHERE bomb_pots IS TRUE) THEN
      RAISE EXCEPTION
        'refusing to drop tables.bomb_pots: % row(s) are true, so somebody started writing it',
        (SELECT count(*) FROM public.tables WHERE bomb_pots IS TRUE);
    END IF;
    ALTER TABLE public.tables DROP COLUMN bomb_pots;
  END IF;
END $$;

-- ── 2. Say plainly that double_board is retired ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'double_board'
  ) THEN
    COMMENT ON COLUMN public.tables.double_board IS
      'RETIRED 2026-08-29. Write-only: no reader has ever existed in either '
      'repo, and TableConfigPage stopped writing it in the same change. The '
      'engine reads bomb_pot_double_board; the lobby reads the settings blob. '
      'Droppable once a release has passed. Do not start writing it again.';
  END IF;
END $$;

-- ── 3. Give the outcomes view a horizon ─────────────────────────────────────
CREATE OR REPLACE VIEW public.v_bomb_pot_outcomes
WITH (security_invoker = true) AS
SELECT
  day,
  count(*) AS multi_board_hands,
  count(*) FILTER (WHERE distinct_winners = 1) AS full_scoops,
  count(*) FILTER (WHERE distinct_winners > 1) AS split_hands,
  round(avg(award_units), 2) AS avg_award_units
FROM (
  SELECT
    hand_history_id,
    date_trunc('day', min(created_at)) AS day,
    count(DISTINCT user_id) AS distinct_winners,
    count(*) AS award_units
  FROM public.bomb_pot_award_units
  -- 2026-08-29: the horizon this view never had. Its siblings bound
  -- themselves to 30 and 7 days; this one scanned the whole ledger forever.
  WHERE created_at > now() - interval '90 days'
  GROUP BY hand_history_id
) per_hand
GROUP BY day;

REVOKE ALL ON public.v_bomb_pot_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_bomb_pot_outcomes TO service_role;

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'bomb_pots'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pots still exists';
  END IF;

  IF (SELECT pg_get_viewdef('public.v_bomb_pot_outcomes'::regclass))
     NOT LIKE '%90 days%' THEN
    RAISE EXCEPTION 'assertion failed: v_bomb_pot_outcomes is still unbounded';
  END IF;

  -- CREATE OR REPLACE VIEW must not have resurrected the default grants.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'v_bomb_pot_outcomes'
      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'assertion failed: v_bomb_pot_outcomes is readable by anon/authenticated again';
  END IF;
END $$;

-- ROLLBACK:
--   ALTER TABLE public.tables ADD COLUMN bomb_pots boolean;
--   -- (it would come back NULL everywhere, which is exactly as informative as
--   --  the values it held. Nothing reads it, so nothing notices either way.)
--   CREATE OR REPLACE VIEW public.v_bomb_pot_outcomes ... without the WHERE.
