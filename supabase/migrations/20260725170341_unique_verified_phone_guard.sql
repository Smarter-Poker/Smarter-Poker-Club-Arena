-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725170341 "unique_verified_phone_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 42e5b3d33a1e8ad4a9adaf29de569721 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- [2026-07-25] Enforce phone uniqueness among VERIFIED accounts at the DB level.
-- The signup flow calls verify-otp WITHOUT a userId, so the app-layer
-- "is this phone already on another account?" check never ran during signup —
-- two accounts could each SMS-verify the same number. A partial unique index
-- makes the guarantee independent of any code path: once a phone is verified
-- on one account, a second account's attempt to set phone_verified=true for
-- the same number fails at the database. signup.js already wraps that update
-- in a non-blocking try/catch, so the second account is still created — it
-- just can't claim a phone that isn't theirs (phone_verified stays false).
-- Verified safe to add: SELECT confirmed 0 existing duplicate verified phones.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profiles_verified_phone
    ON public.profiles (phone)
    WHERE phone_verified = true AND phone IS NOT NULL AND phone <> '';
