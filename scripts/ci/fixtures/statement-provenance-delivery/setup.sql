-- Disposable dependencies for the three unmodified production function bodies.
-- Only authentication/contracts outside this change are controlled helpers.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true)='service_role' $$;
CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS $$SELECT gen_random_uuid()$$;
CREATE TABLE accounting_cashier_events(id uuid,club_id uuid,source_ledger_id uuid,amount numeric,audience_user_ids uuid[],issuer_representative_id uuid,issuer_name text,player_name text,event_kind text,invoice_id uuid);
CREATE TABLE accounting_correction_documents(id uuid,club_id uuid,source_ledger_id uuid,amount numeric,invoice_id uuid,audience_user_ids uuid[],issuer_representative_id uuid,issuer_type text,issuer_id uuid,issuer_name text,payee_name text,union_id uuid);
CREATE TABLE accounting_credit_change_documents_v1(id uuid,invoice_id uuid,operation_receipt_id uuid,audience_user_ids uuid[],issuer_name text,recipient_name text);
CREATE TABLE accounting_credit_reduction_operations_v1(id uuid,actor_user_id uuid,club_id uuid);
CREATE TABLE profiles(id uuid,username text,avatar_url text,is_vip boolean);
CREATE TABLE clubs(id uuid,owner_id uuid,name text);
CREATE TABLE unions(id uuid,owner_id uuid,name text);
CREATE TABLE messenger_hidden_messages(user_id uuid,message_id uuid);
CREATE FUNCTION fn_accounting_correction_is_unverified(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE FUNCTION fn_accounting_next_invoice_number() RETURNS text LANGUAGE sql AS $$SELECT 'FIXTURE-1'::text$$;
CREATE FUNCTION fn_cashier_event_payload(accounting_cashier_events) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"event":"fixture"}'::jsonb$$;
CREATE FUNCTION fn_cashier_document_body(uuid,text) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Fixture cashout receipt'::text$$;
CREATE FUNCTION fn_cashier_invoice_contract(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"verified":true}'::jsonb$$;
CREATE FUNCTION fn_accounting_correction_legacy_identity(uuid,uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT NULL::jsonb$$;
CREATE FUNCTION fn_messenger_message_visible_to(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
CREATE FUNCTION fn_accounting_credit_change_contract_v1(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{}'::jsonb$$;
CREATE FUNCTION fn_accounting_correction_contract(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{}'::jsonb$$;
