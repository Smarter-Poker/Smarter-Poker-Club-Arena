-- THE DEAD HORSE SCHEMA LEAVES public (2026-09-05)
--
-- HorseDataLedger has registered sixteen tables as `legacy_unused` since
-- 2026-09-04: "zero rows, zero writes, no reader in server/src". The first half
-- was not true, and correcting it is what prompted this.
--
-- MEASURED 2026-09-05 with exact counts, not reltuples estimates:
--
--   holds rows, zero readers   horse_opponent_journals          858
--                              horse_sports_source_assignments  200
--                              horse_memory                     104
--                              ai_horses                        100
--                              horse_personality                100
--                              horse_source_assignments         100
--                              horse_topic_cooldowns             37
--                              horse_hand_history                 4
--                              horse_analytics                    1
--   genuinely empty            horse_error_log, horse_opponent_reads,
--                              horse_relationships, horse_session_analytics,
--                              horse_session_stats, horse_table_presence,
--                              horse_threat_intel, horses
--
-- None has an inbound foreign key. None is used by a view. Dan, asked what to
-- do with them: "IF ITS DEAD, ITS DEAD."
--
-- EMPTY ONES ARE DROPPED. ONES HOLDING ROWS ARE MOVED, NOT DESTROYED.
-- `zz_archive` already exists for exactly this. Moving a table out of `public`
-- takes it off the PostgREST surface and out of the advisor's RLS reports,
-- which is what "dead" needs to mean, while keeping 1,404 rows that cannot be
-- regenerated. Dropping data to win a lint is not a trade worth making.
--
-- horse_opponent_journals is the one worth naming: fifty columns of
-- per-opponent history - steal attempts, barrel counts, tank times, showdown
-- bluffs - last written 2026-08-16 and read ZERO times ever. It is a second,
-- richer opponent model that lost to HorseMind (horse_mind_stats /
-- horse_mind_pairs), which is live and took 1,595,965 reads over the same
-- period. Two models were built, one won, the loser kept its data. Archived so
-- the design is recoverable if anyone revisits it.
--
-- EIGHT ORPHANED ROUTINES GO WITH THEM - the only ones that actually read or
-- write a retired table, matched on from/join/into/update rather than a bare
-- name match (twenty-eight other functions merely contain the word "horses"):
--
--   get_available_horses    -> horses  (nothing calls it; the client notes the
--                                       "RPC doesn't exist in Supabase")
--   get_horse_memories      -> horse_memory
--   decay_horse_memories    -> horse_memory
--   record_horse_memory     -> horse_analytics
--   get_horse_personality   -> horse_personality
--   is_topic_on_cooldown    -> horse_topic_cooldowns (both overloads)
--   set_topic_cooldown      -> horse_topic_cooldowns
--
-- fn_reject_horse_name_on_human ALSO read a retired table (ai_horses) and is
-- deliberately NOT dropped: it is a live trigger on profiles, repointed at the
-- real roster in the preceding migration.
--
-- APPLIED 2026-09-05. After: 8 dropped, 9 archived with rows intact, 0
-- orphaned routines, 594 user triggers intact.

BEGIN;

CREATE SCHEMA IF NOT EXISTS zz_archive;
REVOKE ALL ON SCHEMA zz_archive FROM PUBLIC, anon, authenticated;

-- 1. The routines first: a function referencing a moved table would keep
--    resolving and fail at runtime instead of at deploy.
DO $drop_routines$
DECLARE r record;
BEGIN
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
$drop_routines$;

-- 2. Empty and unreferenced: drop.
DROP TABLE IF EXISTS public.horse_error_log;
DROP TABLE IF EXISTS public.horse_opponent_reads;
DROP TABLE IF EXISTS public.horse_relationships;
DROP TABLE IF EXISTS public.horse_session_analytics;
DROP TABLE IF EXISTS public.horse_session_stats;
DROP TABLE IF EXISTS public.horse_table_presence;
DROP TABLE IF EXISTS public.horse_threat_intel;
DROP TABLE IF EXISTS public.horses;

-- 3. Holds rows: move out of public, keep the data.
DO $archive$
DECLARE r record; v_moved integer := 0;
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

-- 4. Prove it.
DO $verify$
DECLARE v_left_public integer; v_archived integer; v_rows bigint; v_orphans integer;
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

  EXECUTE 'SELECT count(*) FROM zz_archive.horse_opponent_journals' INTO v_rows;
  IF v_rows <> 858 THEN
    RAISE EXCEPTION 'horse_opponent_journals lost rows in the move: % of 858', v_rows;
  END IF;

  SELECT count(*) INTO v_orphans
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
   WHERE p.prokind='f'
     AND p.proname IN ('get_available_horses','get_horse_memories','decay_horse_memories',
                       'record_horse_memory','get_horse_personality','is_topic_on_cooldown',
                       'set_topic_cooldown');
  IF v_orphans <> 0 THEN
    RAISE EXCEPTION '% orphaned routines remain', v_orphans;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid=tg.tgfoid
                  WHERE p.proname='fn_reject_horse_name_on_human' AND NOT tg.tgisinternal) THEN
    RAISE EXCEPTION 'the borrowed-name guard lost its trigger';
  END IF;

  RAISE NOTICE 'clean: 8 dropped, 9 archived with rows intact, 0 orphaned routines, guard still wired';
END
$verify$;

COMMIT;
