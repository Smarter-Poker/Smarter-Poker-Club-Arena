-- Source-authored, UNRUN. Isolated full captured baseline before activation.
-- One acceptance psql session must retain TEMP evidence across this COMMIT,
-- the complete candidate's own COMMIT, and transition-regression.sql.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='3s';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
CREATE TEMP TABLE rakeback_precursor_evidence(
 source_id uuid PRIMARY KEY,payload jsonb NOT NULL,reply jsonb NOT NULL,
 before_rows jsonb NOT NULL,after_rows jsonb NOT NULL
) ON COMMIT PRESERVE ROWS;
-- Private session-local observer; no application helper or table is created.
CREATE FUNCTION pg_temp.rakeback_authority_rows() RETURNS jsonb LANGUAGE plpgsql AS $snapshot$
DECLARE r record;rows jsonb;result jsonb:='{}'::jsonb;
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN('public','auth','cron') AND c.relkind IN('r','p')
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',r.nspname,r.relname)
   INTO rows;
  result:=result||jsonb_build_object(format('%I.%I',r.nspname,r.relname),rows);
 END LOOP;
 RETURN result;
END $snapshot$;
REVOKE ALL ON FUNCTION pg_temp.rakeback_authority_rows() FROM PUBLIC,anon,authenticated,service_role;
DO $preactivation$
DECLARE expected record;source_id uuid:='d0160000-0000-0000-0000-000000000081';
 payload jsonb;reply jsonb;before_rows jsonb;after_rows jsonb;attempt integer;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_database()<>'postgres'
  OR inet_server_addr() IS NOT NULL OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'precursor proof requires isolated PG17 owner with actual triggers';END IF;
 -- These three exact definitions are retained in the original full capture and
 -- independently match the 2026-09-17 05:17:32.432201+00 live metadata.
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_credit_agent_commissions_batch(jsonb)','0649a58a4a82bcc1f4835abf63093b43',true,false),
  ('public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)','2fb58bacd784fb6da12a9ac01443454c',false,false),
  ('public.fn_resolve_player_club_for_agent(uuid,uuid,uuid)','f4e1c9f1b27febee47cb3fc1804ef909',true,true)
 ) x(signature,definition_md5,security_definer,authenticated_execute) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
   AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=expected.security_definer
   AND md5(pg_get_functiondef(p.oid))=expected.definition_md5)
   OR has_function_privilege('anon',expected.signature,'EXECUTE')
   OR has_function_privilege('authenticated',expected.signature,'EXECUTE') IS DISTINCT FROM expected.authenticated_execute
   OR NOT has_function_privilege('service_role',expected.signature,'EXECUTE') THEN
   RAISE EXCEPTION 'precursor actual predecessor or access changed: %',expected.signature;END IF;
 END LOOP;
 payload:=jsonb_build_array(jsonb_build_object('source_type','cash_rake_record','source_id',source_id));
 before_rows:=pg_temp.rakeback_authority_rows();
 FOR attempt IN 1..2 LOOP
  EXECUTE 'SET LOCAL ROLE service_role';
  IF current_user<>'service_role' THEN RAISE EXCEPTION 'precursor did not run as actual service';END IF;
  reply:=public.fn_credit_agent_commissions_batch(payload);
  EXECUTE 'RESET ROLE';
  SET CONSTRAINTS ALL IMMEDIATE;
  IF reply IS DISTINCT FROM '{"ok":1,"failed":0,"first_error":null}'::jsonb THEN
   RAISE EXCEPTION 'old batch count reply changed: %',reply;END IF;
  after_rows:=pg_temp.rakeback_authority_rows();
  IF after_rows IS DISTINCT FROM before_rows THEN
   RAISE EXCEPTION 'canonical-only precursor changed captured application rows on old database';END IF;
 END LOOP;
 INSERT INTO rakeback_precursor_evidence VALUES(source_id,payload,reply,before_rows,after_rows);
 RAISE NOTICE 'precursor proof: actual old service batch returns unversioned count twice with every public/auth/cron row unchanged';
END $preactivation$;
-- Only TEMP evidence survives. No candidate is enclosed by this transaction.
COMMIT;
