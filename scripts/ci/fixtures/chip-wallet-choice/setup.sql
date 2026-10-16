CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,chip_treasury numeric,updated_at timestamptz);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,agent_id uuid,chip_balance numeric DEFAULT 0,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,agent_wallet_balance numeric DEFAULT 0,is_prepaid boolean DEFAULT true,credit_limit numeric DEFAULT 0,credit_used numeric DEFAULT 0,updated_at timestamptz,UNIQUE(club_id,user_id));
CREATE TABLE chip_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb,balance_after numeric,reversible_until timestamptz);
CREATE UNIQUE INDEX operations ON chip_transactions(club_id,from_user_id,(metadata->>'op_id'));
-- The fixture isolates the real routing/locking/writing bodies. Authority and
-- journal adapters expose their inputs; production adapters are proved by the
-- existing exact-intent qualification and rollback-only live contract.
CREATE FUNCTION fn_club_bank_role(uuid,uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$ SELECT role FROM club_members WHERE club_id=$1 AND user_id=coalesce($2,auth.uid()) AND status='active' $$;
CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM club_members WHERE club_id=$1 AND user_id=$3 AND (agent_id=$2 OR EXISTS(SELECT 1 FROM clubs WHERE id=$1 AND owner_id=$2))) $$;
CREATE FUNCTION fn_ensure_agent_row(uuid,uuid,text) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE result uuid; BEGIN INSERT INTO agents(club_id,user_id) VALUES($1,$2) ON CONFLICT(club_id,user_id) DO NOTHING; SELECT id INTO result FROM agents WHERE club_id=$1 AND user_id=$2; RETURN result; END $$;
CREATE TABLE journal(category text,from_type text,from_id uuid,to_type text,to_id uuid,amount numeric,club_id uuid,op text UNIQUE);
CREATE FUNCTION fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('app.ledger_counterparty_entity',$3::text,true); PERFORM set_config('app.ledger_idempotency_key',$5,true); END $$;
CREATE FUNCTION fn_ca_post_leg(text,text,uuid,text,uuid,numeric,uuid,text,text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO journal VALUES($1,$2,$3,$4,$5,$6,$7,$8); RETURN true; END $$;
CREATE FUNCTION player_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chip_balance <> OLD.chip_balance THEN INSERT INTO journal VALUES('agent_send','agent_wallet',current_setting('app.ledger_counterparty_entity')::uuid,'player_wallet',NEW.user_id,NEW.chip_balance-OLD.chip_balance,NEW.club_id,current_setting('app.ledger_idempotency_key')); END IF; RETURN NEW; END $$;
CREATE TRIGGER player_journal AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION player_journal();
INSERT INTO clubs VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1000,now());
INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner','active',NULL),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','agent','active','00000000-0000-0000-0000-000000000002'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','agent','active','00000000-0000-0000-0000-000000000003'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005','player','active','00000000-0000-0000-0000-000000000003');
INSERT INTO agents(club_id,user_id,agent_wallet_balance) SELECT club_id,user_id,1000 FROM club_members WHERE role IN ('owner','agent');
CREATE FUNCTION fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"state":"proceed"}'::jsonb $$;
CREATE FUNCTION fn_cashier_exact_intent_finish(uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT $2 $$;
-- Mirror the retained ensure helper's first lock for concurrent bank sends.
CREATE OR REPLACE FUNCTION fn_ensure_agent_row(uuid,uuid,text) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE result uuid; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||$1::text,0));
 INSERT INTO agents(club_id,user_id) VALUES($1,$2) ON CONFLICT(club_id,user_id) DO NOTHING;
 SELECT id INTO result FROM agents WHERE club_id=$1 AND user_id=$2; RETURN result; END $$;
CREATE OR REPLACE FUNCTION fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM set_config('app.ledger_counterparty_entity',$3::text,true);
 PERFORM set_config('app.ledger_counterparty',$2,true);
 PERFORM set_config('app.ledger_category',$1,true);
 PERFORM set_config('app.ledger_idempotency_key',$5,true);
 END $$;
CREATE OR REPLACE FUNCTION player_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chip_balance <> OLD.chip_balance THEN INSERT INTO journal VALUES(current_setting('app.ledger_category'),current_setting('app.ledger_counterparty'),current_setting('app.ledger_counterparty_entity')::uuid,'player_wallet',NEW.user_id,NEW.chip_balance-OLD.chip_balance,NEW.club_id,current_setting('app.ledger_idempotency_key')); END IF; RETURN NEW; END $$;
CREATE FUNCTION bank_agent_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_setting('app.ledger_category',true)='club_bank_send' THEN
 INSERT INTO journal VALUES('club_bank_send','club_treasury',NEW.club_id,'agent_wallet',NEW.user_id,NEW.agent_wallet_balance-OLD.agent_wallet_balance,NEW.club_id,current_setting('app.ledger_idempotency_key'));
 END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_agent_journal AFTER UPDATE OF agent_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION bank_agent_journal();
