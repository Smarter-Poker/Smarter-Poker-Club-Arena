-- One maintained native TLS session and top-level concurrent statement.
-- Session SET commands are separate; CONCURRENTLY cannot run inside BEGIN.
-- Respect current DDL/freeze admission. Unknown outcomes require catalog and
-- progress readback; never compete with an active builder or retry blindly.
SET lock_timeout='180s';
SET statement_timeout='6min';
CREATE INDEX CONCURRENTLY idx_hand_atomic_commit_identity
ON public.hand_atomic_commits USING btree (hand_number) INCLUDE (hand_id,table_id);
