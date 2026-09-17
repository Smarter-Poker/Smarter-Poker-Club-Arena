\set ON_ERROR_STOP on
-- UNRUN negative fixture. A DISTINCT fresh isolated cluster must contain the
-- real full captured catalog and candidate only THROUGH 161000, not 161500.
-- Never run in the accepted fixture: this deliberately grants a bad role edge.
-- The protected runner must require the exact expected error below as well as
-- these unchanged-state assertions. The temporary snapshot helper is read-only.
DO $prerequisite$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN('anon','authenticated','service_role'))<>3
  OR pg_has_role('authenticated','service_role','MEMBER')
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated') AND (rolsuper OR rolbypassrls))
  OR NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rakeback_period_payouts'
   AND policyname='club owners read own club rakeback')
  OR has_table_privilege('service_role','public.rakeback_periods','INSERT,UPDATE,DELETE,TRUNCATE')
  OR has_table_privilege('service_role','public.rakeback_period_payouts','INSERT,UPDATE,DELETE,TRUNCATE')
 THEN RAISE EXCEPTION 'negative privacy fixture requires isolated original policies after writer retirement';END IF;
END $prerequisite$;
CREATE FUNCTION pg_temp.privacy_guard_snapshot() RETURNS jsonb
 LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object(
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname) FROM pg_policies p
   WHERE p.schemaname='public' AND p.tablename IN('rakeback_periods','rakeback_period_payouts')),
  'tables',(SELECT jsonb_agg(jsonb_build_object('id',c.oid,'owner',c.relowner,'acl',c.relacl,
    'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) ORDER BY c.oid) FROM pg_class c
   WHERE c.oid IN('public.rakeback_periods'::regclass,'public.rakeback_period_payouts'::regclass)),
  'columns',(SELECT jsonb_agg(jsonb_build_object('table',a.attrelid,'number',a.attnum,'acl',a.attacl)
    ORDER BY a.attrelid,a.attnum) FROM pg_attribute a WHERE a.attnum>0 AND NOT a.attisdropped
   AND a.attrelid IN('public.rakeback_periods'::regclass,'public.rakeback_period_payouts'::regclass)),
  'role_attributes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_roles r
   WHERE r.rolname IN('anon','authenticated','service_role')),
  'role_edges',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m));
$$;
CREATE TEMP TABLE privacy_original AS SELECT pg_temp.privacy_guard_snapshot() AS snapshot;
GRANT service_role TO authenticated WITH INHERIT TRUE;
DO $injected$ BEGIN
 IF NOT pg_has_role('authenticated','service_role','USAGE')
  OR has_table_privilege('authenticated','public.rakeback_periods','INSERT,UPDATE,DELETE,TRUNCATE')
  OR has_table_privilege('authenticated','public.rakeback_period_payouts','INSERT,UPDATE,DELETE,TRUNCATE')
 THEN RAISE EXCEPTION 'negative fixture must expose inherited service SELECT without restoring writes';END IF;
END $injected$;
CREATE TEMP TABLE privacy_injected AS SELECT pg_temp.privacy_guard_snapshot() AS snapshot;

-- This one included transaction MUST fail with exactly:
--   rakeback privacy unsafe API role: authenticated
-- Its COMMIT after the refused guard must report ROLLBACK. The protected
-- runner must not count a different SQL error as the expected negative case.
\set ON_ERROR_STOP off
\ir ../../../supabase/accounting/weekly-v3/components/20260914161500_rakeback_history_is_private_to_its_payee.sql
\set ON_ERROR_STOP on
DO $unchanged$ BEGIN
 IF pg_temp.privacy_guard_snapshot() IS DISTINCT FROM (SELECT snapshot FROM privacy_injected)
 THEN RAISE EXCEPTION 'rejected privacy component changed policies, ACLs or the injected role graph';END IF;
 RAISE NOTICE 'privacy guard assertion passed: inherited service role refused with unchanged policies, ACLs and role graph';
END $unchanged$;
REVOKE service_role FROM authenticated;
DO $cleanup$ BEGIN
 IF pg_temp.privacy_guard_snapshot() IS DISTINCT FROM (SELECT snapshot FROM privacy_original)
 THEN RAISE EXCEPTION 'negative privacy fixture failed to restore original role graph';END IF;
 RAISE NOTICE 'privacy guard assertion passed: original role graph restored';
END $cleanup$;
