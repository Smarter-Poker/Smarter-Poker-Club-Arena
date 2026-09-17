-- SOURCE ONLY / UNAPPLIED. Follows the 161000 table-writer retirement.
-- Policy preimage: accounting-40398-period-visibility-policy.json, observed
-- 2026-09-15 00:58:27.649778+00. No history, money, invoice or delivery changes.
-- A club receives its authorized weekly aggregate; a payee retains their own
-- history even after leaving that club. Membership never grants another
-- person's raw period or payout receipt.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.rakeback_periods,public.rakeback_period_payouts IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE expected record;actual record;table_name text;client_role text;privilege text;
BEGIN
 -- A service-role policy also applies through effective role inheritance.
 -- Removing table writes cannot prevent that unrestricted SELECT path.
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role)
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role AND (rolsuper OR rolbypassrls))
   OR pg_has_role(client_role,'service_role','USAGE')
  THEN RAISE EXCEPTION 'rakeback privacy unsafe API role: %',client_role;END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['rakeback_periods','rakeback_period_payouts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r'
    AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity)
  THEN RAISE EXCEPTION 'rakeback privacy table owner or RLS preimage changed: %',table_name;END IF;
  IF (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=table_name)<>2
  THEN RAISE EXCEPTION 'rakeback privacy policy inventory changed: %',table_name;END IF;
  -- RLS does not constrain service_role's direct writes. The preceding
  -- authority component must remove those rights before this read-only patch.
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   FOREACH privilege IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
    IF has_table_privilege(client_role,format('public.%I',table_name),privilege)
    THEN RAISE EXCEPTION 'rakeback privacy requires retired direct table writes: %, %, %',table_name,client_role,privilege;END IF;
   END LOOP;
   FOREACH privilege IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
    IF has_any_column_privilege(client_role,format('public.%I',table_name),privilege)
    THEN RAISE EXCEPTION 'rakeback privacy requires retired direct column writes: %, %, %',table_name,client_role,privilege;END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('rakeback_periods','rakeback_read','SELECT',ARRAY['public']::name[],'PERMISSIVE',
   E'(EXISTS ( SELECT 1\n   FROM club_members cm\n  WHERE ((cm.club_id = rakeback_periods.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)))))',NULL::text),
  ('rakeback_periods','rakeback_svc','ALL',ARRAY['service_role']::name[],'PERMISSIVE','true',NULL::text),
  ('rakeback_period_payouts','club owners read own club rakeback','SELECT',ARRAY['authenticated']::name[],'PERMISSIVE',
   E'(club_id IN ( SELECT c.id\n   FROM clubs c\n  WHERE (c.owner_id = ( SELECT auth.uid() AS uid))))',NULL::text),
  ('rakeback_period_payouts','service_role full access','ALL',ARRAY['service_role']::name[],'PERMISSIVE','true','true')
 )v(table_name,policy_name,command,roles,permissive,qual,with_check) LOOP
  SELECT p.cmd,p.roles,p.permissive,p.qual,p.with_check INTO actual FROM pg_policies p
   WHERE p.schemaname='public' AND p.tablename=expected.table_name AND p.policyname=expected.policy_name;
  IF NOT FOUND OR actual.cmd IS DISTINCT FROM expected.command OR actual.roles IS DISTINCT FROM expected.roles
   OR actual.permissive IS DISTINCT FROM expected.permissive OR actual.qual IS DISTINCT FROM expected.qual
   OR actual.with_check IS DISTINCT FROM expected.with_check
  THEN RAISE EXCEPTION 'rakeback privacy policy preimage changed: %, %',expected.table_name,expected.policy_name;END IF;
 END LOOP;
END $guard$;

ALTER POLICY rakeback_read ON public.rakeback_periods
 TO authenticated USING (user_id=(SELECT auth.uid()));
DROP POLICY "club owners read own club rakeback" ON public.rakeback_period_payouts;
CREATE POLICY "users read own rakeback receipts" ON public.rakeback_period_payouts
 FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));

COMMENT ON POLICY rakeback_read ON public.rakeback_periods IS
 'A payee reads only their own earned history, including after leaving a club. Club recipients use the authorized weekly accounting summary.';
COMMENT ON POLICY "users read own rakeback receipts" ON public.rakeback_period_payouts IS
 'A payee reads only their own payout receipts. Club ownership does not reveal another payee; the club receives a weekly aggregate.';
COMMIT;
