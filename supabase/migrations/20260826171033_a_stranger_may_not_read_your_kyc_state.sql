-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826171033; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The database half of Smarter-Poker-World-Hub#783, applied only now that
-- production is verified serving that commit (9d4574d9, confirmed via
-- /api/health at 17:09 UTC). PostgREST 403s an entire select if any requested
-- column is revoked, so this had to follow the code that stopped requesting
-- them, never precede it.
--
-- WHAT WAS WRONG: public.profiles has RLS enabled with exactly one SELECT
-- policy, `profiles_select`, scoped to `authenticated` with USING (true) --
-- every row, every column granted. `SAFE_PROFILE_COLUMNS`, the list the World
-- Hub uses to read ANOTHER user's profile (pages/hub/user/[username].js,
-- useProfilePrefetch), still named all thirteen columns below. Visiting any
-- profile page therefore served that person's KYC state, age-verification
-- state, jurisdiction and push notification token to the viewer.
--
-- The cause was drift, not a decision. The list was built as "every column
-- except phone and email", so each new sensitive column joined it by default.
--
-- CHECKED BEFORE APPLYING: no client select in either repo names any of the
-- thirteen, none does select('*') on profiles (the only occurrence is inside a
-- doc comment in src/lib/requestDedup.js), and no client writes them -- every
-- write is a server route on the service role, which a revoke on
-- `authenticated` does not touch.
--
-- DELIBERATELY NOT REVOKED: birthday and birth_year. Fourteen client files
-- reference them and that looks like a real feature. Whether a stranger should
-- see a date of birth is a product decision, not an agent's.
--
-- ROLLBACK:
--   GRANT SELECT (kyc_status, kyc_provider, kyc_inquiry_id, kyc_completed_at,
--                 kyc_rejection_reason, age_verified, age_verified_at,
--                 over_18_attested_at, jurisdiction_country, jurisdiction_region,
--                 jurisdiction_acknowledged_at, mfa_required, notification_token)
--     ON public.profiles TO authenticated;

REVOKE SELECT (
  kyc_status, kyc_provider, kyc_inquiry_id, kyc_completed_at, kyc_rejection_reason,
  age_verified, age_verified_at, over_18_attested_at,
  jurisdiction_country, jurisdiction_region, jurisdiction_acknowledged_at,
  mfa_required, notification_token
) ON public.profiles FROM authenticated;

DO $check$
DECLARE
  v_bad text;
  v_kept int;
BEGIN
  SELECT string_agg(column_name, ', ') INTO v_bad
    FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='profiles'
     AND grantee='authenticated' AND privilege_type='SELECT'
     AND column_name IN ('kyc_status','kyc_provider','kyc_inquiry_id','kyc_completed_at',
                         'kyc_rejection_reason','age_verified','age_verified_at',
                         'over_18_attested_at','jurisdiction_country','jurisdiction_region',
                         'jurisdiction_acknowledged_at','mfa_required','notification_token');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still readable by authenticated: %', v_bad;
  END IF;

  -- the ordinary profile must still be readable, or every profile page breaks
  SELECT count(*) INTO v_kept FROM information_schema.column_privileges
   WHERE table_schema='public' AND table_name='profiles'
     AND grantee='authenticated' AND privilege_type='SELECT';
  IF v_kept < 80 THEN
    RAISE EXCEPTION 'only % columns left readable - this revoked far more than intended', v_kept;
  END IF;

  FOR v_bad IN SELECT unnest(ARRAY['id','username','display_name','avatar_url','birthday'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
                    WHERE table_schema='public' AND table_name='profiles'
                      AND grantee='authenticated' AND privilege_type='SELECT'
                      AND column_name = v_bad)
    THEN RAISE EXCEPTION 'lost a column the UI needs: %', v_bad; END IF;
  END LOOP;

  -- anon must remain fully shut out (closed earlier today)
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema='public' AND table_name='profiles' AND grantee='anon')
  THEN RAISE EXCEPTION 'anon regained a profiles grant'; END IF;
END
$check$;
