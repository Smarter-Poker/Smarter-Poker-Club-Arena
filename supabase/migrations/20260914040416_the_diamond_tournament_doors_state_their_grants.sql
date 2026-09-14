-- ============================================================================
-- THE DIAMOND TOURNAMENT DOORS STATE THEIR GRANTS
-- ============================================================================
--
-- The first Phase 8 migration re-created three chip functions in place -
-- fn_ca_entry_scope_ok, fn_ca_escrow_can_pay and fn_register_horse_for_tournament
-- - and, being in-place edits, said nothing about their grants: a re-created
-- function keeps the ACL it had, and in production none of the three has ever
-- been reachable by anon (fn_ca_entry_scope_ok: authenticated and service_role;
-- the other two: service_role only). The definer-authorization gate reads the
-- migration text, not the live ACL, and a declaration with no REVOKE reads as
-- open. This states the live grants in the repo so the text says what the
-- database does. Every statement below is a no-op against production.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- A membership/scope read used by the entry gates. A logged-in player may read
-- it (it is what the registration door consults); nobody without an account may.
REVOKE ALL ON FUNCTION public.fn_ca_entry_scope_ok(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_entry_scope_ok(uuid, uuid) TO authenticated, service_role;

-- The bank cap. Read by the settlement authorities, which run as owner; the
-- engine may read it; no browser role may.
REVOKE ALL ON FUNCTION public.fn_ca_escrow_can_pay(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_can_pay(uuid, text, numeric) TO service_role;

-- The horse entry door: engine only, both overloads.
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid, boolean) TO service_role;

DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('fn_ca_entry_scope_ok','fn_ca_escrow_can_pay','fn_register_horse_for_tournament')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '%(%) is still reachable without an account', r.proname, r.args;
    END IF;
    IF r.proname <> 'fn_ca_entry_scope_ok' AND has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '%(%) is still a browser door', r.proname, r.args;
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '%(%) lost the engine', r.proname, r.args;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  RAISE NOTICE 'the Diamond tournament doors state their grants: three functions, no browser reach, nothing opened';
END $do$;
