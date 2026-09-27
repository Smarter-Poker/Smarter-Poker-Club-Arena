-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820182709 "clear_stale_on_break_on_completed"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 09339b99c2cfdddd11d63a6d42b0b164 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20: clear the stale break flags on already-COMPLETED tournaments.
--
-- endBreak() resets on_break/break_ends_at and never runs if the event
-- finishes DURING a break, so three COMPLETED tournaments were left flagged
-- on_break = true (one reading 1,231 minutes "on break").
--
-- Nothing resumes a COMPLETED event, so play was never affected -- verified
-- that 0 RUNNING tournaments were stuck on a break -- but a finished
-- tournament that reads as stuck is a false signal that costs someone an
-- investigation later.
--
-- The engine no longer creates these (the COMPLETING -> COMPLETED transition
-- clears both flags as of Club Arena 6901125ff); this cleans up the rows that
-- already exist. Scoped to COMPLETED/CANCELLED only, so a genuinely running
-- break is never disturbed.
UPDATE tournaments
   SET on_break = false,
       break_ends_at = NULL
 WHERE status IN ('COMPLETED', 'CANCELLED')
   AND on_break IS TRUE;
