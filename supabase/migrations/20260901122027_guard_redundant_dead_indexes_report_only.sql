-- Applied to production 2026-09-01 as schema_migrations version 20260901122027
-- (registered name: 20260901_guard_redundant_dead_indexes_report_only).
--
-- Phase 4 / 3: the guard half of the index census. REPORTS ONLY - it drops nothing.
--
-- The census found 130 indexes that are BOTH never-scanned AND structurally
-- redundant (their key columns are a leading prefix of another btree index on the
-- same table, neither partial nor expression-based). Dropping them is a separate
-- decision and is deliberately NOT in this migration.
--
-- Both conditions are required. "Never scanned" alone is weak evidence - an index
-- may exist for a monthly report or a path not yet exercised. "Redundant" alone is
-- not enough either - the narrower index may be the one actually in use. Together
-- they mean: every query that could use this index can use the wider one, and none
-- ever has.
--
-- Two things had to be true for idx_scan to be trustworthy at all, and both were
-- checked before this function was written:
--   1. pg_stat_database.stats_reset IS NULL - counters are lifetime, never reset.
--   2. There is no read replica. pg_replication_slots holds 2 slots, both LOGICAL
--      (wal2json + pgoutput, Supabase Realtime), 0 physical. A physical replica
--      keeps its own index stats and would have made "never scanned on the primary"
--      meaningless.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_redundant_dead_indexes();

CREATE OR REPLACE FUNCTION public.fn_redundant_dead_indexes()
RETURNS TABLE (
  table_name    text,
  index_name    text,
  size_bytes    bigint,
  covered_by    text,
  coverer_scans bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH idx AS (
    SELECT s.relid, s.relname, s.indexrelname, s.indexrelid, s.idx_scan,
           i.indisunique, i.indisprimary, i.indisexclusion,
           i.indkey::int2[] AS keys, i.indnkeyatts,
           pg_get_expr(i.indpred, i.indrelid) AS pred, am.amname,
           i.indexprs IS NOT NULL AS has_expr,
           pg_relation_size(s.indexrelid) AS sz
    FROM pg_stat_user_indexes s
    JOIN pg_index i  ON i.indexrelid = s.indexrelid
    JOIN pg_class ic ON ic.oid = s.indexrelid
    JOIN pg_am am    ON am.oid = ic.relam
    WHERE s.schemaname = 'public'
  )
  SELECT DISTINCT ON (a.indexrelid)
         a.relname::text, a.indexrelname::text, a.sz,
         b.indexrelname::text, b.idx_scan
  FROM idx a
  JOIN idx b
    ON a.relid = b.relid
   AND a.indexrelid <> b.indexrelid
   AND a.amname = 'btree' AND b.amname = 'btree'
   AND a.pred IS NULL AND b.pred IS NULL
   AND NOT a.has_expr AND NOT b.has_expr
   AND a.indnkeyatts < b.indnkeyatts
   AND b.keys[0:a.indnkeyatts-1] = a.keys[0:a.indnkeyatts-1]
  WHERE a.idx_scan = 0
    AND NOT a.indisunique AND NOT a.indisprimary AND NOT a.indisexclusion
    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = a.indexrelid)
  ORDER BY a.indexrelid, b.idx_scan DESC;
$$;

COMMENT ON FUNCTION public.fn_redundant_dead_indexes() IS
  'Indexes never scanned in the lifetime of the database AND whose key columns are '
  'a leading prefix of another btree index on the same table. Reports only; it never '
  'drops anything. Added 2026-09-01 (Phase 4 index census).';

-- Phase 3 law: Postgres grants EXECUTE to PUBLIC on every new function unless the
-- REVOKE is written. This one reports which query paths are cold, which is not
-- something a player should be able to read.
REVOKE ALL ON FUNCTION public.fn_redundant_dead_indexes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_redundant_dead_indexes() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_redundant_dead_indexes() TO service_role;

DO $$
DECLARE v_anon boolean; v_auth boolean; v_svc boolean;
BEGIN
  SELECT has_function_privilege('anon',          'public.fn_redundant_dead_indexes()', 'EXECUTE'),
         has_function_privilege('authenticated', 'public.fn_redundant_dead_indexes()', 'EXECUTE'),
         has_function_privilege('service_role',  'public.fn_redundant_dead_indexes()', 'EXECUTE')
    INTO v_anon, v_auth, v_svc;

  IF v_anon OR v_auth THEN
    RAISE EXCEPTION 'fn_redundant_dead_indexes is browser-reachable (anon=%, authenticated=%)',
      v_anon, v_auth;
  END IF;
  IF NOT v_svc THEN
    RAISE EXCEPTION 'fn_redundant_dead_indexes is not executable by service_role';
  END IF;
END $$;
