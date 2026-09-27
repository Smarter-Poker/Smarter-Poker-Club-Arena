-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260806170248 "commander_marketplace_request_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a3f7362f46e8743a689255bb13f2d969 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Additive: venue-facing request records for the Commander Marketplace.
-- Listing tables (commander_dealer_marketplace / commander_equipment_rentals)
-- hold LISTINGS only; these tables hold the pending requests a venue creates.

CREATE TABLE IF NOT EXISTS public.commander_dealer_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id integer,
  dealer_marketplace_id uuid,
  dealer_name text,
  requested_date date,
  hours numeric,
  hourly_rate numeric,
  total numeric,
  status text DEFAULT 'requested',
  notes text,
  requested_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commander_equipment_rental_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id integer,
  equipment_id uuid,
  equipment_name text,
  rental_type text,
  start_date date,
  end_date date,
  quantity integer DEFAULT 1,
  daily_rate numeric,
  total numeric,
  deposit numeric,
  status text DEFAULT 'requested',
  notes text,
  requested_by uuid,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.commander_dealer_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commander_equipment_rental_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_commander_dealer_bookings ON public.commander_dealer_bookings;
CREATE POLICY service_role_all_commander_dealer_bookings
  ON public.commander_dealer_bookings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all_commander_equipment_rental_orders ON public.commander_equipment_rental_orders;
CREATE POLICY service_role_all_commander_equipment_rental_orders
  ON public.commander_equipment_rental_orders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
