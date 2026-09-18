-- Reserved by scripts/reserve-migration-version.sh on 2026-09-18 13:06:50 UTC.
-- Completed-hand lookup and later-hand absence used a sequential scan of the
-- 6.8 GB snapshot heap (retained production EXPLAIN cost 832353.29). The live
-- partial index covers only incomplete snapshots. Do not weaken the proof.
--
-- Production prerequisite: the owning operator completes the SINGLE online
-- statement in scripts/ci/probes/f06-shared-hand-lane/snapshot-index/build-online.sql
-- through an approved direct/session connection, then reads the catalog.
-- A timeout is unknown: inspect that operation and index before any retry.
-- Existing online-operation precedent: scripts/ops/build-stats-runout-index-concurrently.sql;
-- recorded online-index precedent: 20260909070610_the_bounty_evidence_read_stops_at_the_seat.sql.
-- PostgreSQL forbids CONCURRENTLY inside a transaction block:
-- https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY
-- This record deliberately NEVER falls back to a blocking CREATE INDEX.
-- It also refuses a missing, invalid or same-name wrong-shaped index.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
SET LOCAL search_path=pg_catalog;
DO $index_contract$
DECLARE target oid:=to_regclass('public.hand_state_snapshots');
        candidate oid:=to_regclass('public.idx_hand_state_snapshots_table_hand');
BEGIN
 IF candidate IS NULL THEN
  RAISE EXCEPTION 'HAND_SNAPSHOT_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
  JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
  JOIN pg_attribute t ON t.attrelid=tab.oid AND t.attname='table_id' AND NOT t.attisdropped
  JOIN pg_attribute h ON h.attrelid=tab.oid AND h.attname='hand_number' AND NOT h.attisdropped
  WHERE i.indexrelid=candidate AND i.indrelid=target
   AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
   AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
   AND i.indisvalid AND i.indisready AND i.indislive
   AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
   AND i.indnkeyatts=2 AND i.indnatts=2
   AND i.indkey::text=t.attnum::text||' '||h.attnum::text
   AND t.atttypid='uuid'::regtype AND h.atttypid='integer'::regtype
   AND i.indpred IS NULL AND i.indexprs IS NULL
   AND i.indoption::text='0 0' AND i.indcollation::text='0 0'
   AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
   AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=ix.relam)
 ) THEN
  RAISE EXCEPTION 'HAND_SNAPSHOT_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
 END IF;
END $index_contract$;
COMMENT ON INDEX public.idx_hand_state_snapshots_table_hand IS
 'Full nonunique table/hand snapshot access: exact completed hand, all later-hand absence and bounded row-lock proof. Online build required before migration recording; no historical-proof filter weakened.';
COMMIT;
