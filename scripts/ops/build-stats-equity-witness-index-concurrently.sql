\set ON_ERROR_STOP on

-- Run after 20260908233111 and outside a transaction. ca_hand_facts is over
-- 2 GB in production, so a blocking index build does not belong in a schema
-- migration or on the live settlement lock path.
--
-- This is intentionally a psql script (it uses \gexec). A failed concurrent
-- build leaves an INVALID same-name index behind; CREATE ... IF NOT EXISTS
-- would silently skip that object forever. The session advisory lock prevents
-- two operators from trying to repair/build the same index at once, and the
-- generated DROP runs CONCURRENTLY as its own top-level statement.
SELECT pg_advisory_lock(hashtextextended('ca:stats-equity-witness-index', 0));

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'public.ca_hand_facts'::regclass
       AND attname = 'all_in_equity_owed'
       AND atttypid = 'boolean'::regtype
       AND attnotnull
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'ALL_IN_EQUITY_WITNESS_COLUMN_NOT_READY';
  END IF;
END;
$preflight$;

-- Remove only an unusable or drifted copy. A correct valid index is retained.
SELECT 'DROP INDEX CONCURRENTLY public.idx_ca_hand_facts_equity_owed_played_at;'
 WHERE EXISTS (
   SELECT 1
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_am am ON am.oid = ic.relam
   WHERE i.indexrelid = to_regclass('public.idx_ca_hand_facts_equity_owed_played_at')
      AND i.indrelid = 'public.ca_hand_facts'::regclass
      AND (
        i.indisvalid IS NOT TRUE
        OR i.indisready IS NOT TRUE
        OR i.indnkeyatts <> 1
        OR i.indnatts <> 2
        OR pg_get_indexdef(i.indexrelid, 1, true) <> 'played_at'
        OR pg_get_indexdef(i.indexrelid, 2, true) <> 'all_in_equity'
        OR pg_get_expr(i.indpred, i.indrelid, false) IS DISTINCT FROM
           '(all_in_equity_owed IS TRUE)'
        OR am.amname <> 'btree'
        OR i.indisunique
        OR i.indisprimary
        OR i.indisexclusion
        OR i.indexprs IS NOT NULL
        OR NOT i.indislive
      )
 )
\gexec

-- A non-index relation occupying the canonical name is schema drift, not an
-- object this operational script may guess how to destroy.
DO $name_guard$
BEGIN
  IF to_regclass('public.idx_ca_hand_facts_equity_owed_played_at') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_index i
        WHERE i.indexrelid =
              to_regclass('public.idx_ca_hand_facts_equity_owed_played_at')
          AND i.indrelid = 'public.ca_hand_facts'::regclass
     ) THEN
    RAISE EXCEPTION
      'ALL_IN_EQUITY_WITNESS_INDEX_NAME_OCCUPIED: canonical name is not an index on public.ca_hand_facts';
  END IF;
END;
$name_guard$;

SELECT $ddl$CREATE INDEX CONCURRENTLY idx_ca_hand_facts_equity_owed_played_at
  ON public.ca_hand_facts (played_at)
  INCLUDE (all_in_equity)
  WHERE all_in_equity_owed IS TRUE;$ddl$
 WHERE to_regclass('public.idx_ca_hand_facts_equity_owed_played_at') IS NULL
\gexec

DO $postcondition$
DECLARE
  v_definition text;
  v_exact boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid),
         i.indnkeyatts = 1
           AND i.indnatts = 2
           AND pg_get_indexdef(i.indexrelid, 1, true) = 'played_at'
           AND pg_get_indexdef(i.indexrelid, 2, true) = 'all_in_equity'
           AND pg_get_expr(i.indpred, i.indrelid, false) =
               '(all_in_equity_owed IS TRUE)'
           AND am.amname = 'btree'
           AND NOT i.indisunique
           AND NOT i.indisprimary
           AND NOT i.indisexclusion
           AND i.indexprs IS NULL
           AND i.indislive
    INTO v_definition, v_exact
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
   WHERE i.indexrelid = to_regclass('public.idx_ca_hand_facts_equity_owed_played_at')
     AND i.indrelid = 'public.ca_hand_facts'::regclass
     AND i.indisvalid
     AND i.indisready;

  IF v_definition IS NULL OR v_exact IS NOT TRUE THEN
    RAISE EXCEPTION 'ALL_IN_EQUITY_WITNESS_INDEX_INVALID: %', v_definition;
  END IF;
END;
$postcondition$;

SELECT pg_advisory_unlock(hashtextextended('ca:stats-equity-witness-index', 0));
