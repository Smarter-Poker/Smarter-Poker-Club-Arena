-- ═══════════════════════════════════════════════════════════════════════════
--  A BONUS POOL HAS ONE FLOOR, AND IT IS ZERO (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `spin_bonus_pools` carries TWO floors and Postgres ANDs them:
--
--   spin_bonus_pools_balance_check          CHECK (balance >= -500)
--   spin_bonus_pools_balance_non_negative   CHECK (balance >= 0)
--
-- The effective floor is therefore 0 and the -500 one can never bind. That
-- would be merely untidy if nothing were written against it -- but
-- `spin_pool_draw` is:
--
--   v_max_negative := -500;
--   v_actual_draw  := LEAST(p_amount, v_balance - v_max_negative);
--
-- It deliberately computes a PARTIAL draw down to -500, and the UPDATE that
-- writes that draw hits the 0 floor and raises 23514. Not a refusal it can
-- handle: an exception, thrown out of the function, aborting whatever
-- transaction the caller was in the middle of. A function written to degrade
-- gracefully into an overdraft instead detonates.
--
-- ── WHICH FLOOR IS THE REAL RULE: ZERO ─────────────────────────────────────
--
-- MEASURED 2026-08-31, read-only. Two pools exist and both are healthy:
--
--   union pool  fade0000-...-0001   balance  64,283.24   deposited 1,879,729.24
--                                   drawn 1,835,446.00   392 bonuses paid
--   club pool   2a1132b9-...ebe3    balance  20,544.80   deposited     4,015.80
--                                   drawn     3,471.00     1 bonus paid
--
-- 1,835,446 chips have been drawn out of these pools and the balance has never
-- gone below zero, because whatever is actually drawing them respects the zero
-- floor. The -500 rule has never once been the operative one.
--
-- 2. A negative pool balance is MINTED CHIPS. This platform treats chip
--    conservation as law -- tournament_chip_conservation_guard, the "no chips
--    vanished" alarm, "the opening bank is a mint" -- and nothing in treasury
--    reconciliation carries a per-club -500 float as a liability. A pool that
--    can go to -500 hands every club a 500-chip unfunded overdraft that no
--    ledger accounts for.
--
-- 3. Nothing asked for the overdraft. `spin_pool_draw` has ZERO callers: none
--    in any other database function (checked across every plpgsql/sql function
--    in `public`), and none in the repository (src/, server/, services/,
--    scripts/). It is granted only to postgres and service_role -- no browser
--    role can reach it. The -500 exists solely inside a function nobody calls.
--
-- So: the zero floor stays and the -500 CHECK is dropped.
--
-- ── WHY THE DEAD FUNCTION IS REPAIRED RATHER THAN DROPPED ──────────────────
--
-- The brief allowed dropping it. Repairing it is strictly safer and costs
-- nothing. DROP FUNCTION is irreversible against a caller this repository
-- cannot see -- an ops runbook, a psql session, a service_role script outside
-- these seven repos -- and such a caller would get "function does not exist"
-- where today it gets a working (if capped) draw. Clamping the draw at the
-- balance keeps the function's existing contract exactly: it already RETURNS 0
-- when it cannot draw, and every caller must already handle that. After this
-- change there is no input for which it raises 23514.
--
-- If Dan would rather the function simply went away, the drop is one line and
-- this migration's assertions will tell the truth either way.
--
-- ROLLBACK:
--   ALTER TABLE public.spin_bonus_pools
--     ADD CONSTRAINT spin_bonus_pools_balance_check CHECK (balance >= -500);
--   and restore v_max_negative := -500 in spin_pool_draw.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ── 1. The floor that never bound goes ─────────────────────────────────────
ALTER TABLE public.spin_bonus_pools
  DROP CONSTRAINT IF EXISTS spin_bonus_pools_balance_check;

-- ── 2. Make sure the floor that DOES bind is actually there and validated ──
DO $floor$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.spin_bonus_pools'::regclass
       AND conname  = 'spin_bonus_pools_balance_non_negative'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.spin_bonus_pools WHERE balance < 0) THEN
      RAISE EXCEPTION 'a spin bonus pool is already negative - do not add the zero floor without deciding what to do with the chips';
    END IF;
    ALTER TABLE public.spin_bonus_pools
      ADD CONSTRAINT spin_bonus_pools_balance_non_negative CHECK (balance >= 0);
  END IF;
END
$floor$;

COMMENT ON COLUMN public.spin_bonus_pools.balance IS
  'Chips held by the pool. Floor is ZERO: a negative balance would be minted chips no ledger accounts for. The old -500 overdraft CHECK was dropped 2026-09-01; it was unreachable (ANDed against this one) and only spin_pool_draw was written for it.';

-- ── 3. The draw stops trying to overdraw ───────────────────────────────────
--
-- One line changes: the floor it draws down to. Everything else -- the
-- FOR UPDATE row lock, the NOT FOUND return, the "return 0 rather than raise"
-- contract, the counters -- is preserved exactly.
CREATE OR REPLACE FUNCTION public.spin_pool_draw(p_club_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance     numeric;
  v_actual_draw numeric;
  -- Was -500. A pool may not lend chips it does not hold; see the header.
  v_floor       numeric := 0;
BEGIN
  SELECT balance INTO v_balance FROM spin_bonus_pools WHERE club_id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_actual_draw := LEAST(p_amount, v_balance - v_floor);
  IF v_actual_draw <= 0 THEN RETURN 0; END IF;

  UPDATE spin_bonus_pools
     SET balance     = balance - v_actual_draw,
         total_drawn = total_drawn + v_actual_draw,
         bonus_count = bonus_count + 1,
         updated_at  = now()
   WHERE club_id = p_club_id;

  RETURN v_actual_draw;
END;
$function$;

REVOKE ALL ON FUNCTION public.spin_pool_draw(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spin_pool_draw(uuid, numeric) TO service_role;

COMMENT ON FUNCTION public.spin_pool_draw(uuid, numeric) IS
  'Draws up to p_amount from a club spin bonus pool, clamped at a zero balance. Returns the amount actually drawn, 0 if none. Never raises on an insufficient pool.';

-- ── 4. POST-APPLY ASSERTIONS ───────────────────────────────────────────────
DO $verify$
DECLARE
  v_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.spin_bonus_pools'::regclass
                AND conname = 'spin_bonus_pools_balance_check') THEN
    RAISE EXCEPTION 'the -500 overdraft CHECK is still attached';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.spin_bonus_pools'::regclass
                    AND conname = 'spin_bonus_pools_balance_non_negative') THEN
    RAISE EXCEPTION 'the zero floor is not attached';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'spin_pool_draw';

  IF v_src LIKE '%-500%' THEN
    RAISE EXCEPTION 'spin_pool_draw still carries the -500 overdraft';
  END IF;

  -- The draw can no longer produce a balance the table would refuse.
  IF EXISTS (SELECT 1 FROM public.spin_bonus_pools WHERE balance < 0) THEN
    RAISE EXCEPTION 'a pool is negative after this migration';
  END IF;
END
$verify$;

COMMIT;
