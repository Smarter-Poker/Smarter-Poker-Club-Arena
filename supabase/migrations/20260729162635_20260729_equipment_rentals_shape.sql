-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260729162635 as "20260729_equipment_rentals_shape"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Commander live-sweep batch 1 (2026-07-29): give commander_equipment_rentals the
-- shape the marketplace API already writes. The table shipped as a 7-column stub
-- (id, vendor_id, name, category, daily_rate, available, created_at) while
-- pages/api/marketplace/equipment.js POST inserts description, weekly_rate,
-- service_area, images and deposit_required -> every insert failed PGRST204, so
-- "list equipment for rent" never worked. These columns are additive and nullable,
-- so applying this does not change any existing behaviour; it only unbreaks writes.
--
-- deposit_required: modelled as a numeric deposit AMOUNT; images: jsonb array.
-- Both easily flippable if the UI means boolean / text[].

ALTER TABLE public.commander_equipment_rentals
    ADD COLUMN IF NOT EXISTS description      text,
    ADD COLUMN IF NOT EXISTS weekly_rate      numeric,
    ADD COLUMN IF NOT EXISTS service_area     text[]  NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS images           jsonb   NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS deposit_required numeric;

-- Non-negative guards on the money columns (match daily_rate expectations).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commander_equipment_rentals_weekly_rate_nonneg') THEN
        ALTER TABLE public.commander_equipment_rentals
            ADD CONSTRAINT commander_equipment_rentals_weekly_rate_nonneg
            CHECK (weekly_rate IS NULL OR weekly_rate >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commander_equipment_rentals_deposit_nonneg') THEN
        ALTER TABLE public.commander_equipment_rentals
            ADD CONSTRAINT commander_equipment_rentals_deposit_nonneg
            CHECK (deposit_required IS NULL OR deposit_required >= 0);
    END IF;
END $$;
