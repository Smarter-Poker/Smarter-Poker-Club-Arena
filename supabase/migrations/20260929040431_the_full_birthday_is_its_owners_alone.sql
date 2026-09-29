-- 20260929040431_the_full_birthday_is_its_owners_alone
--
-- WHAT WAS WRONG (found 2026-09-29 on the Club Arena app's device walkthrough)
--
-- Any signed-in account could read every player's exact date of birth.
-- `authenticated` held a column SELECT grant on public.profiles.birthday, so
-- from the app's own session on the emulator:
--
--     GET /rest/v1/profiles?select=id&birthday=not.is.null   -> 206, every row
--
-- and a range filter narrows any player to the day. The profile-privacy
-- lockdown revoked age_verified, email, phone, the kyc_* and jurisdiction_*
-- columns and over_18_attested_at from `authenticated`; birthday was missed.
-- The World Hub's stranger-profile allow-list (SAFE_PROFILE_COLUMNS) also
-- carried it, so every public profile view fetched the subject's birthday.
--
-- WHY THIS IS SAFE NOW, AND WAS NOT BEFORE
--
-- Postgres refuses a whole statement that names one ungranted column, so the
-- readers had to move first:
--   * Club Arena's age gate asks fn_my_age_gate_status() (definer, own row;
--     20260929024148, merged as #5564) instead of selecting the column.
--   * World Hub dropped birthday from SAFE_PROFILE_COLUMNS (World Hub PR
--     "a stranger's profile read no longer carries their birthday"), verified
--     live before this was applied. Its profile editor already reads the
--     owner's own row through get_my_full_profile() (definer).
--   * The birthday reward and ensure-profile run server-side as service_role.
--   * Measured before applying: in the preceding 24 hours of API logs, the
--     only requests naming birthday in a select were the walkthrough's own.
-- APPLIED 2026-09-29 04:04 UTC through the Supabase MCP, which recorded it
-- as version 20260929040431; this file carries that version so the file and
-- supabase_migrations.schema_migrations agree. Verified from the app's own
-- session on the emulator right after: filtering profiles by birthday and
-- selecting birthday (even one's own) -> 403 42501; the World Hub's new
-- stranger-profile column list -> 200; fn_my_age_gate_status -> 200;
-- get_my_full_profile() still returns the owner's birthday.
--
-- Writing it is untouched: INSERT and UPDATE (signup, the profile editor) and
-- fn_set_my_birthday (definer) need no SELECT. `anon` never had a grant.
-- `birth_year` stays readable on purpose: the World Hub profile page shows
-- "Born In <year>".
--
-- @live-proof: NOT has_column_privilege('authenticated', 'public.profiles', 'birthday', 'SELECT')
-- @live-proof: NOT has_column_privilege('anon', 'public.profiles', 'birthday', 'SELECT')
-- @live-proof: has_column_privilege('authenticated', 'public.profiles', 'birthday', 'UPDATE')

BEGIN;

REVOKE SELECT (birthday) ON public.profiles FROM authenticated;
REVOKE SELECT (birthday) ON public.profiles FROM anon;

COMMIT;
