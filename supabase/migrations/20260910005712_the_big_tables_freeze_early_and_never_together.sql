/* THE BIG TABLES FREEZE EARLY, AND NEVER TOGETHER (2026-09-10)

   Twice in two days the database came within hours of forced anti-wraparound
   autovacuum during live play, and both times a human had to notice and run
   VACUUM (FREEZE) by hand:

     2026-09-08  age 197,976,830 / 200,000,000  - 44 relations over 190M,
                 solved_spots_gold (80 GB) never vacuumed or analyzed once
     2026-09-10  age 199,748,326 / 200,000,000  - ~251,000 XIDs of headroom,
                 about fifteen minutes, data_audit_log (4 GB) holding it

   The cause is structural, not neglect. autovacuum's ordinary trigger is dead
   rows as a fraction of the table; a large table that is only ever appended to
   or only ever read never crosses it, so the ONLY path that will ever vacuum it
   is the anti-wraparound one at autovacuum_freeze_max_age. Every such table
   therefore waits until 200,000,000 - and because they share one XID history,
   THEY ALL ARRIVE AT THE SAME TIME, in a pile, whenever that happens to fall.
   Measured today: 23 tables over 100 MB, 104 GB in total, with no autovacuum
   and no vacuum ever recorded.

   THE FIX IS NOT A CRON. It is telling Postgres to do its own job earlier, and
   at a different time for each table, so the pile cannot form:

     the largest table freezes first and alone, at 120,000,000
     the smallest of the set freezes last, at 180,000,000
     the rest are spread evenly between by size rank

   At the measured burn of ~24.7M XID/day that is a 2.4-day spread, so no two
   of them come due in the same window, and every one comes due with 20M-80M
   XIDs of headroom instead of zero. The first freeze of each is the expensive
   one; afterwards its pages are all-frozen in the visibility map and every
   later pass skips them, so this converts a recurring emergency into
   background work that nobody has to watch.

   SCOPE. public schema only, and only tables this role owns. The first attempt
   reached realtime.messages_2026_09_07 - a partition owned by the realtime
   extension - and was refused, correctly: a migration that alters another
   owner's tables is a migration that breaks on the next Supabase upgrade.

   Nothing is scheduled and nothing repairs anything (10.12). This is a storage
   parameter that makes the engine that already exists run at a sensible time. */
DO $mig$
DECLARE
  r record;
  v_n integer := 0;
  v_total integer;
  v_age_before bigint;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT age(datfrozenxid) INTO v_age_before
    FROM pg_database WHERE datname = current_database();

  CREATE TEMP TABLE zz_freeze_targets ON COMMIT DROP AS
  SELECT c.oid,
         n.nspname,
         c.relname,
         pg_total_relation_size(c.oid) AS bytes,
         row_number() OVER (ORDER BY pg_total_relation_size(c.oid) DESC) AS rk,
         count(*)    OVER ()                                             AS total
    FROM pg_stat_user_tables s
    JOIN pg_class c     ON c.oid = s.relid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE s.last_autovacuum IS NULL
     AND s.last_vacuum     IS NULL
     AND pg_total_relation_size(c.oid) > 100 * 1024 * 1024
     AND c.relkind = 'r'
     AND n.nspname = 'public'
     AND pg_get_userbyid(c.relowner) = current_user;

  SELECT count(*) INTO v_total FROM zz_freeze_targets;
  IF v_total = 0 THEN
    RAISE NOTICE 'no never-vacuumed public tables over 100MB; nothing to stagger';
    RETURN;
  END IF;

  FOR r IN SELECT * FROM zz_freeze_targets ORDER BY rk LOOP
    /* Largest first at 120M, smallest last at 180M, evenly spread between.
       A single-row set would divide by zero, so it takes the early end. */
    EXECUTE format(
      'ALTER TABLE %I.%I SET (autovacuum_freeze_max_age = %s)',
      r.nspname, r.relname,
      120000000 + CASE WHEN r.total > 1
                       THEN ((r.rk - 1) * 60000000) / (r.total - 1)
                       ELSE 0 END);
    v_n := v_n + 1;
  END LOOP;

  /* POST-CONDITION: every target actually carries the setting, and none of
     them was left on the 200,000,000 default. */
  PERFORM 1
    FROM zz_freeze_targets t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c
      WHERE c.oid = t.oid
        AND c.reloptions IS NOT NULL
        AND array_to_string(c.reloptions, ',') LIKE '%autovacuum_freeze_max_age%');
  IF FOUND THEN
    RAISE EXCEPTION
      'post-condition failed: at least one target table did not take autovacuum_freeze_max_age. Nothing written.';
  END IF;

  RAISE NOTICE
    'staggered % of % tables between 120M and 180M; database age was % of 200,000,000 when this ran',
    v_n, v_total, v_age_before;
END $mig$;
