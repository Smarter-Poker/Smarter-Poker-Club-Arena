-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905085612; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905085612   (the stamp IS the apply time, UTC: 2026-09-05 08:56:12)
--   name        the_dead_horse_schema_leaves_public
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 8943 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905085612 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     DROP           FUNCTION public.get_available_horses, FUNCTION public.get_horse_memories, FUNCTION public.decay_horse_memories, FUNCTION public.record_horse_memory, FUNCTION public.get_horse_personality, FUNCTION IF, TABLE public.horse_error_log, TABLE public.horse_opponent_reads
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- THE DEAD HORSE SCHEMA LEAVES public (2026-09-05)
--
-- HorseDataLedger has registered sixteen tables as `legacy_unused` since
-- 2026-09-04: "zero rows, zero writes, no reader in server/src". The first half
-- of that was not true, and correcting it is what prompted this.
--
-- MEASURED 2026-09-05, exact counts, not reltuples estimates:
--
--   holds rows, zero readers          horse_opponent_journals          858
--                                     horse_sports_source_assignments  200
--                                     horse_memory                     104
--                                     ai_horses                        100
--                                     horse_personality                100
--                                     horse_source_assignments         100
--                                     horse_topic_cooldowns             37
--                                     horse_hand_history                 4
--                                     horse_analytics                    1
--   genuinely empty                   horse_error_log, horse_opponent_reads,
--                                     horse_relationships, horse_session_analytics,
--                                     horse_session_stats, horse_table_presence,
--                                     horse_threat_intel, horses
--
-- None has an inbound foreign key. None is used by a view. Dan, asked what to
-- do with them: "IF ITS DEAD, ITS DEAD."
--
-- SO: EMPTY ONES ARE DROPPED. ONES HOLDING ROWS ARE MOVED, NOT DESTROYED.
-- `zz_archive` already exists in this database for exactly this (it holds
-- wallet_transactions_phantom_archive). Moving a table out of `public` takes
-- it off the PostgREST surface and out of the advisor's RLS reports, which is
-- the whole point of "dead", while keeping 1,404 rows that cannot be
-- regenerated. Dropping data to win a lint is not a trade worth making.
--
-- horse_opponent_journals is the one worth naming. Fifty columns of
-- per-opponent history - steal attempts, barrel counts, tank times, showdown
-- bluffs - last written 2026-08-16 and read ZERO times ever. It is a second,
-- richer opponent model that lost to HorseMind (horse_mind_stats /
-- horse_mind_pairs), which is live and took 1,595,965 reads over the same
-- period. Two models were built, one won, the loser kept its data. Archived
-- rather than dropped so the design is recoverable if anyone revisits it.
--
-- EIGHT ORPHANED ROUTINES GO WITH THEM. These are the only routines that
-- actually read or write a retired table (checked with a from/join/into/update
-- match, not a bare name match - twenty-eight other functions merely contain
-- the word "horses" in a comment or in their own name):
--
--   get_available_horses          -> horses      (and nothing calls it: the
--                                                 client notes "RPC doesn't
--                                                 exist in Supabase")
--   get_horse_memories           -> horse_memory
--   decay_horse_memories         -> horse_memory
--   record_horse_memory          -> horse_analytics
--   get_horse_personality        -> horse_personality
--   is_topic_on_cooldown         -> horse_topic_cooldowns  (both overloads)
--   set_topic_cooldown           -> horse_topic_cooldowns
--
-- fn_reject_horse_name_on_human ALSO read a retired table (ai_horses) and is
-- deliberately NOT dropped: it is a live trigger on profiles and was repointed
-- at the real roster in the preceding migration.

BEGIN;

CREATE SCHEMA IF NOT EXISTS zz_archive;
REVOKE ALL ON SCHEMA zz_archive FROM PUBLIC, anon, authenticated;

-- ── 1. The routines that read them, first: a function referencing a moved
--       table would keep resolving and fail at runtime instead of at deploy.
DROP FUNCTION IF EXISTS public.get_available_horses();
DROP FUNCTION IF EXISTS public.get_horse_memories(uuid, text, integer);
DROP FUNCTION IF EXISTS public.get_horse_memories(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.decay_horse_memories();
DROP FUNCTION IF EXISTS public.record_horse_memory(uuid, uuid, text, text, numeric);
DROP FUNCTION IF EXISTS public.get_horse_personality(uuid);

DO $drop_rest$
DECLARE r record;
BEGIN
  -- Overloads and signatures we did not enumerate exactly: drop by name, but
  -- ONLY the ones that genuinely touch a retired table.
  FOR r IN
    SELECT quote_ident(n.nspname)||'.'||quote_ident(p.proname)
             ||'('||pg_get_function_identity_arguments(p.oid)||')' AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
     WHERE p.prokind='f'
       AND p.proname IN ('get_available_horses','get_horse_memories','decay_horse_memories',
                         'record_horse_memory','get_horse_personality',
                         'is_topic_on_cooldown','set_topic_cooldown')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.sig);
  END LOOP;
END
$drop_rest$;

-- ── 2. Empty and unreferenced: drop.
DROP TABLE IF EXISTS public.horse_error_log;
DROP TABLE IF EXISTS public.horse_opponent_reads;
DROP TABLE IF EXISTS public.horse_relationships;
DROP TABLE IF EXISTS public.horse_session_analytics;
DROP TABLE IF EXISTS public.horse_session_stats;
DROP TABLE IF EXISTS public.horse_table_presence;
DROP TABLE IF EXISTS public.horse_threat_intel;
DROP TABLE IF EXISTS public.horses;

-- ── 3. Holds rows: move out of public, keep the data.
DO $archive$
DECLARE
  r record;
  v_moved integer := 0;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY['horse_opponent_journals','horse_sports_source_assignments',
                        'horse_memory','ai_horses','horse_personality',
                        'horse_source_assignments','horse_topic_cooldowns',
                        'horse_hand_history','horse_analytics']) AS t
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname=r.t AND c.relkind='r') THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA zz_archive', r.t);
      EXECUTE format('REVOKE ALL ON TABLE zz_archive.%I FROM PUBLIC, anon, authenticated', r.t);
      v_moved := v_moved + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'archived % tables to zz_archive', v_moved;
END
$archive$;

-- ── 4. Prove it.
DO $verify$
DECLARE
  v_left_public integer;
  v_archived    integer;
  v_rows        bigint;
  v_orphans     integer;
BEGIN
  SELECT count(*) INTO v_left_public
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r'
     AND c.relname IN ('horse_analytics','horse_error_log','horse_hand_history','horse_memory',
                       'horse_opponent_journals','horse_opponent_reads','horse_personality',
                       'horse_relationships','horse_session_analytics','horse_session_stats',
                       'horse_source_assignments','horse_sports_source_assignments',
                       'horse_table_presence','horse_threat_intel','horse_topic_cooldowns',
                       'horses','ai_horses');
  IF v_left_public <> 0 THEN
    RAISE EXCEPTION '% retired tables are still in public', v_left_public;
  END IF;

  SELECT count(*) INTO v_archived
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='zz_archive' AND c.relkind='r'
     AND c.relname IN ('horse_opponent_journals','horse_sports_source_assignments','horse_memory',
                       'ai_horses','horse_personality','horse_source_assignments',
                       'horse_topic_cooldowns','horse_hand_history','horse_analytics');
  IF v_archived <> 9 THEN
    RAISE EXCEPTION 'expected 9 archived tables, found %', v_archived;
  END IF;

  -- The rows actually survived the move.
  EXECUTE 'SELECT count(*) FROM zz_archive.horse_opponent_journals' INTO v_rows;
  IF v_rows <> 858 THEN
    RAISE EXCEPTION 'horse_opponent_journals lost rows in the move: % of 858', v_rows;
  END IF;

  -- No routine is left pointing at something that is gone.
  SELECT count(*) INTO v_orphans
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
   WHERE p.prokind='f'
     AND p.proname IN ('get_available_horses','get_horse_memories','decay_horse_memories',
                       'record_horse_memory','get_horse_personality','is_topic_on_cooldown',
                       'set_topic_cooldown');
  IF v_orphans <> 0 THEN
    RAISE EXCEPTION '% orphaned routines remain', v_orphans;
  END IF;

  -- The live guard that used to read ai_horses is still here and still wired.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid
                  WHERE p.proname='fn_reject_horse_name_on_human' AND NOT tg.tgisinternal) THEN
    RAISE EXCEPTION 'the borrowed-name guard lost its trigger';
  END IF;

  RAISE NOTICE 'clean: 8 dropped, 9 archived with rows intact, 0 orphaned routines, guard still wired';
END
$verify$;

COMMIT;
