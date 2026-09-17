-- Read-only postimage for the qualified isolated database AND production after install.
-- Compare full definition hashes from those actual databases; do not substitute
-- body MD5 for pg_get_functiondef MD5. Source body pins below are independent.
-- This query installs nothing and generates no notification.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = pg_catalog, public, extensions;
SET LOCAL timezone = 'UTC';
SELECT clock_timestamp() AS observed_at, current_database() AS database,
  current_setting('server_version_num') AS server_version_num;
WITH expected(signature,body_md5) AS (VALUES
  ('public.fn_is_owner_operational_notification(uuid,text,text,jsonb)','e0743616164c810fac5c9a0af137acfe'),
  ('public.fn_try_record_owner_notification(uuid)','06985316c9e63080120842b32a6555d2'),
  ('public.fn_retry_owner_notification_destination(uuid)','01ac26f15e325b24a4d9eaa9200a77fd'),
  ('public.fn_capture_owner_notification_destination()','64b403e0568e933dba4918a09b9b0ace'),
  ('public.fn_notification_has_personal_destination(uuid,uuid)','7d45f278fa357e52c9ab1bc0d6c4a5c7'),
  ('public.fn_capture_owner_notification_history(integer)','4e97b8f90a622255ab809e1cb9409364')
)
SELECT e.signature, p.oid IS NOT NULL AS present,
  e.body_md5 AS expected_prosrc_md5, md5(p.prosrc) AS actual_prosrc_md5,
  md5(p.prosrc)=e.body_md5 AS source_body_matches,
  md5(pg_get_functiondef(p.oid)) AS full_definition_md5,
  pg_get_userbyid(p.proowner) AS owner, l.lanname AS language,
  p.prosecdef AS security_definer, p.provolatile AS volatility,
  p.proparallel AS parallel_safety, p.proisstrict AS strict,
  p.proconfig AS function_config, p.proacl::text AS acl,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_get_function_result(p.oid) AS return_type
FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
LEFT JOIN pg_language l ON l.oid=p.prolang ORDER BY e.signature;
SELECT name, expected_md5, md5(pg_get_functiondef(to_regprocedure(name))) AS actual_md5,
  md5(pg_get_functiondef(to_regprocedure(name)))=expected_md5 AS preserved
FROM (VALUES
  ('public.fn_record_operational_alert(text,text,text,text,text,jsonb)','36601e205494e8768f5a1dce09f4a186'),
  ('public.fn_mirror_notification_to_push_outbox()','a726e393ab7ef02aa7a5a9f0622bee64')
) AS expected(name,expected_md5);
SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
  c.reloptions, c.relacl::text AS acl,
  CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) END AS view_definition
FROM pg_class c WHERE c.oid IN (to_regclass('public.notifications'),
  to_regclass('public.operational_notification_destinations'),to_regclass('public.personal_notifications'))
ORDER BY c.relname;
SELECT a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
  a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expression,a.attacl::text AS acl
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE a.attrelid=to_regclass('public.operational_notification_destinations') AND a.attnum>0 AND NOT a.attisdropped
ORDER BY a.attnum;
SELECT conname,contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid,true) AS definition
FROM pg_constraint WHERE conrelid=to_regclass('public.operational_notification_destinations') ORDER BY conname;
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
  AND tablename='operational_notification_destinations' ORDER BY indexname;
SELECT c.relname,p.polname,p.polcmd,p.polpermissive,
  ARRAY(SELECT pg_get_userbyid(role_id) FROM unnest(p.polroles) role_id ORDER BY role_id) AS roles,
  pg_get_expr(p.polqual,p.polrelid) AS predicate,pg_get_expr(p.polwithcheck,p.polrelid) AS with_check
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
WHERE p.polrelid IN (to_regclass('public.notifications'),to_regclass('public.operational_notification_destinations'))
ORDER BY c.relname,p.polname;
SELECT t.tgname,t.tgenabled,t.tgtype,t.tgdeferrable,t.tginitdeferred,t.tgisinternal,t.tgnargs,
  t.tgattr::text AS columns,t.tgfoid::regprocedure::text AS function,
  t.tgoldtable,t.tgnewtable,pg_get_triggerdef(t.oid,true) AS definition
FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.notifications') AND NOT t.tgisinternal ORDER BY t.tgname;
COMMIT;
