-- THE TOURNAMENT POOLS TAKE THEIR SCALE IN THE MAINTENANCE FREEZE.
--
-- The other half of 20260906162156. That migration gave eight unconstrained
-- money columns a scale of 2; these two were in it and had to come out,
-- because a rewrite of `tournaments` cannot be slipped in beside live play:
--
--   2026-09-06 16:25:18  deadlock detected
--   Process A waits for AccessExclusiveLock on relation tournaments;
--   blocked by process B.  Process B waits for RowShareLock on auth.users;
--   blocked by process A.
--
-- Nothing was applied - the transaction rolled back whole, which is the
-- design. `tournaments` is 147 MB and every seat, every registration and
-- every finish writes it; ALTER TYPE rewrites the table under ACCESS
-- EXCLUSIVE, so at ~460 hands a minute it is competing with the platform for
-- the one lock nothing else can share.
--
-- SO IT GOES IN THE WINDOW BUILT FOR EXACTLY THIS. CLAUDE.md 13: at :53 every
-- table is told to finish its hand, at :55 the platform FREEZES - no buy-ins,
-- no chip movements, horses do not stand up or rotate - and at :00 the thaw
-- gives every in-flight deadline back the frozen minutes. Between :55 and :00
-- there is no money write to deadlock against. That is when this runs.
--
-- WHAT IT CHANGES, and it is only the storage: both columns hold whole cents
-- today (116,380 rows, zero sub-cent values, maximum 44,640.00 - five integer
-- digits against the eighteen given here). Declaring the scale means a JS
-- double handed to either one is ROUNDED on write instead of stored as its
-- full binary expansion - the way tournament_payouts came to hold
-- 55.629999999999995. No value moves; the door closes.
--
-- Both columns in ONE statement so the table is rewritten once, not twice.
-- `lock_timeout` is deliberately short: inside the freeze the lock is free
-- and the wait is nil, so anything longer means the freeze is NOT in effect
-- and the migration should abort rather than fight live play again.
--
-- RUN IT BETWEEN :55 AND :00. If it aborts on lock_timeout, that is the
-- guard telling you the platform is not frozen - check
-- `select public.fn_platform_frozen()` and try the next break, never by
-- widening the timeout.

BEGIN;

SET LOCAL lock_timeout = '4s';

ALTER TABLE public.tournaments
  ALTER COLUMN prize_pool  TYPE numeric(18,2),
  ALTER COLUMN bounty_pool TYPE numeric(18,2);

DO $verify$
DECLARE v_notscaled int; v_bad int;
BEGIN
  SELECT count(*) INTO v_notscaled FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tournaments'
     AND column_name IN ('prize_pool','bounty_pool')
     AND numeric_scale IS DISTINCT FROM 2;
  IF v_notscaled <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % tournament pool column(s) still carry no scale', v_notscaled;
  END IF;

  SELECT count(*) INTO v_bad FROM public.tournaments
   WHERE prize_pool <> round(prize_pool,2) OR bounty_pool <> round(bounty_pool,2);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % tournament row(s) hold a sub-cent pool', v_bad;
  END IF;

  /* The whole conservation set, in one place, now that both halves are in. */
  SELECT count(*) INTO v_notscaled FROM information_schema.columns
   WHERE table_schema='public' AND (table_name,column_name) IN (
     ('bomb_pot_award_units','amount'),('tournament_escrow','prize_balance'),
     ('tournament_escrow','fee_balance'),('tournament_escrow','bounty_balance'),
     ('tournament_payouts','amount'),('tournaments','prize_pool'),('tournaments','bounty_pool'),
     ('union_wallets','chip_balance'),('union_wallets','rake_wallet'),
     ('union_wallets','total_rake_collected'))
     AND numeric_scale IS DISTINCT FROM 2;
  IF v_notscaled <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % of the ten formerly-unconstrained columns is/are not scale 2', v_notscaled;
  END IF;

  RAISE NOTICE 'CHIP_SCALE_TWO_COMPLETE all ten formerly-unconstrained money columns carry scale 2';
END $verify$;

COMMIT;
