-- A CLUB STAYS DELETABLE WITH THE BBJ CROSSINGS BESIDE IT.
--
-- `Supabase Invariants - A Club Stays Deletable` is red on `main`, and it is
-- not red because of anything in this branch. It says:
--
--   A CLUB CANNOT BE DELETED: 1 foreign key(s) into public.clubs would force a
--   sequential scan.
--     bbj_threshold_crossings.club_id (bbj_threshold_crossings_club_id_fkey)
--
-- A foreign key with no index leading on its own column makes Postgres scan
-- the child table for every `DELETE FROM clubs`. The guard's own text records
-- why that matters here and it is not hypothetical: the retirement RPC runs
-- inside a PostgREST request that is cancelled after a few seconds, and when
-- it is cancelled a certification fixture and its 100,000 chips stay in Club
-- Arena. That has already happened once.
--
-- Fixing it comes before my own work (CLAUDE.md section 4, fix-first, and 5.8 -
-- you cannot ship past a red required check anyway).
--
-- PLAIN, NOT CONCURRENTLY, and the size is the reason. The guard's message
-- says to build it CONCURRENTLY against production first "if the child table is
-- large"; measured before writing this, `bbj_threshold_crossings` is 40 kB with
-- no rows yet analysed. A plain build takes a SHARE lock for the moment it
-- takes to index an empty table, so the CONCURRENTLY dance would add risk and
-- a second migration for nothing. On a table of any size the advice stands.
--
-- This is the only DDL here, and CREATE INDEX does fire pgrst_ddl_watch - one
-- ~28 second PostgREST schema reload, in one transaction, per section 2.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_bbj_threshold_crossings_club_id_fk
  ON public.bbj_threshold_crossings (club_id);

DO $verify$
DECLARE
  v_unindexed int;
BEGIN
  /* Ask the same question the guard asks: every FK into clubs has an index
     whose FIRST column is the referencing column, and which is not partial. */
  SELECT count(*) INTO v_unindexed
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = fk.conkey[1]
   WHERE fk.contype = 'f'
     AND fk.confrelid = 'public.clubs'::regclass
     AND array_length(fk.conkey, 1) = 1
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = fk.conrelid
          AND i.indkey[0] = fk.conkey[1]
          AND i.indpred IS NULL);

  IF v_unindexed <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % foreign key(s) into clubs still force a sequential scan', v_unindexed;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public'
                    AND tablename = 'bbj_threshold_crossings'
                    AND indexname = 'idx_bbj_threshold_crossings_club_id_fk') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the index was not created';
  END IF;

  RAISE NOTICE 'A_CLUB_STAYS_DELETABLE every single-column foreign key into clubs is answerable by a plain index';
END $verify$;

COMMIT;
