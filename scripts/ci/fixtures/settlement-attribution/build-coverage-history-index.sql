-- Maintained native TLS session, one top-level concurrent command. PostgreSQL
-- forbids CONCURRENTLY inside BEGIN; session SET commands are sent separately.
-- Respect the installed DDL/freeze guard, and read durable outcome after an
-- unknown acknowledgment. Never retry or drop an active operation.
SET lock_timeout='180s';
SET statement_timeout='6min';
CREATE INDEX CONCURRENTLY idx_hand_history_time_identity
ON public.hand_history USING btree (created_at) INCLUDE (id,table_id,hand_number);
