-- Prevention for the 8.00 that sat outside the reserve for three hours.
-- DDL on `tournaments` takes AccessExclusiveLock and contends with the
-- realtime.subscription rebuild, which has deadlocked me repeatedly tonight.
-- lock_timeout makes this fail fast and retryable rather than picked as a
-- deadlock victim after holding the table.
SET LOCAL lock_timeout = '20s';

DROP TRIGGER IF EXISTS zz_ca_spin_cancel_returns_draw ON public.tournaments;
CREATE TRIGGER zz_ca_spin_cancel_returns_draw
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status IN ('CANCELLED','CANCELED'))
  EXECUTE FUNCTION public.fn_ca_spin_cancel_returns_draw();
