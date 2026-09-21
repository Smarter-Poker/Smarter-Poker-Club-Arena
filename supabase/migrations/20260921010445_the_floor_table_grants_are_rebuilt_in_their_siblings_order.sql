-- 20260921010445_the_floor_table_grants_are_rebuilt_in_their_siblings_order.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- This finishes what 20260921002218 set out to do, after that migration
-- refused on production and rolled back without changing anything.
--
-- 20260920232503 created `club_settlement_floor` and
-- `accounting_deferred_obligations` meaning to copy their sibling
-- `union_settlement_floor`'s grants exactly. Its `GRANT SELECT,REFERENCES,
-- TRIGGER TO anon,authenticated` was additive on top of this database's public
-- schema default privileges, which had already granted ALL, so both tables
-- installed with `anon=arwdxtm` and `authenticated=arwdxtm` - INSERT, UPDATE,
-- DELETE and TRUNCATE on an operator-owned settlement floor and on an
-- obligations record. No row was ever exposed and no write was ever possible:
-- both tables have RLS enabled and carry no policy, so PostgREST returns
-- nothing to either role and every write is refused. It is a latent hazard,
-- and it is corrected here rather than left as a note.
--
-- 20260921002218 revoked and re-granted, then asserted the finished
-- `relacl::text` equalled the sibling's. It refused with
-- `floor_tables_do_not_match_their_union_sibling`, correctly: `aclitem[]` keeps
-- insertion order, so revoking only anon and authenticated and granting them
-- back moves them AFTER `service_role` in the array. The privileges were right
-- and the text was not, so the guard fired and the whole transaction rolled
-- back. Nothing was applied and that version was never recorded.
--
-- The fix is to rebuild the whole non-owner ACL in the sibling's order rather
-- than to loosen the comparison: revoke from anon, authenticated AND
-- service_role, then grant back in that order, so the array is reconstructed
-- as `{postgres=arwdDxtm,anon=rxt,authenticated=rxt,service_role=arwdDxtm}`.
-- service_role keeps exactly the privileges it already had; the revoke and the
-- grant are in one transaction, so no session ever observes it without them.
-- The equality assertion stays exact.
--
-- REVOKE and GRANT are not in `pgrst_ddl_watch`'s list, so this causes no
-- schema-cache reload (production DDL policy rule 5). No definition, row,
-- policy or ownership changes, and `union_settlement_floor` is not touched.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*)=3 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('club_settlement_floor','accounting_deferred_obligations','union_settlement_floor') AND c.relacl::text='{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}')

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $installed_preconditions$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('club_settlement_floor','{postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}'),
  ('accounting_deferred_obligations','{postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}'),
  ('union_settlement_floor','{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}')
 ) AS v(relname,acl)
 LOOP
  IF (SELECT c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=r.relname) IS DISTINCT FROM r.acl THEN
   RAISE EXCEPTION 'settlement_floor_acl_drift:%',r.relname USING ERRCODE='55000';
  END IF;
  -- RLS is what kept the wide grant from ever being a live leak. It stays on.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=r.relname) THEN
   RAISE EXCEPTION 'settlement_floor_rls_disabled:%',r.relname USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
    WHERE c.relname IN ('club_settlement_floor','accounting_deferred_obligations')) THEN
  RAISE EXCEPTION 'unexpected_policy_on_a_floor_table' USING ERRCODE='55000';
 END IF;
 -- The owner keeps the grant it always had; this migration only rebuilds the
 -- three non-owner entries, in the order the sibling records them.
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('club_settlement_floor','accounting_deferred_obligations')
       AND pg_get_userbyid(c.relowner)='postgres')<>2 THEN
  RAISE EXCEPTION 'floor_table_owner_changed' USING ERRCODE='55000';
 END IF;
END $installed_preconditions$;

REVOKE ALL ON TABLE public.club_settlement_floor FROM anon,authenticated,service_role;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.club_settlement_floor TO anon;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.club_settlement_floor TO authenticated;
GRANT ALL ON TABLE public.club_settlement_floor TO service_role;

REVOKE ALL ON TABLE public.accounting_deferred_obligations FROM anon,authenticated,service_role;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.accounting_deferred_obligations TO anon;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.accounting_deferred_obligations TO authenticated;
GRANT ALL ON TABLE public.accounting_deferred_obligations TO service_role;

DO $readback$
DECLARE expected text;
BEGIN
 SELECT c.relacl::text INTO expected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='union_settlement_floor';
 IF expected IS DISTINCT FROM '{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}' THEN
  RAISE EXCEPTION 'union_settlement_floor_acl_moved_underneath_this_migration' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('club_settlement_floor','accounting_deferred_obligations')
      AND c.relacl::text IS DISTINCT FROM expected) THEN
  RAISE EXCEPTION 'floor_tables_do_not_match_their_union_sibling' USING ERRCODE='55000';
 END IF;
 -- No privilege may have been lost that the sibling still holds, and none
 -- gained that it does not: proved again per grantee, order-independently.
 IF EXISTS(
   SELECT 1 FROM (VALUES('club_settlement_floor'),('accounting_deferred_obligations')) t(relname)
   CROSS JOIN (VALUES('anon'),('authenticated'),('service_role'),('postgres')) g(grantee)
   CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
   WHERE has_table_privilege(g.grantee,('public.'||t.relname)::regclass,p.priv)
      IS DISTINCT FROM has_table_privilege(g.grantee,'public.union_settlement_floor'::regclass,p.priv)) THEN
  RAISE EXCEPTION 'floor_table_effective_privileges_differ_from_their_sibling' USING ERRCODE='55000';
 END IF;
 -- The data this change must not touch.
 IF (SELECT count(*) FROM public.club_settlement_floor)<>1
   OR (SELECT count(*) FROM public.accounting_deferred_obligations)<>4
   OR (SELECT sum(pending_periods) FROM public.accounting_deferred_obligations)<>1449 THEN
  RAISE EXCEPTION 'floor_table_contents_changed' USING ERRCODE='55000';
 END IF;
END $readback$;

COMMIT;
