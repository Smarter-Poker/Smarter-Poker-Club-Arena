-- The deep-stack commitment detector needs a driver, or "tagged automatically
-- going forward" is not true. pg_cron rather than the engine's adaptive
-- journal loop: this sweep is pure DB measurement, it writes only its own
-- tables, and the engine ships only through the announced :55 maintenance
-- break - a detector should not wait on an engine cutover to start measuring.
--
-- Three ticks an hour is ample headroom: a full day of candidate hands takes
-- two to four batches of 256. The step function already holds its own
-- transaction-scoped advisory lock, so two ticks can never overlap, and a
-- tick that finds nothing to do returns 'idle' and costs one index lookup.
-- Minutes are off the hour so this never piles onto the :00 cron crowd.
SELECT cron.schedule(
  'horse-stackoff-audit-20m',
  '7,27,47 * * * *',
  $job$SELECT public.fn_horse_stackoff_audit_step();$job$
);