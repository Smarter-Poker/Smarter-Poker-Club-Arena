-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815203853 "rename_increment_club_chip_pool_naming_trap"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dbebeda3c9a92eb6ab00aa9224c3a845 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Kill the naming trap: increment_club_chip_pool writes chip_TREASURY
-- ═══════════════════════════════════════════════════════════════════════════
-- `increment_club_chip_pool(club, amount)` updates clubs.chip_treasury and
-- clubs.total_rake. It does NOT touch clubs.chip_pool. The two are different
-- ledgers by design:
--     chip_treasury = the club's OPERATIONAL BANK (rake income, credited per hand)
--     chip_pool     = the MINT-AND-DISTRIBUTE chip inventory
-- The misleading name already cost real time: on 2026-08-15 it led to the two
-- columns being read as duplicates and 174.89 of rake income being folded into
-- the mint ledger (caught and reversed exactly the same day, no money lost).
--
-- Fix without breaking the running engine: introduce the honestly-named
-- `credit_club_rake_to_treasury`, and leave `increment_club_chip_pool` as a thin
-- deprecated delegate so the deployed Hetzner engine keeps working untouched.
-- New code must call the new name; the old one can be retired once
-- server/src/services/supabase/rake.ts is repointed and deployed.

CREATE OR REPLACE FUNCTION public.credit_club_rake_to_treasury(
  p_club_id uuid,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RETURN;
  END IF;

  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
         total_rake    = COALESCE(total_rake, 0) + p_amount,
         updated_at    = now()
   WHERE id = p_club_id;
END;
$function$;

COMMENT ON FUNCTION public.credit_club_rake_to_treasury(uuid, numeric) IS
  'Credits a standalone club''s OPERATIONAL BANK (clubs.chip_treasury) and total_rake with collected rake. Does NOT touch clubs.chip_pool, which is the separate mint-and-distribute inventory. Replaces the misleadingly named increment_club_chip_pool.';

-- Deprecated delegate — identical behaviour, kept so the deployed engine
-- (server/src/services/supabase/rake.ts) continues to work unmodified.
CREATE OR REPLACE FUNCTION public.increment_club_chip_pool(
  p_club_id uuid,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- DEPRECATED 2026-08-15: the name is a lie. This writes chip_TREASURY, not
  -- chip_pool. Call credit_club_rake_to_treasury() instead.
  PERFORM credit_club_rake_to_treasury(p_club_id, p_amount);
END;
$function$;

COMMENT ON FUNCTION public.increment_club_chip_pool(uuid, numeric) IS
  'DEPRECATED 2026-08-15 — misleading name: it credits clubs.chip_treasury (operational bank), NOT clubs.chip_pool. Delegates to credit_club_rake_to_treasury. Do not use in new code.';
