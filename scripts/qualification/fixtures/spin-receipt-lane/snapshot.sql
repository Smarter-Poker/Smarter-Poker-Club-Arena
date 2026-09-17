\set ON_ERROR_STOP on
SET statement_timeout='10s'; SET lock_timeout='1s'; SET timezone='UTC'; SET search_path=public,pg_temp;
\ir boundary.sql
\ir ../spin-history-retention/database-state.sql
\ir state.sql
SELECT jsonb_build_object('catalog',pg_temp.receipt_lane_catalog(),'handler',pg_temp.receipt_lane_handler(),'business',pg_temp.retention_database_state(),'relation_trigger_hints',(SELECT jsonb_object_agg(c.relname,c.relhastriggers) FROM pg_class c WHERE c.oid IN ('public.hand_history'::regclass,'public.settlement_idempotency_keys'::regclass)));
