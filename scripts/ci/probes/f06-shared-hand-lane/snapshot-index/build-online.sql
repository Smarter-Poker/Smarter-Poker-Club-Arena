-- One statement, outside a transaction, through the owning approved direct or
-- session connection. Read the migration's exact catalog preflight first:
-- missing means build needed; a valid exact index means reuse; a conflict or
-- unknown outcome requires inspection of the original operation, not retry.
-- Existing operation shape: scripts/ops/build-stats-runout-index-concurrently.sql.
-- PostgreSQL forbids CONCURRENTLY inside a transaction block:
-- https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY
-- Never invoke via a transaction-wrapped migration call, scheduler or loop.
CREATE INDEX CONCURRENTLY idx_hand_state_snapshots_table_hand
 ON public.hand_state_snapshots USING btree (table_id,hand_number);
