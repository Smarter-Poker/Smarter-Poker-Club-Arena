-- ---------------------------------------------------------------------------
-- Multixact SLRU probes. Read-only. Safe to run against production.
--
-- Written 2026-10-03 while investigating multixact SLRU starvation. The
-- findings are in docs/changelog/2026-10-03-multixact-churn-the-locks-that-
-- must-stay.md. These are the probes; the traps below each cost real time.
--
-- RUN EACH SECTION AS ONE CALL. Over the Supabase MCP one call is one
-- transaction (CLAUDE.md 11.5 rule 1), and these probes depend on that.
--
-- TRAP 1  pg_stat_slru is snapshotted per transaction (stats_fetch_consistency
--         defaults to 'cache'). Two reads in one statement return the SAME
--         numbers and the delta is a silent zero. You must call
--         pg_stat_clear_snapshot() between the reads, and the reads must be
--         sequenced by plpgsql. A CTE will not do it: CTE evaluation order is
--         not guaranteed, so the clear can run after both reads.
--
-- TRAP 2  A DO block's RAISE NOTICE does not come back through the Supabase
--         MCP. The call returns []. A probe has to RETURN rows, so these are
--         pg_temp functions (CLAUDE.md 11.5 rule 4: never public).
--
-- TRAP 3  There is no live counter for multixacts created.
--         pg_control_checkpoint() only advances at a checkpoint, so over a
--         20 second window it reports 0. Derive it from blks_zeroed instead:
--         an offset page holds BLCKSZ/4 = 2048 offsets, and a member page
--         holds 1636 members (409 groups of 4).
--
-- TRAP 4  The workload swings more than fourfold within minutes. Take at
--         least three samples before believing any number, and do not try to
--         prove a change worth under about 30% by sampling production.
-- ---------------------------------------------------------------------------


-- 1. Rate and miss ratio, sampled N times. The headline numbers.
CREATE FUNCTION pg_temp.mx_samples(p_secs int DEFAULT 20, p_n int DEFAULT 3)
RETURNS TABLE(sample int, slru text, reads_per_s numeric, miss_pct numeric,
              multixacts_per_s numeric, members_per_s numeric)
LANGUAGE plpgsql AS $f$
DECLARE i int;
BEGIN
  FOR i IN 1..p_n LOOP
    PERFORM pg_stat_clear_snapshot();
    CREATE TEMP TABLE _mx AS
      SELECT name, blks_hit h, blks_read rd, blks_zeroed z
        FROM pg_stat_slru WHERE name LIKE 'multixact%';
    PERFORM pg_sleep(p_secs);
    PERFORM pg_stat_clear_snapshot();
    RETURN QUERY
      SELECT i, a.name::text,
             round((b.blks_read - a.rd) / p_secs::numeric, 1),
             round(100.0 * (b.blks_read - a.rd)
                   / NULLIF((b.blks_read - a.rd) + (b.blks_hit - a.h), 0), 2),
             CASE WHEN a.name = 'multixact_offset'
                  THEN round((b.blks_zeroed - a.z) * 2048.0 / p_secs, 0) END,
             CASE WHEN a.name = 'multixact_member'
                  THEN round((b.blks_zeroed - a.z) * 1636.0 / p_secs, 0) END
        FROM _mx a JOIN pg_stat_slru b ON b.name = a.name
       ORDER BY 2;
    DROP TABLE _mx;
  END LOOP;
END $f$;

SELECT * FROM pg_temp.mx_samples(20, 3);


-- 2. Attribution: does THIS table's tuples carry multixact xmax?
--
-- pageinspect is not installed and installing an extension to probe
-- production is the DDL probe section 2 rule 3 forbids. So measure it
-- behaviourally: sample idle, then sample the same duration while scanning
-- the table in a tight loop, and attribute the excess.
--
-- ALWAYS run a control table you expect to be clean in the same session.
-- public.feature_pricing is the known-clean control: 68 rows, zero updates,
-- and 20,000 scans of it add nothing. Without a control you cannot tell an
-- attribution from a background spike, and the background swings fourfold.
--
-- Keep p_secs small. This adds real CPU to a primary that is already hot.
CREATE FUNCTION pg_temp.mx_attribute(p_tbl text, p_secs int DEFAULT 5)
RETURNS TABLE(tbl text, phase text, member_reads_s numeric,
              offset_reads_s numeric, scans bigint)
LANGUAGE plpgsql AS $f$
DECLARE r0 bigint; o0 bigint; r1 bigint; o1 bigint;
        n bigint := 0; t_end timestamptz; sink bigint;
BEGIN
  PERFORM pg_stat_clear_snapshot();
  SELECT blks_read INTO r0 FROM pg_stat_slru WHERE name = 'multixact_member';
  SELECT blks_read INTO o0 FROM pg_stat_slru WHERE name = 'multixact_offset';
  PERFORM pg_sleep(p_secs);
  PERFORM pg_stat_clear_snapshot();
  SELECT blks_read INTO r1 FROM pg_stat_slru WHERE name = 'multixact_member';
  SELECT blks_read INTO o1 FROM pg_stat_slru WHERE name = 'multixact_offset';
  RETURN QUERY SELECT p_tbl, 'idle'::text,
    round((r1 - r0) / p_secs::numeric, 1),
    round((o1 - o0) / p_secs::numeric, 1), 0::bigint;

  PERFORM pg_stat_clear_snapshot();
  SELECT blks_read INTO r0 FROM pg_stat_slru WHERE name = 'multixact_member';
  SELECT blks_read INTO o0 FROM pg_stat_slru WHERE name = 'multixact_offset';
  t_end := clock_timestamp() + make_interval(secs => p_secs);
  WHILE clock_timestamp() < t_end AND n < 30000 LOOP
    EXECUTE format('SELECT count(*) FROM %s', p_tbl) INTO sink;
    n := n + 1;
  END LOOP;
  PERFORM pg_stat_clear_snapshot();
  SELECT blks_read INTO r1 FROM pg_stat_slru WHERE name = 'multixact_member';
  SELECT blks_read INTO o1 FROM pg_stat_slru WHERE name = 'multixact_offset';
  RETURN QUERY SELECT p_tbl, 'scan'::text,
    round((r1 - r0) / p_secs::numeric, 1),
    round((o1 - o0) / p_secs::numeric, 1), n;
END $f$;

SELECT * FROM pg_temp.mx_attribute('public.feature_pricing', 5)   -- control
UNION ALL SELECT * FROM pg_temp.mx_attribute('public.clubs', 5)
UNION ALL SELECT * FROM pg_temp.mx_attribute('public.profiles', 5);


-- 3. Freeze state of the candidate parents.
--
-- A large relminmxid_age looks like a freezing gap and is usually not one.
-- relminmxid only advances during an aggressive scan, which needs
-- relminmxid_age > vacuum_multixact_freeze_table_age (150 M here), so on a
-- table below that it simply sits still. Measured 2026-10-03:
-- VACUUM (FREEZE) on public.profiles did not reduce its per-scan multixact
-- cost at all, because these rows always have a live locker and a multixact
-- xmax cannot be replaced while a member is still running.
SELECT n.nspname || '.' || c.relname AS tbl,
       c.reltuples::bigint AS est_rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       mxid_age(c.relminmxid) AS relminmxid_age,
       s.n_tup_upd, s.n_dead_tup, s.autovacuum_count, s.last_autovacuum,
       pg_get_userbyid(c.relowner) AS owner,
       pg_has_role(current_user, c.relowner, 'USAGE') AS i_can_alter,
       c.reloptions
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
 WHERE (n.nspname = 'public'
        AND c.relname IN ('clubs', 'profiles', 'club_members', 'tables',
                          'table_seats', 'chip_ledger', 'agent_commissions',
                          'ca_hand_facts'))
    OR (n.nspname = 'auth' AND c.relname = 'users')
 ORDER BY mxid_age(c.relminmxid) DESC NULLS LAST;
