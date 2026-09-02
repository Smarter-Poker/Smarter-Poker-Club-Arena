-- Applied to production 2026-09-02 17:32 UTC. Part 2 of 2.
--
-- WHY THE NAME BEGINS zzz. Postgres fires BEFORE triggers in alphabetical
-- order. fn_ca_fund_overlay_on_lock is attached as zz_ca_fund_overlay_on_lock
-- and is the trigger that overwrote the ladder on 2026-09-02, so this one has
-- to sort AFTER it to correct what it writes. Renaming either without checking
-- the other re-opens the hole this closes.
--
-- WHY A LOCK TIMEOUT. Attaching a trigger takes an AccessExclusiveLock on
-- `tournaments`, one of the hottest tables here - the first attempt deadlocked
-- against live play. Failing fast and being re-run is correct; blocking the
-- table while spins are starting is not.
SET LOCAL lock_timeout = '4s';

DROP TRIGGER IF EXISTS zzz_spin_ladder_is_the_drawn_one ON public.tournaments;
CREATE TRIGGER zzz_spin_ladder_is_the_drawn_one
  BEFORE INSERT OR UPDATE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_spin_ladder_is_the_drawn_one();
