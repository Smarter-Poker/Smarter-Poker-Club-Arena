-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829021334; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- One ACTIVE waitlist entry per player per table.
--
-- WaitlistService reads the existing entry with `.maybeSingle()` and discards
-- the error, then inserts if it saw nothing. That is the same shape that grew
-- 33,309 duplicate rows in training_user_achievements, and table_waitlist had
-- no unique constraint to stop it either.
--
-- The constraint is PARTIAL and that is the whole point. This table keeps
-- history: 'cleared', 'seated', 'left' and 'expired' are terminal states, and
-- a player who joins, is seated, leaves and rejoins SHOULD have several rows
-- for the same (table_id, user_id). Only being in the queue twice AT ONCE is
-- wrong, because each live row is a separate place in line.
--
-- Verified before applying: zero (table_id, user_id) pairs currently hold more
-- than one 'waiting' row, so this locks in a state the data already satisfies
-- rather than forcing a cleanup.
--
-- ROLLBACK: DROP INDEX IF EXISTS public.table_waitlist_one_active_per_player_uidx;

DO $$
DECLARE v_dupes bigint;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.table_waitlist
     WHERE status = 'waiting'
     GROUP BY table_id, user_id HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'refusing to add the index: % (table_id, user_id) pair(s) already hold more than one waiting row', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS table_waitlist_one_active_per_player_uidx
  ON public.table_waitlist (table_id, user_id)
  WHERE status = 'waiting';

COMMENT ON INDEX public.table_waitlist_one_active_per_player_uidx IS
  'A player holds at most one live place in a table queue. Partial by design: terminal rows (cleared/seated/left/expired) are history and may repeat. Added 2026-08-29.';
