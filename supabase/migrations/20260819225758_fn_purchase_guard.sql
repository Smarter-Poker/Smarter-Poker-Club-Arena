-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225758 "fn_purchase_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4b7a84ef09eb0f782f3ebee9be91ea8f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_purchase_guard — serialise concurrent buys of the same item by the same
-- user for the remainder of the calling transaction.
--
-- WHY: the client mints a FRESH X-Idempotency-Key on every click
-- (services/clubArenaApi.ts), so the idempotency cache never de-dupes a real
-- double-buy. Two tabs, or two devices, both passed the "do you already own an
-- unredeemed copy?" read in /api/club-arena/marketplace-purchase and both went
-- on to debit chips and insert a purchase. Nothing in the schema stopped it:
-- uq_shop_purchase_per_buyer was deliberately dropped so consumables could be
-- re-bought, and club_shop_inventory is only unique on purchase_id.
--
-- The route calls this, then RE-READS ownership, so the second caller blocks
-- until the first finishes and then sees the inventory row it just created.
--
-- pg_advisory_xact_lock releases automatically at transaction end, so a crashed
-- request cannot wedge the item.
--
-- Rollback: DROP FUNCTION public.fn_purchase_guard(uuid, uuid);
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_purchase_guard(p_user_id uuid, p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL OR p_item_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('shop_purchase:' || p_user_id::text || ':' || p_item_id::text, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_purchase_guard(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_purchase_guard(uuid, uuid) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_purchase_guard(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_purchase_guard must not be executable by authenticated';
  END IF;
END $$;
