-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225833 "club_shop_inventory_one_owned_copy"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8617c98ea4843e6fccfea44b288ed66a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Enforce "at most ONE unredeemed copy per user per item" in the schema.
--
-- WHY: /api/club-arena/marketplace-purchase checked this with a SELECT and then
-- acted on the result — a classic TOCTOU. The client mints a fresh
-- X-Idempotency-Key per click, so the idempotency cache never de-duped a real
-- double-buy: two tabs both passed the read, both debited chips, both inserted.
-- Nothing in the schema stopped it (uq_shop_purchase_per_buyer was deliberately
-- dropped so consumables could be re-bought; club_shop_inventory is unique only
-- on purchase_id).
--
-- An advisory lock cannot fix this from the API layer: each PostgREST RPC runs
-- in its own transaction, so pg_advisory_xact_lock would release before the
-- follow-up statements ran. The invariant belongs in the database.
--
-- Partial unique index: only 'owned' rows are constrained, so redeemed history
-- accumulates freely and a consumable can still be re-bought after redemption.
--
-- On violation the delivery trigger (fn_deliver_shop_purchase) raises, the
-- club_shop_purchases INSERT fails, and the route's existing rollback refunds
-- the chips and releases the stock claim. The loser is made whole.
--
-- Verified: zero pre-existing duplicates.
-- Rollback: DROP INDEX public.uq_shop_inventory_owned_per_item;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_inventory_owned_per_item
  ON public.club_shop_inventory (user_id, club_id, item_id)
  WHERE status = 'owned';

-- The advisory-lock helper added moments ago cannot work across transactions.
DROP FUNCTION IF EXISTS public.fn_purchase_guard(uuid, uuid);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'club_shop_inventory'
      AND indexname = 'uq_shop_inventory_owned_per_item'
  ) THEN
    RAISE EXCEPTION 'partial unique index missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_purchase_guard') THEN
    RAISE EXCEPTION 'fn_purchase_guard should have been dropped';
  END IF;
END $$;
