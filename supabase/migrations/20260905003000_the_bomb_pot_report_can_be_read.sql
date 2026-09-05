-- ═══════════════════════════════════════════════════════════════════════════
--  THE BOMB POT REPORT CAN BE READ, AND THE PLAYERS TAB SURVIVES A COLD CACHE
--  Club Operations upgrade, phase 6 of 8. Both found by the gate, in a browser.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two of this phase's own pages were still failing in production, and neither
-- would have been caught by reading code: they are index problems, and the
-- only way to see them is to open the page.
--
-- ── 1. The bomb pot report had never rendered ───────────────────────────────
--
--   POST /rest/v1/rpc/fn_club_bomb_pot_report  {p_days: 30}  ->  500
--   {"code":"57014","message":"canceling statement due to statement timeout"}
--
--   and with p_days: 7, the same. Phase 6 fixed the slug this page handed to a
--   uuid argument; the page then got far enough to ask the question, and the
--   database could not answer it.
--
-- `fn_club_bomb_pot_report` reads
--
--   FROM hand_history h JOIN tables t ON t.id = h.table_id
--    WHERE t.club_id = p_club_id AND h.bomb_pot IS NOT NULL AND h.created_at > ...
--
-- against 2.7M rows / 7.2 GB with no index able to serve `bomb_pot IS NOT
-- NULL`. Measured: 19,078 qualifying rows over 30 days - 0.7% of the table -
-- and **46 seconds** of sequential scan to count them. PostgREST allows
-- `authenticator` 8 seconds. No amount of client-side care could have helped.
--
-- ── 2. The Club Data players tab failed on a cold cache ─────────────────────
--
--   ca_club_player_page, cold   8,635ms -> 57014 statement timeout
--   the same call, warm           384ms, then 1,568ms, then 1,598ms
--
-- So the first operator to open the tab after a quiet period got a failure and
-- everyone after them got a page. `club_member_daily_stats` is 506,424 rows /
-- 133 MB and carries `(club_id, user_id)` and `(stat_date, table_id, club_id)`
-- - neither of which serves the shape every one of these reads uses:
--
--   WHERE s.club_id = p_club_id AND s.stat_date BETWEEN v_start AND v_end
--
-- The first index has to filter every one of the club's rows by date in the
-- heap; the second reads every club's rows for those days. A (club_id,
-- stat_date) index carrying user_id and hands_played answers it index-only,
-- and the same shape is read by ca_club_player_breakdown and by
-- ca_club_revenue's by_table.
--
-- ── Why this file is applied inside the :55 maintenance freeze ──────────────
--
-- Building an index scans the table under a lock that blocks writes, and both
-- of these tables are written continuously by the engine (~221k hands/day into
-- hand_history, and club_member_daily_stats from its trigger). During the
-- freeze every table is parked at a hand boundary and nothing is writing,
-- which is what the window is for (CLAUDE.md 13). CREATE INDEX CONCURRENTLY is
-- not available: one migration is one transaction, and CONCURRENTLY cannot run
-- inside one.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE INDEX IF NOT EXISTS idx_hand_history_bomb_pot_created
  ON public.hand_history (created_at)
  WHERE bomb_pot IS NOT NULL;

COMMENT ON INDEX public.idx_hand_history_bomb_pot_created IS
  'Serves fn_club_bomb_pot_report. Bomb pot hands are ~0.7% of hand_history (19,078 in 30 days of 2.7M rows); without this the report sequentially scans 7.2 GB for 46 seconds and is killed by the 8s PostgREST timeout, which is why the page had never rendered.';

CREATE INDEX IF NOT EXISTS idx_cmds_club_date_user
  ON public.club_member_daily_stats (club_id, stat_date)
  INCLUDE (user_id, hands_played);

COMMENT ON INDEX public.idx_cmds_club_date_user IS
  'Serves the (club_id, stat_date) range every club report reads: ca_club_player_page, ca_club_player_breakdown and ca_club_revenue.by_table. Neither existing index leads with that pair, so a cold ca_club_player_page took 8.6s and was killed by the 8s timeout while a warm one took 384ms.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'hand_history'
       AND indexname = 'idx_hand_history_bomb_pot_created'
  ) THEN
    RAISE EXCEPTION 'the bomb pot report still has no index to read';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'club_member_daily_stats'
       AND indexname = 'idx_cmds_club_date_user'
  ) THEN
    RAISE EXCEPTION 'the club reports still have no (club, date) index to read';
  END IF;
END $$;

COMMIT;
