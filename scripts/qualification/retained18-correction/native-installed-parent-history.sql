-- Typed isolated installation metadata only. Parent bytes are loaded by the
-- runner from the exact protected parent source; this is not a production receipt.
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
INSERT INTO public.ca_money_rpc_registry(proname,status,notes,added_at)
SELECT 'fn_ca_resume_hand_submission','approved','One exact failed-original handoff under the current lease, followed by repeatable accepted-receipt postcommit and original F06 finish.','2026-09-18T12:49:35.498702+00:00'::timestamptz
WHERE NOT EXISTS(SELECT FROM public.ca_money_rpc_registry WHERE proname='fn_ca_resume_hand_submission');
