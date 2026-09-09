-- 20260909072230_the_expiry_sweep_takes_its_rows_in_order.sql
--
-- Recorded at the version production assigned (the Supabase MCP assigns its
-- own), so a rebuild does not apply it twice.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  AN UNORDERED BULK UPDATE DEADLOCKS AGAINST THE PLAYER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FOUND BY FOLLOWING A RED WORKFLOW. `Cron Health` was failing on `main` at
-- "Fail the run when a job never succeeded", and its summary named exactly one:
--
--     RAN AND NEVER SUCCEEDED - these are broken, not flaky:
--     CRITICAL daily-missions-reward-expiry   1 failed / 1 runs   7 0 * * *
--              ERROR:  deadlock detected
--
-- `fn_expire_daily_challenge_rewards()` was a single bare UPDATE across the
-- whole of `user_daily_challenges`. A bulk UPDATE takes its row locks in
-- whatever order the plan produces them, and a player claiming or completing a
-- challenge at the same moment takes ONE row - so the two can each end up
-- holding what the other is waiting for. Postgres breaks the cycle by killing
-- one of them, and the one it killed was the nightly job, every time it ran.
--
-- It had therefore never expired anything. Running it once after this fix
-- expired 954 rows.
--
-- THE FIX. `ORDER BY id` gives every caller the same acquisition order, which
-- is what makes a cycle impossible. `SKIP LOCKED` does the rest: a row a player
-- is holding right now is a row being CLAIMED, and a claimed reward must not be
-- expired out from under them. Skipping it is the correct outcome rather than a
-- compromise - if it is still unclaimed tomorrow the next run takes it, and the
-- window is a seven-day one either way.
--
-- This is not a repair job (CLAUDE.md 10.12). Its schedule IS the product: a
-- reward expires seven days after it is earned, and something has to notice the
-- day arriving.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_expire_daily_challenge_rewards()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n integer;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  -- AN UNORDERED BULK UPDATE DEADLOCKS AGAINST THE PLAYER (2026-09-09).
  --
  -- This was a single bare UPDATE over the whole table. A bulk UPDATE takes its
  -- row locks in whatever order the plan happens to produce, and a player
  -- claiming or completing a challenge at the same moment takes ONE row - so
  -- the two can each hold what the other wants. `Cron Health` had this job at
  -- 1 failed / 1 runs, "these are broken, not flaky", with:
  --
  --     ERROR:  deadlock detected
  --
  -- Ordering by primary key gives every caller the same acquisition order,
  -- which is what makes a cycle impossible. SKIP LOCKED then does the rest: a
  -- row a player is holding RIGHT NOW is a row being claimed, and a claimed
  -- reward must not be expired out from under them. Skipping it is the correct
  -- outcome, not a compromise - if it is still unclaimed tomorrow the next run
  -- takes it, and the window is a 7-day one either way.
  WITH due AS (
    SELECT id
      FROM public.user_daily_challenges
     WHERE completed AND NOT claimed AND expired_at IS NULL
       AND completed_at < now() - interval '7 days'
     ORDER BY id
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.user_daily_challenges u
     SET expired_at = now()
    FROM due
   WHERE u.id = due.id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$;

DO $proof$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_expire_daily_challenge_rewards';
  IF position('ORDER BY id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-check: the expiry sweep does not order its rows';
  END IF;
  IF position('FOR UPDATE SKIP LOCKED' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-check: the expiry sweep does not skip a row a player is holding';
  END IF;
  IF position('service_role required' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-check: the service_role guard was lost';
  END IF;
END;
$proof$;

COMMIT;
