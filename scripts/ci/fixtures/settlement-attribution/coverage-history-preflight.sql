-- Bounded read-only preflight for the SAME online index operation.
-- Refusal, incompatible existing index, active builder or changed source means
-- diagnose before any build. An exact valid index means reuse, never rebuild.
BEGIN READ ONLY;
SET LOCAL statement_timeout='8s';
SELECT now() AS observed_at, session_user, current_user,
  public.fn_ca_break_window_refuses_migrations(now()) AS ddl_refusal,
  md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) AS source_md5,
  md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) AS retention_md5;
SELECT p.oid,pg_get_userbyid(proowner) AS owner,proacl,proconfig,prosecdef
FROM pg_proc p WHERE p.oid='public.fn_ca_settlement_correctness_check()'::regprocedure;
SELECT c.oid,relkind,pg_get_userbyid(relowner) AS owner,relacl,reloptions,relrowsecurity,relforcerowsecurity,
  a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
WHERE c.oid='public.hand_history'::regclass AND a.attname IN ('id','table_id','hand_number','created_at');
SELECT ci.oid,ci.relname,pg_get_indexdef(ci.oid) AS definition,i.indisvalid,i.indisready,i.indislive
FROM pg_class ci JOIN pg_index i ON i.indexrelid=ci.oid
WHERE ci.relnamespace='public'::regnamespace AND ci.relname LIKE 'idx_hand_history_time_identity%';
SELECT pid,command,phase,relid,index_relid FROM pg_stat_progress_create_index
WHERE relid='public.hand_history'::regclass;
ROLLBACK;
