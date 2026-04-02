-- Enforce ONE active seat per user per table at the database level.
-- This partial unique index only applies to rows where left_at IS NULL (active seats).
-- If a user tries to sit at a second seat at the same table, the INSERT will fail.
-- This is the ultimate safety net — even if client/server logic has bugs,
-- the DB will reject duplicate active seats for the same user at the same table.

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_user_per_table
ON table_seats (table_id, user_id)
WHERE left_at IS NULL;
