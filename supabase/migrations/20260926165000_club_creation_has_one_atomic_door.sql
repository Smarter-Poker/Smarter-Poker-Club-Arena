-- CLUB CREATION HAS ONE ATOMIC DOOR.
-- A direct INSERT into clubs bypassed the rollout, membership cap, request
-- receipt, public-code allocator and owner-membership insert, while the opening
-- bank trigger still issued 100,000 chips. Creation is RPC-only. Existing
-- owner UPDATE routes remain unchanged by this migration.
-- @live-proof: (SELECT NOT has_table_privilege('anon', 'public.clubs', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.clubs', 'INSERT') AND NOT has_column_privilege('authenticated', 'public.clubs', 'chip_treasury', 'UPDATE') AND has_column_privilege('authenticated', 'public.clubs', 'name', 'UPDATE') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = 'public.clubs'::regclass AND p.polcmd = 'a'))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '30s';

REVOKE INSERT ON TABLE public.clubs FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "Authenticated users can create clubs" ON public.clubs;

-- Owners still edit presentation and offered game defaults under the existing
-- owner RLS policy, but no browser role may update money, union identity,
-- lifecycle, opening eligibility or other structural columns.
REVOKE UPDATE ON TABLE public.clubs FROM PUBLIC, anon, authenticated;
GRANT UPDATE (
  name, description, slug, is_public, requires_approval, gps_restricted,
  color_theme, avatar_url, logo, logo_url, banner_url, card_image_url, settings,
  tagline, lobby_message, lobby_message_updated_at,
  default_rake_percent, rake_cap, min_buyin_bb, max_buyin_bb,
  allow_straddle, allow_run_it_twice, allow_rabbit_hunt
) ON TABLE public.clubs TO authenticated;

DO $post$
BEGIN
  IF has_table_privilege('anon', 'public.clubs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.clubs', 'INSERT') THEN
    RAISE EXCEPTION 'CLUB_CREATE_DOOR_POSTCONDITION: browser role still has direct INSERT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid = 'public.clubs'::regclass
       AND p.polcmd = 'a'
  ) THEN
    RAISE EXCEPTION 'CLUB_CREATE_DOOR_POSTCONDITION: an INSERT policy still exists';
  END IF;
  IF has_column_privilege('authenticated', 'public.clubs', 'chip_treasury', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.clubs', 'chip_pool', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.clubs', 'promo_balance', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.clubs', 'insurance_balance', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.clubs', 'is_union', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.clubs', 'union_id', 'UPDATE')
     OR has_column_privilege(
          'authenticated', 'public.clubs', 'opening_checklist_started_at', 'UPDATE') THEN
    RAISE EXCEPTION 'CLUB_CREATE_DOOR_POSTCONDITION: browser role still updates protected columns';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.clubs', 'name', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.clubs', 'logo_url', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.clubs', 'settings', 'UPDATE') THEN
    RAISE EXCEPTION 'CLUB_CREATE_DOOR_POSTCONDITION: reviewed owner settings were not retained';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.fn_create_club_atomic(uuid,text,text,text,boolean,boolean,text)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'CLUB_CREATE_DOOR_POSTCONDITION: authenticated lost the atomic RPC';
  END IF;
END
$post$;

COMMIT;
