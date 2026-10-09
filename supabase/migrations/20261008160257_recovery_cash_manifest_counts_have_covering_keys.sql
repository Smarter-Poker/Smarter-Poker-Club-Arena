-- RECOVERY CASH MANIFEST COUNTS HAVE COVERING KEYS
-- Reserved by scripts/reserve-migration-version.sh; source-only qualification.
--
-- Owned standby diagnostic14258 read the exact immutable cash-manifest member
-- under one READ ONLY REPEATABLE READ snapshot1033651176:1033651179 and hit
-- SQLSTATE57014 after19232ms (original19s server/20s client). Before/after
-- native qualification and transaction/connection retirement passed.
-- Current primary read-only catalogue has only manifest PK(id) and UNIQUE
-- (table_id,hand_number), neither covering funding_provenance_complete.
-- The exact count/funding aggregate therefore scans the large manifest heap.
-- A tested single-pass deduplicated join had higher estimated cost and was
-- rejected; no financial projection or query is replaced by this migration.
--
-- Add only one nonunique covering B-tree: the original key pair plus its
-- funding flag, so all current count/funding and committed-key reads can use
-- an index-only access path when MVCC visibility permits. Actual standby
-- aggregate performance under the original19s/20s clocks must still pass;
-- this index is not a performance or full-recovery certificate.
--
-- LOCKING: build CONCURRENTLY, once, outside the sole transaction through
-- apply-merged-migration's sanctioned preamble. No blocking table/index
-- replacement, DROP, predicate, existing-index change, row write, VACUUM,
-- ANALYZE, role/grant/security/function change or deadline increase.
-- The owning applier requires12minutes before :50, enforces600s build bound,
-- reads VALID/READY before the body, and preserves failed/UNKNOWN or INVALID
-- leftovers for exact owning-operation readback; never loop or blindly drop.
--
-- @live-proof: (EXISTS (SELECT 1        FROM pg_catalog.pg_index i        JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace        JOIN pg_catalog.pg_am a ON a.oid = c.relam       WHERE n.nspname = 'public'         AND c.relname = 'ca_cash_manifest_snapshot_cover_idx'         AND i.indrelid = 'public.cash_hand_participant_manifests'::regclass         AND c.relkind = 'i' AND c.relpersistence = 'p'         AND pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'         AND a.amname = 'btree'         AND i.indisvalid AND i.indisready AND i.indislive         AND NOT i.indisunique AND NOT i.indisprimary         AND i.indnkeyatts = 2 AND i.indnatts = 3         AND i.indexprs IS NULL AND i.indpred IS NULL         AND pg_catalog.pg_get_indexdef(i.indexrelid) = 'CREATE INDEX ca_cash_manifest_snapshot_cover_idx ON public.cash_hand_participant_manifests USING btree (table_id, hand_number) INCLUDE (funding_provenance_complete)'))

CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_cash_manifest_snapshot_cover_idx
  ON public.cash_hand_participant_manifests (table_id, hand_number)
  INCLUDE (funding_provenance_complete);

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';
DO $qualified_index$
BEGIN
  IF NOT EXISTS (
    SELECT 1
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_am a ON a.oid = c.relam
      WHERE n.nspname = 'public'
        AND c.relname = 'ca_cash_manifest_snapshot_cover_idx'
        AND i.indrelid = 'public.cash_hand_participant_manifests'::regclass
        AND c.relkind = 'i' AND c.relpersistence = 'p'
        AND pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
        AND a.amname = 'btree'
        AND i.indisvalid AND i.indisready AND i.indislive
        AND NOT i.indisunique AND NOT i.indisprimary
        AND i.indnkeyatts = 2 AND i.indnatts = 3
        AND i.indexprs IS NULL AND i.indpred IS NULL
        AND pg_catalog.pg_get_indexdef(i.indexrelid) = 'CREATE INDEX ca_cash_manifest_snapshot_cover_idx ON public.cash_hand_participant_manifests USING btree (table_id, hand_number) INCLUDE (funding_provenance_complete)'
  ) THEN
    RAISE EXCEPTION 'Cash manifest covering index is not the qualified valid ready live shape'
      USING ERRCODE = '55000';
  END IF;
END $qualified_index$;
COMMIT;
