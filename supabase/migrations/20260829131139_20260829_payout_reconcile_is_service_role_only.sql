-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829131139; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ── WHO MAY CALL THIS (2026-08-29) ───────────────────────────────────────
-- Caught by .husky/pre-push check-definer-authorization, and it is right to
-- ask. fn_tournament_payout_reconcile is SECURITY DEFINER, it MOVES MONEY
-- when p_apply is true, and it derives the actor from nothing -- no
-- auth.uid(), no auth.role(). If a browser role could execute it, any
-- signed-in player could point it at any tournament and make it pay.
--
-- Production is already safe: the live ACL is
-- {postgres=X/postgres,service_role=X/postgres}, so no browser role holds
-- EXECUTE today. This makes that explicit rather than incidental, because
-- CREATE OR REPLACE leaves ACLs alone -- so the migration that last defined
-- this function, REPLAYED ON A FRESH DATABASE, would create it with the
-- default PUBLIC EXECUTE and quietly open exactly that hole. A migration has
-- to be true on an empty database, not only on this one.
--
-- Nobody in a browser should call a reconciliation pass. Its only caller is
-- RakebackSettlerService on the engine, which holds the service role.
-- PUBLIC is named as well as the roles: revoking anon and authenticated while
-- PUBLIC still holds EXECUTE reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

-- Same reasoning, because the sweep is the loop around it and carries the
-- same p_apply.
REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;

DO $$
DECLARE v_acl text;
BEGIN
  SELECT p.proacl::text INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_payout_reconcile';

  IF v_acl IS NULL OR v_acl ILIKE '%anon=%' OR v_acl ILIKE '%authenticated=%' THEN
    RAISE EXCEPTION 'a browser role can still execute fn_tournament_payout_reconcile: %', v_acl;
  END IF;
  RAISE NOTICE 'payout reconcile ACL: %', v_acl;
END $$;
