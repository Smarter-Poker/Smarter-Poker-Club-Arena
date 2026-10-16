-- 20261016100351_the_anti_cheat_exemption_trigger_is_not_callable_by_anon.sql
--
-- Applied to PokerIQ-Production with the Supabase MCP apply_migration, which
-- stamped version 20261016100351; this file carries that recorded version.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261015170348 (KingFish and Danimal are never flagged for multiple
-- accounts) created public.fn_anti_cheat_flags_skip_exempt() as a SECURITY
-- DEFINER trigger function and left Postgres's default EXECUTE grant to PUBLIC
-- in place. The hourly Production Integrity Audit's anon-definer reader has
-- reported it ever since ("anon_definers=1"): it is the only definer in the
-- public schema that anon can execute without being on the allowlist in
-- docs/security/anon-executable-definers.json.
--
-- A trigger function is not an API (20260831d_a_trigger_function_is_not_an_api).
-- Postgres runs it through the BEFORE INSERT trigger on anti_cheat_flags with
-- the definer's rights regardless of who inserts, so revoking EXECUTE changes
-- nothing about the exemption itself: KingFish and Danimal stay exempt.
--
-- GRANT/REVOKE does not fire the schema-cache reload, but it still goes in one
-- transaction with a readback that aborts if the grant survived.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_anti_cheat_flags_skip_exempt() FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.fn_anti_cheat_flags_skip_exempt()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_anti_cheat_flags_skip_exempt()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_anti_cheat_flags_skip_exempt is still executable by anon or authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_anti_cheat_flags_skip_exempt'
      AND tgrelid = 'public.anti_cheat_flags'::regclass
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'The anti-cheat exemption trigger is missing or disabled';
  END IF;
END
$verify$;

COMMIT;
