-- ===========================================================================
--  THE WRITE PATH KEEPS ONLY THE INDEXES IT READS
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. Read from production (pg_stat_wal,
-- pg_stat_checkpointer, pg_stat_statements, pg_stat_user_tables and
-- pg_stat_user_indexes, all reset 2026-09-28 16:36 UTC, 4.4 days of traffic).
--
-- The database is saturated on WAL: 1.31 TB of WAL in 4.4 days (206 MB/min
-- on average, 277-303 MB/min measured at 02:40 UTC), 294.7M full-page images,
-- and up to ~28 client backends waiting on LWLock WALWrite at peak. Every
-- index on a hot table is one more WAL record, and after each 5-minute
-- checkpoint one more full-page image, per row version. This removes index
-- maintenance that no reader uses and that no constraint needs, and gives two
-- update-every-hand tables their HOT updates back. No function body, grant,
-- schedule, constraint or unique index changes.
--
-- 1. agent_commissions (14.3M rows, 10 GB, 9 indexes; 3,449,758 inserts, each
--    writing every index entry). Three indexes are strict prefixes of another
--    index with the same predicate, so any plan that used them has the same
--    key order available in the wider one:
--      idx_agent_commissions_club_id (club_id)            503 scans
--        <- idx_agent_commissions_club_created (club_id, created_at)
--           INCLUDE (user_id, amount, settled_at); also non-partial and
--           leading on club_id, so the clubs FK check stays indexed
--           (check-club-fk-indexes).
--      idx_agent_commissions_user (user_id)               1,027 scans
--        <- agent_commissions_user_recent_idx (user_id, created_at DESC)
--      agent_commissions_unsettled_idx (club_id, user_id)
--        INCLUDE (amount, created_at) WHERE settled_at IS NULL   167 scans
--        <- agent_commissions_open_idx (club_id, user_id, created_at)
--           INCLUDE (amount, id) WHERE settled_at IS NULL: same predicate,
--           every key and included column, so its index-only sums stay
--           index-only.
--    The primary key and uq_agent_commissions_source are untouched.
--
-- 2. ca_horse_fleet_state (1,000 machine-telemetry rows; 9,208,923 updates,
--    only 2,798,513 HOT). Three indexes with ZERO scans: state_idx (state),
--    club_idx (club_id, state) and stuck_idx (last_action_at) WHERE state IN
--    (seated, playing). fn_ca_fleet_seat_touch sets last_action_at on every
--    call, so stuck_idx made every touch a non-HOT update. Every reader
--    (fn_ca_fleet_overview, fn_audit_seat_clock) aggregates the whole
--    1,000-row table and never used them.
--
-- 3. horse_mind_pairs_updated_at_idx (horse_mind_pairs.updated_at): ZERO
--    scans against 2,296,856 upserts. upsert_horse_mind_pairs sets
--    updated_at on every row; the only reader (HorseMindPersistence hydrate)
--    orders by opps through horse_mind_pairs_opps_idx.
--
-- 4. idx_ca_hand_facts_allin (user_id, played_at DESC) WHERE was_all_in:
--    ZERO scans against 11,572,747 inserts; idx_ca_hand_facts_user_time
--    (user_id, played_at DESC) has the same keys in the same order without
--    the predicate (2.3M scans).
--
-- 5. club_member_daily_stats (1.36M rows; 11,328,527 updates, ZERO HOT).
--    Every hand's ON CONFLICT DO UPDATE adds to hands_played and raises
--    biggest_pot_won, and both columns sit in the INCLUDE list of a covering
--    index (idx_cmds_club_date_user INCLUDE (user_id, hands_played), 16
--    scans; idx_cmds_user_stat_date INCLUDE (table_id, hands_played,
--    biggest_pot_won), 58 scans). An update that changes an indexed column is
--    never HOT, so every hand wrote a new heap tuple plus five index entries.
--    Each is replaced by the same keys without the per-hand columns
--    (idx_cmds_club_date_hot, idx_cmds_user_stat_date_hot); the club reports
--    read the same (club_id, stat_date) and (user_id, stat_date) ranges and
--    fetch hands_played from the heap. No column of either new index is ever
--    updated, so the per-hand update can be HOT.
--
-- 6. idx_chip_ledger_treasury_out, the treasury DEBIT-leg twin of
--    idx_chip_ledger_treasury_in (20261002170500), is finally built. Its two
--    concurrent builds on 2026-10-02 were cancelled by the 2-minute
--    statement_timeout of the postgres role (a concurrent build waits out
--    every older transaction twice and scans 3.7 GB twice). It was built at
--    03:33 UTC 2026-10-03 by a one-shot pg_cron job (402) whose whole
--    command is this one CREATE INDEX CONCURRENTLY statement. pg_cron
--    connects as postgres, so the job gets the role's 2 minutes; for the 22
--    seconds around its start (03:32:42-03:33:04) `ALTER ROLE postgres IN
--    DATABASE postgres SET statement_timeout = '15min'` was in force, then
--    RESET (pg_db_role_setting has no postgres/postgres row again). The
--    build took 120.3 s, most of it waiting out a 600 s money-conservation
--    cron transaction, so the 2-minute limit would have cancelled it a third
--    time. The job was unscheduled afterwards.
--
-- HOW IT WAS APPLIED. Every CONCURRENTLY statement below ran in production
-- OUTSIDE any transaction, one statement per session: the two
-- club_member_daily_stats CREATE INDEX CONCURRENTLY statements first
-- (03:04 UTC), then each DROP INDEX CONCURRENTLY IF EXISTS of step 3 below
-- as the whole command of its own one-shot pg_cron job (03:28-03:31 UTC,
-- jobs 392-401, every one succeeded in 0.1-7.6 s, all unscheduled). A
-- concurrent drop never queues an ACCESS EXCLUSIVE lock on the table, so no
-- hand, commission or telemetry write waited on it. The transaction below
-- therefore finds those indexes already gone; its DROP INDEX IF EXISTS
-- statements are the replay form for a database that has not run the
-- concurrent drops, bounded by lock_timeout. It asserts the end state either
-- way.
--
-- @live-proof: to_regclass('public.idx_agent_commissions_club_id') IS NULL AND to_regclass('public.idx_agent_commissions_user') IS NULL AND to_regclass('public.agent_commissions_unsettled_idx') IS NULL
-- @live-proof: to_regclass('public.ca_horse_fleet_state_state_idx') IS NULL AND to_regclass('public.ca_horse_fleet_state_club_idx') IS NULL AND to_regclass('public.ca_horse_fleet_state_stuck_idx') IS NULL
-- @live-proof: to_regclass('public.horse_mind_pairs_updated_at_idx') IS NULL AND to_regclass('public.idx_ca_hand_facts_allin') IS NULL
-- @live-proof: to_regclass('public.idx_cmds_club_date_user') IS NULL AND to_regclass('public.idx_cmds_user_stat_date') IS NULL
-- @live-proof: (SELECT bool_and(indisvalid AND indisready AND indislive) AND count(*) = 3 FROM pg_index WHERE indexrelid IN (to_regclass('public.idx_cmds_club_date_hot'), to_regclass('public.idx_cmds_user_stat_date_hot'), to_regclass('public.idx_chip_ledger_treasury_out')))
-- ===========================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cmds_club_date_hot
  ON public.club_member_daily_stats (club_id, stat_date) INCLUDE (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cmds_user_stat_date_hot
  ON public.club_member_daily_stats (user_id, stat_date DESC) INCLUDE (table_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_treasury_out
  ON public.chip_ledger (from_entity_id, created_at) INCLUDE (amount)
  WHERE from_type = 'club_treasury' AND from_entity_id IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The replacements and the covering indexes exist and are valid BEFORE
--    anything is dropped. An INVALID leftover of a cancelled concurrent build
--    is refused by name.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.idx_cmds_club_date_hot',             'public.club_member_daily_stats',
       'CREATE INDEX idx_cmds_club_date_hot ON public.club_member_daily_stats USING btree (club_id, stat_date) INCLUDE (user_id)'),
      ('public.idx_cmds_user_stat_date_hot',        'public.club_member_daily_stats',
       'CREATE INDEX idx_cmds_user_stat_date_hot ON public.club_member_daily_stats USING btree (user_id, stat_date DESC) INCLUDE (table_id)'),
      ('public.idx_chip_ledger_treasury_out',       'public.chip_ledger',
       'CREATE INDEX idx_chip_ledger_treasury_out ON public.chip_ledger USING btree (from_entity_id, created_at) INCLUDE (amount) WHERE ((from_type = ''club_treasury''::text) AND (from_entity_id IS NOT NULL))'),
      ('public.idx_agent_commissions_club_created', 'public.agent_commissions',
       'CREATE INDEX idx_agent_commissions_club_created ON public.agent_commissions USING btree (club_id, created_at) INCLUDE (user_id, amount, settled_at)'),
      ('public.agent_commissions_user_recent_idx',  'public.agent_commissions',
       'CREATE INDEX agent_commissions_user_recent_idx ON public.agent_commissions USING btree (user_id, created_at DESC)'),
      ('public.agent_commissions_open_idx',         'public.agent_commissions',
       'CREATE INDEX agent_commissions_open_idx ON public.agent_commissions USING btree (club_id, user_id, created_at) INCLUDE (amount, id) WHERE (settled_at IS NULL)'),
      ('public.idx_ca_hand_facts_user_time',        'public.ca_hand_facts',
       'CREATE INDEX idx_ca_hand_facts_user_time ON public.ca_hand_facts USING btree (user_id, played_at DESC)'),
      ('public.horse_mind_pairs_opps_idx',          'public.horse_mind_pairs',
       'CREATE INDEX horse_mind_pairs_opps_idx ON public.horse_mind_pairs USING btree (opps DESC)')
    ) AS x(ix, tbl, def)
  LOOP
    IF to_regclass(r.ix) IS NULL THEN
      RAISE EXCEPTION 'write_path_indexes: % is missing; build it CONCURRENTLY first', r.ix
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = to_regclass(r.ix)
         AND i.indrelid = r.tbl::regclass
         AND i.indisvalid AND i.indisready AND i.indislive
         AND pg_get_indexdef(i.indexrelid) = r.def
    ) THEN
      RAISE EXCEPTION 'write_path_indexes: % is invalid or not the expected definition; drop the INVALID leftover CONCURRENTLY and rebuild it', r.ix
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 2. Nothing dropped below backs a constraint or enforces uniqueness.
-- ---------------------------------------------------------------------------
DO $safe$
DECLARE
  v_ix text;
BEGIN
  FOREACH v_ix IN ARRAY ARRAY[
    'public.idx_agent_commissions_club_id', 'public.idx_agent_commissions_user',
    'public.agent_commissions_unsettled_idx', 'public.ca_horse_fleet_state_state_idx',
    'public.ca_horse_fleet_state_club_idx', 'public.ca_horse_fleet_state_stuck_idx',
    'public.horse_mind_pairs_updated_at_idx', 'public.idx_ca_hand_facts_allin',
    'public.idx_cmds_club_date_user', 'public.idx_cmds_user_stat_date']
  LOOP
    IF to_regclass(v_ix) IS NOT NULL AND (
         EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass(v_ix)
                    AND (i.indisunique OR i.indisprimary OR i.indisexclusion))
      OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = to_regclass(v_ix))) THEN
      RAISE EXCEPTION 'write_path_indexes: % backs a constraint or is unique; refusing to drop it', v_ix
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$safe$;

-- ---------------------------------------------------------------------------
-- 3. The drops. In production each was DROP INDEX CONCURRENTLY IF EXISTS,
--    run alone outside this transaction (see the header); here they are
--    no-ops there and the bounded replay form anywhere else.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_agent_commissions_club_id;
DROP INDEX IF EXISTS public.idx_agent_commissions_user;
DROP INDEX IF EXISTS public.agent_commissions_unsettled_idx;
DROP INDEX IF EXISTS public.ca_horse_fleet_state_state_idx;
DROP INDEX IF EXISTS public.ca_horse_fleet_state_club_idx;
DROP INDEX IF EXISTS public.ca_horse_fleet_state_stuck_idx;
DROP INDEX IF EXISTS public.horse_mind_pairs_updated_at_idx;
DROP INDEX IF EXISTS public.idx_ca_hand_facts_allin;
DROP INDEX IF EXISTS public.idx_cmds_club_date_user;
DROP INDEX IF EXISTS public.idx_cmds_user_stat_date;

-- ---------------------------------------------------------------------------
-- 4. End state: the ten are gone, and no column of any remaining
--    club_member_daily_stats index is one the per-hand upsert changes.
-- ---------------------------------------------------------------------------
DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'public.idx_agent_commissions_club_id', 'public.idx_agent_commissions_user',
      'public.agent_commissions_unsettled_idx', 'public.ca_horse_fleet_state_state_idx',
      'public.ca_horse_fleet_state_club_idx', 'public.ca_horse_fleet_state_stuck_idx',
      'public.horse_mind_pairs_updated_at_idx', 'public.idx_ca_hand_facts_allin',
      'public.idx_cmds_club_date_user', 'public.idx_cmds_user_stat_date']) AS t(ix)
     WHERE to_regclass(t.ix) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'write_path_indexes: an index that should be gone is still present'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = 'public.club_member_daily_stats'::regclass
       AND a.attname IN ('hands_played', 'hands_attributed', 'hands_won', 'total_won',
                         'profit', 'biggest_pot_won', 'biggest_pot', 'topup_total',
                         'updated_at')
  ) THEN
    RAISE EXCEPTION 'write_path_indexes: a club_member_daily_stats index still carries a per-hand column'
      USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
