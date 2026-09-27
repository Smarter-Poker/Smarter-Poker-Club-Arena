-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260510162957 "home_games_dan_full_access_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 36415366fa1e9d153df3f4cfa10fb50b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug-fix 2026-05-10 (home games scope): Dan Bekavac
-- Two-identity reconciliation so "Host A Home Game" works end-to-end for Dan's
-- current (yahoo) login.
--
-- Background:
--   Dan has two auth.users rows:
--     A) 47965354-...  daniel@bekavactrading.com  (legacy Stripe billing, ~Jan 12)
--     B) 9b027798-...  danimal5022@yahoo.com      (current app login,  ~Jan 26)
--   commander_staff bridges them via user_id=B linked_user_id=A, role=owner@1996.
--   But clubs.owner_id and commander_subscriptions.owner_id were both bound to
--   identity A only, so any /api/commander/check-access query that filters by
--   owner_id=user.id (where user.id is B from session) returns hasAccess:false,
--   misrouting Dan to commander.smarter.poker/commander/register on every click.
--
-- Fix (additive, non-destructive):
--   1) Complete Dan's home-games attestation set so fn_get_home_games_onboarding_status
--      returns onboarded:true.
--   2) Mirror the JAQK subscription under identity B so an owner_id=B query finds it.
--      Identity A's row is preserved unchanged — both logins continue to work.

-- ──────────────────────────────────────────────────────────────────────────
-- Part 1: Profile attestations (home-games onboarding gate)
-- ──────────────────────────────────────────────────────────────────────────
UPDATE public.profiles
SET
  over_18_attested_at         = COALESCE(over_18_attested_at, now()),
  jurisdiction_country        = COALESCE(jurisdiction_country, 'US'),
  jurisdiction_region         = COALESCE(jurisdiction_region, 'NV'),  -- JAQK is in NV
  jurisdiction_acknowledged_at= COALESCE(jurisdiction_acknowledged_at, now())
WHERE id = '9b027798-9532-403f-a5c1-15554ce2959c';

-- ──────────────────────────────────────────────────────────────────────────
-- Part 2: TOS acceptances at current published versions (1.0)
-- Idempotent: only insert if missing.
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.user_tos_acceptances (user_id, policy_key, policy_version, accepted_at)
SELECT '9b027798-9532-403f-a5c1-15554ce2959c'::uuid, p.policy_key, '1.0', now()
FROM (VALUES
  ('home_games.tos'),
  ('home_games.privacy'),
  ('home_games.community_guidelines'),
  ('home_games.money_policy')
) AS p(policy_key)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_tos_acceptances ut
  WHERE ut.user_id = '9b027798-9532-403f-a5c1-15554ce2959c'::uuid
    AND ut.policy_key = p.policy_key
    AND ut.policy_version = '1.0'
);

-- ──────────────────────────────────────────────────────────────────────────
-- Part 3: Mirror commander_subscriptions row under Dan's yahoo UUID.
-- Same venue (1996/JAQK), same tier (club), same features.
-- Idempotent: only inserts if no row exists for this owner_id+venue_id pair.
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.commander_subscriptions (
  venue_id, owner_id, tier, status, monthly_price,
  billing_email, billing_name, billing_address,
  max_tables, max_staff, max_sms_per_month, sms_used_this_month,
  features, created_at, updated_at
)
SELECT
  1996,
  '9b027798-9532-403f-a5c1-15554ce2959c'::uuid,  -- Dan's yahoo UUID
  'club', 'active', 0.00,
  'danimal5022@yahoo.com', 'Danimal Bekavac',
  jsonb_build_object('city', 'Louisville', 'state', 'KY', 'country', 'US'),
  999, 999, 99999, 0,
  jsonb_build_object(
    'comps', true, 'kiosk', true, 'dealers', true, 'reports', true,
    'waitlist', true, 'club_page', true, 'floor_map', true, 'promotions', true,
    'tournaments', true, 'tv_displays', true, 'members_free', true,
    'time_billing', true, 'staff_schedule', true, 'basic_analytics', true,
    'membership_plans', true, 'paid_memberships', true, 'advanced_analytics', true
  ),
  now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.commander_subscriptions
  WHERE owner_id = '9b027798-9532-403f-a5c1-15554ce2959c'::uuid
    AND venue_id = 1996
);

-- ──────────────────────────────────────────────────────────────────────────
-- Comment for audit trail
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_catalog.set_config('audit.note',
    'Migration home_games_dan_full_access_fix applied 2026-05-10: Dan Bekavac yahoo identity now has matching commander_subscriptions and home-games onboarding state to mirror his bekavactrading identity. Restores Host-A-Home-Game button flow.',
    true);
END$$;
