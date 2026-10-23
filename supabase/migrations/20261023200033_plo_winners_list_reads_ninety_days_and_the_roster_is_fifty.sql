-- 20261023200033_plo_winners_list_reads_ninety_days_and_the_roster_is_fifty.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-23 14:57 CDT: "ALLOW MORE HORSES INTO THE GAME, BUT ONLY THE
-- WINNING ONES." Earlier the same day: keep 35-50 horses at cash, and only
-- horses shown to be profitable at PLO play PLO.
--
-- The PLO list read 30 days and needed 5,000 PLO hands at 1 bb/100: 8 to 11
-- horses, too few to fill a PLO board of 36 tables. The same 1 bb/100 bar over
-- the full record (90 days; the nets begin 2026-08-26) with 2,000 PLO hands
-- admits 31 proven PLO winners. The cash roster is the 50-horse ceiling Dan
-- set rather than the floor-sized 43.
--
-- Applied at 20:05 UTC as a job command change (cron.alter_job, not DDL) and
-- one refresh with these arguments: 50 active, 31 on the PLO list. Recorded
-- here so a rebuild carries it. The PLO list was then released from 91
-- pending tournament bookings through fn_ca_unregister_tournament_player_exact
-- (full refunds; satellite-won entries kept), as at 17:57 UTC for the first
-- list.
--
-- No DDL: cron.alter_job writes cron.job, which fires no schema reload.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'ca-horse-roster-refresh'),
  command := 'select public.fn_ca_horse_roster_refresh(50, 5000, 2000, 1.0, 90)'
);
