-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812225854 "20260808270000_validate_merch_price_constraints"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1d42c9e3f64babe2d0d3363959435a50 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Validate the merchandise price/stock CHECK constraints.
--
-- All five were created NOT VALID, which enforces new writes but never
-- verified existing rows — so nobody actually knew whether the catalog already
-- contained a violating row. That matters because these constraints are the
-- last line of defence on pricing: a price_diamonds of 0 would make an item
-- FREE, and purchase-with-diamonds treats 0 as "no diamond price" and converts
-- from USD, while merch-catalog would display price_usd * 100 — the two would
-- silently disagree about what the thing costs.
--
-- VALIDATE CONSTRAINT scans the table and promotes each to fully enforced. It
-- fails loudly if any existing row violates, which is exactly what we want to
-- know. Takes only a SHARE UPDATE EXCLUSIVE lock, so it does not block reads
-- or writes on tables this small.

ALTER TABLE public.merchandise_items
    VALIDATE CONSTRAINT merchandise_items_price_diamonds_positive;
ALTER TABLE public.merchandise_items
    VALIDATE CONSTRAINT merchandise_items_price_usd_positive;
ALTER TABLE public.merchandise_items
    VALIDATE CONSTRAINT merchandise_items_stock_nonneg;
ALTER TABLE public.merchandise_item_variants
    VALIDATE CONSTRAINT merchandise_item_variants_price_positive;
ALTER TABLE public.merchandise_item_variants
    VALIDATE CONSTRAINT merchandise_item_variants_stock_nonneg;

DO $postcheck$
DECLARE
    v_unvalidated integer;
BEGIN
    SELECT COUNT(*) INTO v_unvalidated
      FROM pg_constraint
     WHERE conrelid IN ('public.merchandise_items'::regclass,
                        'public.merchandise_item_variants'::regclass)
       AND contype = 'c'
       AND NOT convalidated;

    IF v_unvalidated > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % merch constraint(s) still NOT VALID', v_unvalidated;
    END IF;
END
$postcheck$;
