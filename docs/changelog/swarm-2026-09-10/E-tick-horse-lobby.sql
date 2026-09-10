-- Workstream E: cash-cluster tick, horse seat, tournaments lobby
-- Project kuklfnapbkmacvwxktbh (Postgres 17). Do NOT wrap in BEGIN/COMMIT:
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Evidence and reasoning: E-tick-horse-lobby.md (same directory).

-- ─────────────────────────────────────────────────────────────────────────────
-- TARGET 1  fn_cash_clusters_tick_all / fn_cash_cluster_tick / fn_cash_cluster_balance
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. The 60-second back-off test `NOT EXISTS (cash_seat_moves WHERE player_id = X AND
--     state = 'cancelled' AND created_at > now - 60s)` has no index: Seq Scan of 110k rows
--     (2,682 buffers, ~15 ms) PER CANDIDATE SEAT, in the must-move loop, in
--     fn_cash_cluster_balance (mover CTE), in the break loop and in fn_cash_seat_change_plan.
--     Measured: one Main-1 open seat on the biggest game = 33 scans = 88,506 buffers, 496 ms.
--     1,902 cancelled rows exist -> the partial index is ~2 pages.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cash_seat_moves_cancelled_player ON public.cash_seat_moves (player_id, created_at) WHERE state = 'cancelled';

-- 1b. Every per-cluster statement (`WHERE cluster_id = g.id AND lifecycle <> 'closed' | = 'opening'
--     | IN ('live','opening')`, the census, apply_ruleset, main1 lookup, headcount, abandon sweep)
--     walks tables_cluster_id_idx and discards the cluster's closed tables (97 of 104 on the
--     biggest game, 40 of 41 on average). fn_cash_clusters_to_tick's EXISTS is planned as a
--     hashed subplan that seq-scans ALL 206k tables rows (13,878 buffers, 78 ms) per pass, and
--     tick_all's anyone_seated subplan joins 2,701 live seats to tables (10,809 buffers).
--     Only 137 rows in the whole table have lifecycle <> 'closed' (all clustered).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tables_cluster_open ON public.tables (cluster_id, role, main_index, created_at) WHERE lifecycle <> 'closed';

-- 1c. OPTIONAL (small): the `status_followed_lifecycle` repair UPDATE
--     (`cluster_id = g.id AND lifecycle = 'closed' AND status <> 'closed'`) runs every tick for
--     every game and scans the whole cluster (0.45 ms/tick). 2 matching rows exist DB-wide.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tables_cluster_closed_status_drift ON public.tables (cluster_id) WHERE lifecycle = 'closed' AND status <> 'closed';

-- ─────────────────────────────────────────────────────────────────────────────
-- TARGET 2  fn_seat_horse_in_seat_first_game
-- ─────────────────────────────────────────────────────────────────────────────
-- NO SQL PROPOSED. The function's own work is 2.4-5 ms (min_exec_time 2.4 ms, ~572 shared
-- blocks/call, every read is by pkey or tournament_id). The 590 ms mean is waiting on the
-- global exclusive advisory lock hashtextextended('ca:tournament-terminal-settlement:v1',0)
-- taken first thing by fn_ca_lock_tournament_seat_acquisition, which conflicts with the SHARED
-- acquisition in fn_ca_commit_hand_settlement (every hand commit) and the exclusive one in
-- ~30 settlement/registration functions. See the .md: the safe fix is on the caller side
-- (skip the RPC for a horse that is already seated), not a weaker lock.

-- ─────────────────────────────────────────────────────────────────────────────
-- TARGET 3  tournaments lobby / TournamentStartingTicker operations query
-- ─────────────────────────────────────────────────────────────────────────────

-- 3a. RESTRICTIVE policy calls fn_poker_can_read_games(COALESCE(union_id, club_id)) per row:
--     135,616 plpgsql calls per query for a union member = 66,700 ms measured; 148 statement
--     timeouts (8 s each) in 70 min. Rewritten so the function is evaluated once per club
--     (5 rows) in a hashed subplan and each tournament row is a hash probe. Behavior-identical:
--     see .md section 3.4.
ALTER POLICY poker_arena_tournament_access ON public.tournaments USING (((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN (SELECT c.id FROM public.clubs c WHERE public.fn_poker_can_read_games(c.id))));

-- 3b. The query is `club_id = ANY($1) AND status = ANY($2) ORDER BY updated_at DESC LIMIT 80`.
--     There is no updated_at index, so after 3a the plan is still BitmapAnd(club,status) ->
--     130k rows -> top-N sort (340 ms measured). An ordered backward scan stops after ~80-100
--     matching rows (14 ms measured with the analogous start_time index).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournaments_updated_at ON public.tournaments (updated_at DESC);

-- 3c. OPTIONAL, same shape on `tables` (poker_arena_table_access is the identical per-row
--     pattern; the orchestrator should apply it only if the `tables` workstream has not).
-- ALTER POLICY poker_arena_table_access ON public.tables USING (((club_id IS NULL) AND (union_id IS NULL)) OR (COALESCE(union_id, club_id) IN (SELECT c.id FROM public.clubs c WHERE public.fn_poker_can_read_games(c.id))));

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_cash_seat_moves_cancelled_player;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_tables_cluster_open;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_tables_cluster_closed_status_drift;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_tournaments_updated_at;
--
-- Original policy (pg_policies.qual, 2026-09-10 03:35 UTC):
-- ALTER POLICY poker_arena_tournament_access ON public.tournaments USING (((club_id IS NULL) AND (union_id IS NULL)) OR fn_poker_can_read_games(COALESCE(union_id, club_id)));
--
-- Original `tables` policy (only if 3c was applied):
-- ALTER POLICY poker_arena_table_access ON public.tables USING (((club_id IS NULL) AND (union_id IS NULL)) OR fn_poker_can_read_games(COALESCE(union_id, club_id)));
--
-- No function bodies are replaced by this workstream.
