-- Applied to production 2026-09-02 as schema_migrations version 20260902010939.
--
-- The four redundant dead indexes fn_redundant_dead_indexes() surfaced after the
-- 2026-09-01 census took the count to zero. They are the guard's second catch:
-- each had never been scanned in the lifetime of the database AND its key columns
-- are a leading prefix of a unique constraint index on the same table, so every
-- query that could use it can use the wider one.
--
--   messenger_blocked.idx_messenger_blocked_blocker
--     <- messenger_blocked_blocker_id_blocked_id_key
--   messenger_conversation_labels.idx_messenger_conv_labels_user
--     <- messenger_conversation_labels_user_id_conversation_id_label_key
--   messenger_favorites.idx_messenger_favorites_user
--     <- messenger_favorites_user_id_favorite_user_id_key
--   trivia_user_items.idx_trivia_user_items_user
--     <- trivia_user_items_user_id_item_type_key
--
-- All four are 8 kB on tables with ZERO writes, so this reclaims almost nothing and
-- saves almost no write amplification. It is worth doing anyway for one reason: an
-- empty guard reading is the only reading anyone will act on. A guard that always
-- says "4" is a guard people learn to ignore, and the next real one hides behind
-- these.
--
-- Same protections as the 130-index census, for the same reasons:
--   * lock_timeout 3s, so an ACCESS EXCLUSIVE is never queued behind live traffic;
--   * one subtransaction per index, so a busy table costs that index and not the run;
--   * the ledger row is written BEFORE the drop and shares its subtransaction, so a
--     failed drop cannot leave a row claiming an index was removed.
--
-- RESULT: 4 dropped, 0 skipped. Guard reads 0; ledger holds 134 recoverable entries.
--
-- REVERSIBLE: SELECT ddl FROM ca_dropped_index_ledger WHERE index_name = '<name>';

DO $$
DECLARE
  r         record;
  v_dropped int := 0;
  v_skipped int := 0;
BEGIN
  SET LOCAL lock_timeout = '3s';

  FOR r IN
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
           a.indexrelname, a.relname, a.sz,
           b.indexrelname AS covered_by, b.idx_scan AS coverer_scans,
           pg_get_indexdef(a.indexrelid) AS ddl
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
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.objid = a.indexrelid AND d.deptype = 'i')
    ORDER BY a.indexrelid, b.idx_scan DESC
  LOOP
    BEGIN
      INSERT INTO public.ca_dropped_index_ledger
        (index_name, table_name, ddl, size_bytes, covered_by, coverer_scans, reason)
      VALUES
        (r.indexrelname, r.relname, r.ddl, r.sz, r.covered_by, r.coverer_scans,
         'never scanned in the lifetime of the database, and its key columns are a '
         'leading prefix of ' || r.covered_by || '. Surfaced by '
         'fn_redundant_dead_indexes() after the 2026-09-01 census, dropped 2026-09-02.');

      EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexrelname);
      v_dropped := v_dropped + 1;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'busy, left in place (safe to re-run): %', r.indexrelname;
    END;
  END LOOP;

  RAISE NOTICE 'dropped %, skipped % (busy)', v_dropped, v_skipped;

  IF v_dropped = 0 AND v_skipped = 0 THEN
    RAISE EXCEPTION 'the census found nothing to drop - it reported 4 moments ago, so '
                    'something changed underneath this migration. Do not commit a no-op '
                    'that looks like success.';
  END IF;
END $$;

DO $$
DECLARE v_left int; v_ledger int; v_noddl int;
BEGIN
  SELECT count(*) INTO v_left   FROM public.fn_redundant_dead_indexes();
  SELECT count(*) INTO v_ledger FROM public.ca_dropped_index_ledger;
  SELECT count(*) INTO v_noddl  FROM public.ca_dropped_index_ledger
   WHERE ddl IS NULL OR ddl !~ '^CREATE INDEX';

  IF v_noddl <> 0 THEN
    RAISE EXCEPTION '% ledger rows carry no usable CREATE INDEX statement', v_noddl;
  END IF;
  IF v_left <> 0 THEN
    RAISE NOTICE 'guard still reports % (a busy table to re-run, not a failure)', v_left;
  END IF;

  RAISE NOTICE 'guard reports %, ledger holds % recoverable entries', v_left, v_ledger;
END $$;
