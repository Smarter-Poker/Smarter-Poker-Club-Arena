
ALTER TABLE tables ADD COLUMN IF NOT EXISTS tournament_id uuid;
ALTER TABLE table_seats ADD COLUMN club_id uuid;
ALTER TABLE tournaments ADD COLUMN starting_chips numeric, ADD COLUMN rebuy_chips numeric, ADD COLUMN addon_chips numeric;
CREATE TABLE wallet_transactions(user_id uuid,category text,type text,related_entity_id uuid,created_at timestamptz);
CREATE TABLE settlement_idempotency_keys(table_id uuid,hand_id uuid,status text,result jsonb,error text,
 attempt_count integer,first_attempt_at timestamptz,last_attempt_at timestamptz,completed_at timestamptz,UNIQUE(table_id,hand_id));
CREATE TABLE ca_settlements(id uuid DEFAULT gen_random_uuid(),settlement_type text,external_ref text,state text,
 table_id uuid,hand_id uuid,idempotency_key text,error_detail text,totals jsonb,UNIQUE(settlement_type,external_ref));
CREATE TABLE ca_seat_stack_rebases(settlement_id uuid,table_id uuid,hand_id uuid,hand_number bigint,user_id uuid,
 engine_before numeric,db_before numeric,engine_after numeric,written numeric);
CREATE TABLE wallet_credit_idempotency(key text UNIQUE,user_id uuid,amount numeric);
CREATE FUNCTION fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)
 RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;
DO $role$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $role$;
