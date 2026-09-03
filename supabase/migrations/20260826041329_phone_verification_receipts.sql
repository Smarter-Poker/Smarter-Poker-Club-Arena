-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826041329; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A SERVER-SIDE WITNESS FOR A VERIFICATION THAT HAPPENS BEFORE THE ACCOUNT
-- EXISTS. Added 2026-08-25.
--
-- /auth/signup verifies the handset BEFORE calling supabase.auth.signUp, so
-- /api/sms/verify-otp has no session to write to. Its anonymous path therefore
-- returned success and wrote nothing at all, and ensure-profile took the
-- client's word for it: `phone_verified: metadata?.phone_verified === true`,
-- read straight out of user_metadata - which the account holder can set for
-- themselves with supabase.auth.updateUser({ data: { phone_verified: true } }).
--
-- That disarmed the duplicate-phone guard in verify-otp, which only matches
-- profiles WHERE phone_verified = true. One handset, unlimited accounts, and
-- every one of them collecting a 500-diamond welcome package.
--
-- verify-otp now upserts a receipt the moment Twilio's code actually matches,
-- and ensure-profile confirms the claimed number against it (1 hour TTL, fails
-- closed). Digits only, matching cleanPhone in verify-otp.

CREATE TABLE IF NOT EXISTS public.phone_verification_receipts (
  phone       text PRIMARY KEY,
  verified_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.phone_verification_receipts IS
  'Short-lived proof that a phone number passed SMS verification during a signup that had no session yet. Written by /api/sms/verify-otp, read by /api/auth/ensure-profile. Service role only - never exposed to clients.';

CREATE INDEX IF NOT EXISTS phone_verification_receipts_verified_at_idx
  ON public.phone_verification_receipts (verified_at);

-- Service role only. RLS on with NO policies means anon and authenticated can
-- read nothing and write nothing; the service role bypasses RLS entirely.
-- A client that could read this table could enumerate which numbers are
-- mid-signup; one that could write it could forge the very fact it proves.
ALTER TABLE public.phone_verification_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.phone_verification_receipts FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'phone_verification_receipts'
       AND column_name = 'verified_at'
  ) THEN
    RAISE EXCEPTION 'phone_verification_receipts.verified_at is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phone_verification_receipts'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on phone_verification_receipts';
  END IF;
END $$;
