-- fn_money_check_health says fn_uncollected_entry_check is expected every 60
-- minutes and has never run once. It has never run because nothing ever asked
-- it to: the function exists, it is registered as expected, and there is no
-- cron entry for it anywhere.
--
-- This is the fifth instance of the same class tonight. A check that is
-- registered but unscheduled is worse than one that does not exist, because
-- its silence reads as "nothing is wrong" on the board.
--
-- Offset to :47 so it does not land on the same minute as the four scheduled
-- in the_money_checks_that_had_never_run_once, which already share the hour.

SELECT cron.schedule(
  'ca-uncollected-entry-check-hourly',
  '47 * * * *',
  $cron$ SELECT public.fn_uncollected_entry_check(60); $cron$
);
