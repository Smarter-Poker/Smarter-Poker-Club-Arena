-- ═══════════════════════════════════════════════════════════════════════════
--  A NO-OP UPDATE IS NOT A FAILED WRITE, BUT THAT IS WHAT THIS TRIGGER TOLD
--  THE SETTLEMENT FUNCTION - FOR THIRTEEN HOURS
-- ═══════════════════════════════════════════════════════════════════════════
--
--   2026-09-03 21:30:32.450934+00   aaa_skip_noop_update installed on
--                                   table_seats (no migration, straight to
--                                   production)
--   2026-09-03 21:30:33.096824+00   the first "seat write failed ... hand
--                                   write rejected whole" settlement failure
--
-- 0.65 seconds apart.
--
-- Hand settlement failure rate, by hour:
--
--     18:00  0.1%      21:00  19.1%     00:00  44.2%     06:00  36.1%
--     19:00  0.2%      22:00  38.5%     01:00  38.5%     08:00  27.4%
--     20:00  0.0%      23:00  40.2%     02:00  29.6%     10:00  25.0%
--
-- 139,153 hands did not settle - between a quarter and nearly half of every
-- hand dealt on the platform - and nothing raised an alert.
--
-- THE MECHANISM, proven in a transaction that rolled itself back (11.5 - no
-- chips were spent to learn this):
--
--     UPDATE public.table_seats SET stack = stack WHERE id = <a live seat>;
--     -> rows_affected = 0
--     -> ca_noop_update_stats.suppressed 340086 -> 340087
--
-- The trigger returns NULL when NEW IS NOT DISTINCT FROM OLD, which CANCELS
-- the update. It is named `aaa_` so it fires before every other BEFORE trigger
-- on the table. fn_ca_settle_hand_stacks_absolute writes each seat's absolute
-- stack and checks the write landed; a seat whose stack was already correct
-- now reported zero rows, and the function - correctly, by its own contract -
-- refused the WHOLE hand rather than settle part of it.
--
-- The settlement function is not the bug. Refusing a hand whose seat write did
-- not land is exactly what it should do, and it is why no chips were lost
-- across all 139,153 failures. The trigger is what lied to it.
--
-- WHAT IT WAS FOR. 340,086 suppressed row versions in thirteen hours, about
-- 26k an hour of avoided WAL. It bought that by breaking a third of all hand
-- settlements. There is no version of this trade worth making.
--
-- WHY A REVERT AND NOT A FIX. The platform ran without this trigger for its
-- entire life until thirteen hours ago. Removing it returns the database to a
-- state known to work and touches no money path. Making the settlement
-- function tolerate a zero-row seat write is the more interesting engineering
-- answer and is deliberately NOT done here: it edits the function that writes
-- player chip stacks, to fix a problem that stops existing the moment this
-- trigger is gone.
--
-- The function and its counter table are LEFT IN PLACE: ca_noop_update_stats
-- holds the evidence, and the function is harmless attached to nothing. The
-- COMMENT is there so the next person to find it does not re-attach it.
--
-- ROLLBACK (do not - read the numbers above first)
--
--   CREATE TRIGGER aaa_skip_noop_update BEFORE UPDATE ON public.table_seats
--     FOR EACH ROW EXECUTE FUNCTION fn_skip_noop_update();
-- ═══════════════════════════════════════════════════════════════════════════

-- Fail fast rather than queue behind a long transaction: table_seats is one of
-- the hottest tables here and DROP TRIGGER needs ACCESS EXCLUSIVE. Waiting for
-- that lock would block every seat write on the platform behind us.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS aaa_skip_noop_update ON public.table_seats;

COMMENT ON FUNCTION public.fn_skip_noop_update() IS
  'DO NOT ATTACH THIS TO table_seats. It was attached there without a migration on 2026-09-03 21:30:32 and the first hand-settlement failure followed 0.65 seconds later; 139,153 hands - 25% to 44% of every hand dealt - failed to settle over the next thirteen hours. Cancelling a no-op UPDATE makes the caller see zero rows affected, and fn_ca_settle_hand_stacks_absolute treats a seat write that did not land as a failure and refuses the whole hand. It saved ~26k redundant row versions an hour and cost a third of all settlements. Detached 2026-09-04.';

DO $$
DECLARE
  v_still int;
BEGIN
  SELECT count(*) INTO v_still
  FROM pg_trigger
  WHERE tgrelid = 'public.table_seats'::regclass
    AND tgname = 'aaa_skip_noop_update'
    AND NOT tgisinternal;

  IF v_still <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: aaa_skip_noop_update is still attached to table_seats';
  END IF;
END $$;
