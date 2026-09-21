-- 20260921002218_the_new_settlement_floor_tables_grant_only_what_their_union_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260920232503 created `club_settlement_floor` and
-- `accounting_deferred_obligations` and granted them
-- `SELECT,REFERENCES,TRIGGER` to anon and authenticated, intending to match
-- their sibling `union_settlement_floor` exactly (`anon=rxt`,
-- `authenticated=rxt`). That GRANT was additive, and this database's default
-- privileges for the public schema had already granted ALL on the new tables
-- to both roles, so the installed ACL came out as `anon=arwdxtm` and
-- `authenticated=arwdxtm` - INSERT, UPDATE, DELETE and TRUNCATE on an
-- operator-owned settlement floor and on an obligations record. Read back from
-- production immediately after installation:
--
--   union_settlement_floor            anon=rxt/postgres      authenticated=rxt/postgres
--   club_settlement_floor             anon=arwdxtm/postgres  authenticated=arwdxtm/postgres
--   accounting_deferred_obligations   anon=arwdxtm/postgres  authenticated=arwdxtm/postgres
--
-- No row was ever exposed: both tables have RLS enabled and carry no policy, so
-- PostgREST returns nothing to either role and every write is refused. This is
-- a latent hazard rather than a live leak - the day someone adds a read policy,
-- the write grants would come with it. A grant that is wider than the thing it
-- was copied from is a defect either way, so it is corrected at its source.
--
-- REVOKE and GRANT do not fire `pgrst_ddl_watch`, so this migration causes no
-- schema-cache reload (production DDL policy rule 5). It changes no definition,
-- no row, no policy and no ownership, and it leaves `union_settlement_floor`
-- alone. It asserts the exact starting ACLs first and refuses if they have
-- already moved, and it asserts the finished ACLs equal the union sibling's.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT bool_and(c.relacl::text='{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('club_settlement_floor','accounting_deferred_obligations','union_settlement_floor'))

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
  -- RLS must still be the thing that kept this from ever being a live leak.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=r.relname) THEN
   RAISE EXCEPTION 'settlement_floor_rls_disabled:%',r.relname USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
    WHERE c.relname IN ('club_settlement_floor','accounting_deferred_obligations')) THEN
  RAISE EXCEPTION 'unexpected_policy_on_a_floor_table' USING ERRCODE='55000';
 END IF;
END $installed_preconditions$;

REVOKE ALL ON TABLE public.club_settlement_floor FROM anon,authenticated;
REVOKE ALL ON TABLE public.accounting_deferred_obligations FROM anon,authenticated;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.club_settlement_floor TO anon,authenticated;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.accounting_deferred_obligations TO anon,authenticated;

DO $readback$
DECLARE expected text;
BEGIN
 SELECT c.relacl::text INTO expected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='union_settlement_floor';
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('club_settlement_floor','accounting_deferred_obligations')
      AND c.relacl::text IS DISTINCT FROM expected) THEN
  RAISE EXCEPTION 'floor_tables_do_not_match_their_union_sibling' USING ERRCODE='55000';
 END IF;
 -- The data this change must not touch.
 IF (SELECT count(*) FROM public.club_settlement_floor)<>1
   OR (SELECT count(*) FROM public.accounting_deferred_obligations)<>4
   OR (SELECT sum(pending_periods) FROM public.accounting_deferred_obligations)<>1449 THEN
  RAISE EXCEPTION 'floor_table_contents_changed' USING ERRCODE='55000';
 END IF;
END $readback$;

COMMIT;
