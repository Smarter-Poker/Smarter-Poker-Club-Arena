-- ═══════════════════════════════════════════════════════════════════════════
-- RETIRE remove_horse - A SEAT EXIT THAT DELETES THE ROW AND REFUNDS NOTHING
-- (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `public.remove_horse` has been live and SECURITY DEFINER since
-- 008_hydra_horse_fleet.sql. Its body is:
--
--     SELECT stack INTO v_final_stack FROM table_seats ...
--     DELETE FROM table_seats WHERE table_id = ... AND user_id = ...
--
-- It reads the stack, records it on `horse_sessions` as history, and then
-- DELETES the seat. It never credits a wallet. Every chip on that seat is
-- destroyed, and the exit lands in `ca_seat_stack_exits` with no matching
-- credit for `fn_unaccounted_seat_exits` to find.
--
-- That is precisely the shape CLAUDE.md 11.5 was written about, after an agent
-- deleted two seat rows to "clean up" a probe and 48 chips left a member wallet
-- and landed nowhere: "Never DELETE a `table_seats` row to clean up. Deleting
-- one skips the refund and destroys the chips."
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). A horse pays its buy-in out of a club
-- wallet through the same RPC a human uses, so a function that ends a horse's
-- seat WITHOUT paying the stack back is not a horse convenience - it is chip
-- destruction that happens to be aimed at horses. The correct exit is the one
-- everybody else takes: `atomic_seat_cashout_locked`, which reads the stack
-- under FOR UPDATE, credits the club wallet, and stamps `left_at` in ONE
-- transaction.
--
-- NO LIVE CALLER. Verified 2026-08-31 across the whole repo: nothing invokes
-- this RPC. `server/src/**` has no reference at all;
-- `src/services/HydraService.ts` has a `removeHorse()` method, but it goes
-- through `atomic_table_cashout` and only mentions the string in an event
-- source label (`'hydra_remove_horse'`). The function is a loaded grenade
-- sitting in the public schema with EXECUTE available, not a load-bearing one.
--
-- WHY REPLACE RATHER THAN DROP. A bare DROP makes a future caller fail with
-- "function does not exist", which reads as a deploy problem and invites
-- someone to recreate it from 008. Raising instead makes the rule itself the
-- error message, at the exact moment somebody needs to read it.
--
-- TWO OVERLOADS EXIST IN THE SOURCE TREE, with the arguments in opposite
-- orders - 008_hydra_horse_fleet.sql declares (p_horse_id, p_table_id) and
-- 20260125800_missing_rpc_batch.sql declares (p_table_id, p_horse_id). Both
-- are (uuid, uuid), so Postgres cannot hold both under that signature and only
-- one is actually installed. This migration therefore drops BY SIGNATURE, which
-- retires whichever of the two production is carrying, and does not assume.
--
-- TIER 3: this changes a function that exists in production. Rollback is
-- pasted at the bottom, per the migration-safety protocol.

-- ── PRE-FLIGHT ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'remove_horse';

  IF v_n > 1 THEN
    RAISE EXCEPTION
      'pre-flight: expected at most 1 remove_horse overload, found % - inspect before retiring', v_n;
  END IF;

  RAISE NOTICE 'pre-flight: % remove_horse overload(s) present', v_n;
END $$;

-- ── RETIRE ─────────────────────────────────────────────────────────────────
-- Drop whichever argument order production carries, then install the tombstone
-- under one canonical signature.
DROP FUNCTION IF EXISTS public.remove_horse(uuid, uuid);

CREATE FUNCTION public.remove_horse(p_table_id uuid, p_horse_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION
    'retired: use atomic_seat_cashout_locked - remove_horse DELETEd the seat row and refunded nothing, destroying the stack (CLAUDE.md 11.5, 10.5). Table %, horse %.',
    p_table_id, p_horse_id;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_horse(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.remove_horse(uuid, uuid) IS
  'RETIRED TOMBSTONE 2026-08-31. The original DELETEd the table_seats row and '
  'credited nothing, destroying the seat stack. Cash a seat out with '
  'atomic_seat_cashout_locked, which credits and vacates in one locked '
  'transaction. Raises on every call; had no live caller when retired.';

-- ── POST-APPLY ASSERTIONS ──────────────────────────────────────────────────
DO $$
DECLARE
  v_n     integer;
  v_body  text;
  v_state text;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'remove_horse';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'assertion failed: expected exactly 1 remove_horse, found %', v_n;
  END IF;

  SELECT p.prosrc INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'remove_horse';

  IF v_body ILIKE '%DELETE FROM table_seats%' THEN
    RAISE EXCEPTION 'assertion failed: remove_horse still DELETEs a seat row';
  END IF;
  IF v_body NOT ILIKE '%atomic_seat_cashout_locked%' THEN
    RAISE EXCEPTION 'assertion failed: remove_horse does not name its replacement';
  END IF;

  -- It must actually refuse, not merely look retired.
  BEGIN
    PERFORM public.remove_horse(
      '00000000-0000-0000-0000-000000000000'::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid);
    RAISE EXCEPTION 'assertion failed: remove_horse returned instead of raising';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_state = MESSAGE_TEXT;
    IF v_state NOT LIKE 'retired:%' THEN
      RAISE;
    END IF;
    RAISE NOTICE 'post-apply: remove_horse refuses as expected';
  END;

  IF has_function_privilege('anon', 'public.remove_horse(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assertion failed: anon can still execute remove_horse';
  END IF;
END $$;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- Restores the 008_hydra_horse_fleet.sql definition verbatim. Note what you are
-- restoring: a seat exit that destroys the stack. Do this only to unblock a
-- caller nobody knew about, and fix that caller in the same session.
--
--   DROP FUNCTION IF EXISTS public.remove_horse(uuid, uuid);
--
--   CREATE OR REPLACE FUNCTION public.remove_horse(p_horse_id UUID, p_table_id UUID)
--   RETURNS BOOLEAN
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   AS $rollback$
--   DECLARE
--       v_final_stack INTEGER;
--   BEGIN
--       SELECT stack INTO v_final_stack FROM table_seats
--       WHERE table_id = p_table_id AND user_id = p_horse_id;
--
--       DELETE FROM table_seats WHERE table_id = p_table_id AND user_id = p_horse_id;
--
--       UPDATE horse_sessions SET
--           left_at = now(),
--           current_stack = COALESCE(v_final_stack, current_stack)
--       WHERE horse_id = p_horse_id AND table_id = p_table_id AND left_at IS NULL;
--
--       UPDATE profiles SET horse_status = 'available', updated_at = now()
--       WHERE id = p_horse_id;
--
--       RETURN TRUE;
--   END;
--   $rollback$;
