-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827214249; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The guard added minutes earlier did not fire. It was declared SECURITY
-- DEFINER, so `current_user` INSIDE the trigger resolved to the function's
-- owner (postgres) rather than the role performing the write — the test
-- always took the "not a browser role" early return. Proven by probe: as
-- `authenticated` holding that member's own JWT, chip_balance went
-- 5,000.00 -> 900,000,000.00 with the trigger installed.
--
-- SECURITY INVOKER is what this guard needs: current_user then reflects the
-- real execution context — 'authenticated'/'anon' for a PostgREST write, the
-- owner inside a SECURITY DEFINER money RPC, 'service_role' for the engine.

CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_changed text;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'club_members' THEN
    IF NEW.chip_balance  IS DISTINCT FROM OLD.chip_balance  THEN v_changed := 'chip_balance';
    ELSIF NEW.held_chips IS DISTINCT FROM OLD.held_chips    THEN v_changed := 'held_chips';
    ELSIF NEW.locked_chips IS DISTINCT FROM OLD.locked_chips THEN v_changed := 'locked_chips';
    ELSIF NEW.promo_balance IS DISTINCT FROM OLD.promo_balance THEN v_changed := 'promo_balance';
    END IF;
  ELSIF TG_TABLE_NAME = 'clubs' THEN
    IF NEW.chip_treasury IS DISTINCT FROM OLD.chip_treasury THEN v_changed := 'chip_treasury';
    ELSIF NEW.chip_pool  IS DISTINCT FROM OLD.chip_pool     THEN v_changed := 'chip_pool';
    END IF;
  END IF;

  IF v_changed IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    TG_TABLE_NAME, v_changed
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.chip_balance, 0) <> 0 OR COALESCE(NEW.promo_balance, 0) <> 0
     OR COALESCE(NEW.held_chips, 0) <> 0 OR COALESCE(NEW.locked_chips, 0) <> 0 THEN
    RAISE EXCEPTION 'A membership created from the browser must start with zero chips.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$fn$;
