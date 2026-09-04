-- A CLUB CANNOT BE DELETED IN TIME, SO NOTHING EVER DELETED ONE.
--
-- 2026-09-03, Dan: "WE SHOULDN'T NEED THOSE DETECTORS OR WATCH DOGS IF YOU FIX
-- THIS ALL AND MAKE IT SO ITS IMPOSSIBLE TO EVER LOSE A CHIP, OR NOT HAVE EVERY
-- SINGLE CHIP ACCOUNTED FOR AND ACCOUNTABLE. THATS THE GOAL!"
--
-- Migration 20260903230339 gave the estate fn_ca_retire_certification_club and
-- the certification a cleanup step that fails loudly if a fixture survives.
-- At 23:33 UTC the certification ran on that very build and said:
--
--   PASS Custom And Placeholder Club Creation Certified For 89e03439..., 7abc31e6...
--   Fixture Cleanup Failed For 89e03439...: canceling statement due to statement timeout
--   Fixture Cleanup Failed For 7abc31e6...: canceling statement due to statement timeout
--   Error: Certification leaked 2 fixture club(s) into Club Arena
--
-- The guard was right and the cleanup was impossible. Two more fixtures and
-- 200,000 more chips stood in Club Arena an hour after the fleet was supposed
-- to have been retired for good.
--
-- WHY DELETING A CLUB TOOK LONGER THAN THE REQUEST WAS ALLOWED TO LIVE.
--
-- A DELETE from a parent table makes PostgreSQL check every foreign key that
-- references it. public.clubs has seventy of them. Each check is a lookup on the
-- child's referencing column, and a lookup with no index it can use is a
-- sequential scan of the whole child table. EXPLAIN (ANALYZE) on the delete named
-- the cost row by row:
--
--   Trigger for constraint rake_records_club_id_fkey           1287.4 ms
--   Trigger for constraint table_seats_club_id_fkey              73.8 ms
--   Trigger for constraint game_management_events (867,780 rows, no index)
--
-- rake_records and table_seats DO have an index whose first column is club_id.
-- Both are PARTIAL - `WHERE rake_amount > 0` and `WHERE left_at IS NULL` - and a
-- partial index cannot answer a foreign key check, because the check must find
-- rows the predicate excludes. An audit that asks "is there an index on this
-- column" says yes and is wrong; the question is "is there a VALID, NON-PARTIAL
-- index whose LEADING column is this one", and for seven of the seventy the
-- answer was no.
--
-- WHAT THIS FIXES, AND WHAT IT DELIBERATELY DOES NOT.
--
-- Thirteen indexes, listed below. The two large ones were built CONCURRENTLY
-- against production before this migration, at 00:26 and 00:33 UTC, because a
-- plain build takes a SHARE lock and game_management_events alone took 25
-- seconds to index - twenty-five seconds in which the engine could not write a
-- game management event. This file therefore says IF NOT EXISTS: it is a no-op
-- on production, and it is what builds them on any database restored from these
-- migrations.
--
-- Measured after: the same RPC, through the same PostgREST door, as the same
-- service_role the certification uses:
--
--   89e03439-81e0-4197-b0c7-ec406dc8e3b3  200 OK  2.43s  100,000.00 retired
--   7abc31e6-6ead-4d40-a9ee-627075d254f7  200 OK  2.58s  100,000.00 retired
--
-- clubs is back to the four estates Dan named - Club JAQK, SHARK CLUB, Midway
-- Union, Deep Stack Society - and the 200,000 chips left as two declared burns
-- to chip_retirement, which is a non-circulating store, so the supply meter reads
-- them as retired rather than as chips that went missing.
--
-- WHAT WAS TRIED AND REJECTED. The obvious fix is to give the function a bigger
-- budget: `SET statement_timeout TO '60s'` on the function itself. It does not
-- work, and I proved that before relying on it rather than after. PostgreSQL arms
-- statement_timeout when the statement starts; a SET inside the function does not
-- re-arm the timer for the statement already running. A probe function declared
-- `SET statement_timeout TO '30s'` sleeping six seconds, called under a three
-- second session timeout, was cancelled at three seconds. The only real fix is to
-- make the work fit the budget, which is what the indexes do.
--
-- The self-check at the bottom is the part that matters for the standard. It is
-- not a watchdog and it does not run on a schedule: it runs once, here, and it
-- raises if any foreign key into clubs lacks an index that can answer it. Its
-- companion, scripts/ci/check-club-fk-indexes.mjs, asks production the same
-- question on every pull request, so a new table with a club_id and no index
-- cannot reach main and quietly make club deletion impossible again.

CREATE INDEX IF NOT EXISTS idx_game_management_events_club_id
  ON public.game_management_events (club_id);
CREATE INDEX IF NOT EXISTS idx_club_join_idempotency_club_id
  ON public.club_join_idempotency (club_id);
CREATE INDEX IF NOT EXISTS idx_ad_placement_club_id
  ON public.ad_placement (club_id);
CREATE INDEX IF NOT EXISTS idx_ca_supply_snapshot_classifications_club_id
  ON public.ca_supply_snapshot_classifications (club_id);
CREATE INDEX IF NOT EXISTS idx_club_opening_setup_funding_club_id
  ON public.club_opening_setup_funding (club_id);
CREATE INDEX IF NOT EXISTS idx_club_message_dismissals_club_id
  ON public.club_message_dismissals (club_id);

CREATE INDEX IF NOT EXISTS idx_rake_records_club_id_fk
  ON public.rake_records (club_id);
CREATE INDEX IF NOT EXISTS idx_table_seats_club_id_fk
  ON public.table_seats (club_id);
CREATE INDEX IF NOT EXISTS idx_settlement_locks_club_id_fk
  ON public.settlement_locks (club_id);
CREATE INDEX IF NOT EXISTS idx_blacklists_club_id_fk
  ON public.blacklists (club_id);
CREATE INDEX IF NOT EXISTS idx_commission_rate_audit_club_id_fk
  ON public.commission_rate_audit (club_id);
CREATE INDEX IF NOT EXISTS idx_ad_advertiser_club_id_fk
  ON public.ad_advertiser (club_id);
CREATE INDEX IF NOT EXISTS idx_game_ticker_settings_club_id_fk
  ON public.game_ticker_settings (club_id);

COMMENT ON INDEX public.idx_rake_records_club_id_fk IS
  'Foreign key support for rake_records_club_id_fkey. idx_rake_records_club_created '
  'leads on club_id but is partial (WHERE rake_amount > 0), and a partial index '
  'cannot answer a foreign key check. Without this one, deleting a club '
  'sequentially scans 1.8M rows and takes 1.3 seconds of the request budget.';

COMMENT ON INDEX public.idx_table_seats_club_id_fk IS
  'Foreign key support for table_seats_club_id_fkey. idx_table_seats_club_active '
  'is partial (WHERE left_at IS NULL) and cannot answer the check.';

COMMENT ON INDEX public.idx_game_management_events_club_id IS
  'Foreign key support for game_management_events_club_id_fkey, and the index the '
  'retirement function''s own DELETE ... WHERE club_id = $1 needs. 867,780 rows.';

-- EVERY FOREIGN KEY INTO clubs CAN BE ANSWERED WITHOUT A SEQUENTIAL SCAN.
--
-- Single-column keys only: a composite key is answered by its own leading
-- column and is out of scope here. An index qualifies when it is valid, not
-- partial, and leads on the referencing column.
DO $selfcheck$
DECLARE
  v_missing text;
  v_count   integer;
BEGIN
  SELECT count(*), string_agg(child, ', ' ORDER BY child)
    INTO v_count, v_missing
    FROM (
      SELECT f.child_table || '.' || f.child_col AS child
        FROM (
          SELECT c.conrelid,
                 c.conrelid::regclass::text AS child_table,
                 a.attname                  AS child_col,
                 a.attnum
            FROM pg_constraint c
            JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.contype = 'f'
             AND c.confrelid = 'public.clubs'::regclass
             AND array_length(c.conkey, 1) = 1
        ) f
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = f.conrelid
            AND i.indisvalid
            AND i.indpred IS NULL
            AND i.indkey[0] = f.attnum
       )
    ) s;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'CLUB_FK_INDEXES: % foreign key(s) into clubs cannot be answered without a sequential scan: %. Deleting a club would time out, and a certification fixture would be stranded in Club Arena with its chips.',
      v_count, v_missing;
  END IF;

  RAISE NOTICE 'CLUB_FK_INDEXES_OK: every single-column foreign key into clubs has a valid, non-partial, leading-column index';
END
$selfcheck$;

-- AND THE ESTATE IS THE FOUR CLUBS DAN NAMED, WITH NOTHING STRANDED.
DO $estate$
DECLARE
  v_extra text;
BEGIN
  SELECT string_agg(name || ' (' || id::text || ')', ', ' ORDER BY created_at)
    INTO v_extra
    FROM public.clubs
   WHERE id NOT IN (
     'a0000000-0000-0000-0000-000000000001'::uuid,
     'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
     '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,
     'fade0000-0000-0000-0000-000000000001'::uuid
   );

  IF v_extra IS NOT NULL THEN
    -- Not an exception: a fixture standing here at migration time is a fact to
    -- report, not a reason to refuse a migration that makes it removable.
    RAISE WARNING 'CLUB_ESTATE: clubs other than the four Dan named are present: %. Retire each with SELECT public.fn_ca_retire_certification_club(id).', v_extra;
  ELSE
    RAISE NOTICE 'CLUB_ESTATE_OK: exactly the four estates - Club JAQK, SHARK CLUB, Midway Union, Deep Stack Society';
  END IF;
END
$estate$;