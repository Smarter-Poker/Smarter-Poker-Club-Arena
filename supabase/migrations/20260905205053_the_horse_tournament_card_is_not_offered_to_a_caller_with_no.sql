-- ═══════════════════════════════════════════════════════════════════════════
--  THE HORSE TOURNAMENT CARD IS NOT OFFERED TO A CALLER WITH NO ACCOUNT
--  Found by the all-phase sweep, in the estate's own live audit.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `audit-live-definer-exposure` went red on a function this repository has
-- never heard of: `ca_horse_tournament_card(integer)` exists in production, is
-- SECURITY DEFINER, owned by `postgres`, and carries EXECUTE for `anon`. There
-- is no migration for it anywhere in this tree, so it arrived from another
-- surface; the exposure is real wherever it was written.
--
-- IT IS NOT AN OPEN DOOR TODAY. Its first statement is
--
--     if not fn_is_horse_admin() then raise exception 'admin only'; end if;
--
-- so an unauthenticated caller receives a refusal, not a card. The audit's
-- phrasing ("never asks who is asking") reads the body for `auth.uid()` and
-- does not follow the call into the helper that asks on its behalf. That makes
-- this a REACHABILITY defect rather than a leak: the grant says anon may run a
-- definer, and the only thing standing between anon and the aggregate is one
-- line inside the function. A grant that is harmless because of a line of code
-- is one edit away from not being harmless.
--
-- WHAT THIS DOES: takes EXECUTE away from PUBLIC and anon, leaves it with
-- `authenticated` and `service_role`. Nothing that works today stops working -
-- anon got an exception before this migration and gets a different exception
-- after it, and every caller who could actually read the card is a horse admin
-- and therefore signed in. Grants do not fire `pgrst_ddl_watch`, so this costs
-- no schema reload (CLAUDE.md section 2, rule 5).
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not touch the body, does not
-- change what the card counts, and does not add a file claiming to have created
-- a function it did not create. If the surface that owns it later ships its own
-- definition, this REVOKE is the state it should preserve.
--
-- Horses are players (CLAUDE.md 10.5). Nothing here filters a horse out of
-- anything; `horse_tournament_daily` is a per-horse rollup and this is an
-- operator's read of it.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ca_horse_tournament_card'
       AND pg_get_function_identity_arguments(p.oid) = 'p_days integer'
  ) THEN
    -- Nothing to close. The function this migration was written about is gone,
    -- which is a fine outcome; say so rather than failing the whole apply.
    RAISE NOTICE 'ca_horse_tournament_card(integer) is not present; nothing to revoke';
    RETURN;
  END IF;

  REVOKE ALL ON FUNCTION public.ca_horse_tournament_card(integer) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.ca_horse_tournament_card(integer)
    TO authenticated, service_role;
END $$;

DO $$
DECLARE v_acl text[];
BEGIN
  SELECT array(SELECT unnest(p.proacl)::text)
    INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'ca_horse_tournament_card'
     AND pg_get_function_identity_arguments(p.oid) = 'p_days integer';

  IF v_acl IS NULL THEN
    RETURN;
  END IF;

  -- `anon=X/postgres` is the grant under test, and a bare `=X/postgres` is the
  -- PUBLIC grant that anon inherits. Revoking one and leaving the other reads
  -- as a fix and does nothing.
  IF EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a LIKE 'anon=%' OR a LIKE '=%') THEN
    RAISE EXCEPTION 'the horse tournament card is still executable without an account: %', v_acl;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a LIKE 'authenticated=%') THEN
    RAISE EXCEPTION 'the horse admin who reads the card lost its own door: %', v_acl;
  END IF;
END $$;

COMMIT;
