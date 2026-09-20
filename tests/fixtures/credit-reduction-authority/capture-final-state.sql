\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Bounded isolated cleanup observation on success/failure.
-- Missing candidate tables are reported as absent, never silently reconstructed.
-- CREATE TEMP is a utility write in PostgreSQL. Create only this session-local
-- result buffer first; business-table observation starts in the separate
-- read-only snapshot below and never writes an application relation.
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE;
SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s';
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'isolated PG17 final capture required';END IF;
END$guard$;
CREATE TEMP TABLE credit_fixture_final_capture(relation text PRIMARY KEY,available boolean NOT NULL,
 total_rows bigint,shown_rows integer,truncated boolean,rows jsonb);
COMMIT;
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s';
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
DO $capture$ DECLARE name text;predicate text;n bigint;payload jsonb;BEGIN
 FOREACH name IN ARRAY ARRAY['accounting_credit_reduction_operations_v1','accounting_credit_reduction_retirements_v1',
  'accounting_credit_change_documents_v1','credit_reduction_fixture_marker','agents','credit_assignments',
  'settlement_invoices','accounting_invoice_deliveries','social_messages','social_conversations','notifications','push_outbox'] LOOP
  IF to_regclass('public.'||name) IS NULL THEN
   INSERT INTO credit_fixture_final_capture VALUES(name,false,NULL,NULL,NULL,NULL);CONTINUE;
  END IF;
  predicate:=CASE name
   WHEN 'agents' THEN 'club_id IN(''e6371000-0000-4000-8000-000000000101''::uuid,''e6371000-0000-4000-8000-000000000102''::uuid)'
   WHEN 'credit_assignments' THEN 'assigned_by::text LIKE ''e6371000-0000-4000-8000-%'''
   WHEN 'settlement_invoices' THEN 'invoice_type=''credit_limit_change'''
   WHEN 'accounting_invoice_deliveries' THEN 'invoice_id IN(SELECT id FROM public.settlement_invoices WHERE invoice_type=''credit_limit_change'')'
   WHEN 'social_messages' THEN 'media_metadata->>''invoice_type''=''credit_limit_change'''
   WHEN 'social_conversations' THEN 'id IN(SELECT conversation_id FROM public.social_messages WHERE media_metadata->>''invoice_type''=''credit_limit_change'')'
   WHEN 'notifications' THEN 'data->>''invoice_type''=''credit_limit_change'''
   WHEN 'push_outbox' THEN 'accounting_notification_id IN(SELECT id FROM public.notifications WHERE data->>''invoice_type''=''credit_limit_change'')'
   ELSE 'true' END;
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %s',name,predicate) INTO n;
  EXECUTE format('SELECT COALESCE(jsonb_agg(row_json ORDER BY row_json::text),''[]''::jsonb) FROM (SELECT to_jsonb(t) row_json FROM public.%I t WHERE %s ORDER BY to_jsonb(t)::text LIMIT 1000) bounded',name,predicate) INTO payload;
  INSERT INTO credit_fixture_final_capture VALUES(name,true,n,jsonb_array_length(payload),n>jsonb_array_length(payload),payload);
 END LOOP;
END$capture$;
SELECT jsonb_build_object('capture','credit_reduction_final_committed_rows','observed_at',clock_timestamp(),
 'context',jsonb_build_object('database',current_database(),'current_user',current_user,'session_user',session_user,
  'postmaster_started_at',pg_postmaster_start_time(),'transaction_read_only',current_setting('transaction_read_only')),
 'per_relation_limit',1000,'relations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relation) FROM credit_fixture_final_capture c));
ROLLBACK;
