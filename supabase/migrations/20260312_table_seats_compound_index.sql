-- ============================================================
-- Performance: Compound indexes on table_seats
-- 
-- table_seats(table_id, left_at) is the most-queried pattern
-- in the entire codebase — used by every recount, seat lookup,
-- loadSeatedPlayers, atomic_table_buyin/cashout, and merge logic.
--
-- table_seats(user_id, left_at) is used for player-specific
-- seat lookups (e.g., "is this user seated anywhere?").
--
-- Both use IF NOT EXISTS for idempotent re-runs.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_table_seats_table_left
  ON table_seats (table_id, left_at);

CREATE INDEX IF NOT EXISTS idx_table_seats_user_left
  ON table_seats (user_id, left_at);

-- Also add a compound index for the common seat lookup pattern
-- (table_id + seat_number + left_at) used by buyin/cashout RPCs
CREATE INDEX IF NOT EXISTS idx_table_seats_table_seat_left
  ON table_seats (table_id, seat_number, left_at);
