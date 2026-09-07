-- 20260907053124_every_bbj_foreign_key_can_be_followed_backwards.sql
--
-- Named for the version the Supabase MCP recorded when it applied this.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  EVERY BBJ FOREIGN KEY CAN BE FOLLOWED BACKWARDS
--  Found in the phase-4 deep dive
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED. `bbj_drill_arms` (phase 4.1) shipped a foreign key into
-- `public.clubs` with no plain index on it, and the club-deletability guard
-- refused CI on EVERY open pull request in the repo - including a docs-only
-- one and other agents' work - because that guard reads the LIVE schema rather
-- than the diff. Somebody else added `idx_bbj_drill_arms_club_id_fk` to unblock
-- the queue (20260907052937).
--
-- THAT IS THE SECOND TIME. `bbj_threshold_crossings` (phase 3.4) did the same
-- thing a few hours earlier and was fixed by another agent in
-- `20260907001323_a_club_stays_deletable_with_the_bbj_crossings_beside_it`.
-- Twice is a pattern, not an accident, and the pattern is mine: I have been
-- adding indexes for the queries I could picture and forgetting the one the
-- DATABASE runs on my behalf - the reverse lookup a DELETE on the parent has
-- to do before it can remove a row.
--
-- WHY IT MATTERS, in the guard's own words: an unindexed foreign key into
-- `clubs` makes `DELETE FROM clubs` a sequential scan, the retirement RPC runs
-- inside a PostgREST request that is cancelled after a few seconds, and when it
-- is cancelled a certification fixture and its 100,000 chips stay in Club
-- Arena. That has already happened once.
--
-- THIS MIGRATION CLOSES THE TWO THE GUARD CANNOT SEE, both also mine:
--
--   bbj_drill_arms.table_id        -> tables       (phase 4.1)
--   bbj_unclaimed_shares.payout_id -> bbj_payouts  (phase 2.3)
--
-- The guard only polices foreign keys into `clubs`, so these two would have sat
-- there indefinitely. `bbj_drill_arms` already has a UNIQUE index on
-- `table_id`, but it is PARTIAL (`WHERE fired_at IS NULL`) and a foreign-key
-- check must find the rows the predicate hides - the guard says so explicitly
-- about exactly this case. A plain one goes beside it.
--
-- Both tables are small today (0 rows and 0 rows), so these build instantly. If
-- either grows, build CONCURRENTLY against production first and let the
-- IF NOT EXISTS statement be the no-op that records it.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_bbj_drill_arms_table_id_fk;
--   DROP INDEX IF EXISTS public.idx_bbj_unclaimed_shares_payout_id_fk;

BEGIN;

CREATE INDEX IF NOT EXISTS idx_bbj_drill_arms_table_id_fk
  ON public.bbj_drill_arms (table_id);

CREATE INDEX IF NOT EXISTS idx_bbj_unclaimed_shares_payout_id_fk
  ON public.bbj_unclaimed_shares (payout_id);

DO $$
DECLARE v_bad text;
BEGIN
  /* Assert the general rule for every BBJ table this programme created, not
     just the two being fixed - so a third one cannot ship without this failing
     here first. A PARTIAL index does not count. */
  SELECT string_agg(child || '.' || col || ' -> ' || parent, ', ')
    INTO v_bad
    FROM (
      SELECT c.conrelid::regclass::text AS child,
             a.attname                  AS col,
             c.confrelid::regclass::text AS parent
        FROM pg_constraint c
        JOIN LATERAL unnest(c.conkey) k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND c.conrelid::regclass::text IN
             ('bbj_drill_arms', 'bbj_notify_thresholds',
              'bbj_threshold_crossings', 'bbj_unclaimed_shares')
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND i.indpred IS NULL
              AND i.indkey[0] = k.attnum
         )
    ) missing;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a BBJ foreign key still cannot be followed backwards: %', v_bad;
  END IF;
END $$;

COMMIT;
