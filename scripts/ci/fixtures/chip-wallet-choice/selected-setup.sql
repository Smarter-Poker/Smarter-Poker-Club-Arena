ALTER TABLE agents ADD COLUMN promo_wallet_balance numeric DEFAULT 0;
ALTER TABLE clubs ADD COLUMN promo_balance numeric DEFAULT 1000;
ALTER TABLE chip_transactions ADD COLUMN is_reversed boolean DEFAULT false, ADD COLUMN clawed_back boolean DEFAULT false;
CREATE TABLE test_intents(id uuid PRIMARY KEY,actor uuid,club uuid,intent jsonb,receipt jsonb);
CREATE OR REPLACE FUNCTION fn_cashier_exact_intent_begin(text,uuid,uuid,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE prior test_intents; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('test-intent:'||$3::text,0));
 SELECT * INTO prior FROM test_intents WHERE id=$3;
 IF FOUND THEN
  IF prior.actor IS DISTINCT FROM auth.uid() OR prior.club IS DISTINCT FROM $2 OR prior.intent IS DISTINCT FROM $4 THEN RETURN jsonb_build_object('state','return','response',jsonb_build_object('success',false,'error','Retry Intent Mismatch')); END IF;
  IF prior.receipt IS NOT NULL THEN RETURN jsonb_build_object('state','return','response',prior.receipt||'{"replayed":true}'::jsonb); END IF;
 ELSE INSERT INTO test_intents VALUES($3,auth.uid(),$2,$4,NULL); END IF;
 RETURN '{"state":"proceed"}'::jsonb;
END $$;
CREATE OR REPLACE FUNCTION fn_cashier_exact_intent_finish(uuid,jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
 IF ($2->>'success')::boolean THEN UPDATE test_intents SET receipt=$2 WHERE id=$1; END IF; RETURN $2;
END $$;
CREATE OR REPLACE FUNCTION fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) RETURNS void LANGUAGE plpgsql AS $$ DECLARE t text; BEGIN
 PERFORM set_config('app.ledger_counterparty_entity',$3::text,true); PERFORM set_config('app.ledger_counterparty',$2,true); PERFORM set_config('app.ledger_category',$1,true); PERFORM set_config('app.ledger_idempotency_key',$5,true);
 FOREACH t IN ARRAY $6 LOOP PERFORM set_config('app.ledger_autoskip_'||t,'1',true); END LOOP;
END $$;
CREATE OR REPLACE FUNCTION bank_agent_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_setting('app.ledger_autoskip_agents',true)='1' THEN RETURN NEW; END IF;
 IF NEW.agent_wallet_balance IS DISTINCT FROM OLD.agent_wallet_balance THEN
 INSERT INTO journal VALUES(current_setting('app.ledger_category'),current_setting('app.ledger_counterparty'),current_setting('app.ledger_counterparty_entity')::uuid,'agent_wallet',NEW.user_id,NEW.agent_wallet_balance-OLD.agent_wallet_balance,NEW.club_id,current_setting('app.ledger_idempotency_key'));
 ELSIF NEW.promo_wallet_balance IS DISTINCT FROM OLD.promo_wallet_balance THEN
 INSERT INTO journal VALUES(current_setting('app.ledger_category'),current_setting('app.ledger_counterparty'),current_setting('app.ledger_counterparty_entity')::uuid,'promo_wallet',NEW.user_id,NEW.promo_wallet_balance-OLD.promo_wallet_balance,NEW.club_id,current_setting('app.ledger_idempotency_key'));
 END IF; RETURN NEW;
END $$;
DROP TRIGGER bank_agent_journal ON agents;
CREATE TRIGGER bank_agent_journal AFTER UPDATE OF agent_wallet_balance,promo_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION bank_agent_journal();
SELECT set_config('app.ledger_autoskip_agents','1',false);
UPDATE agents SET promo_wallet_balance=1000;
SELECT set_config('app.ledger_autoskip_agents','',false);

CREATE OR REPLACE FUNCTION player_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_setting('app.ledger_autoskip_club_members',true)='1' THEN RETURN NEW; END IF;
 IF NEW.chip_balance <> OLD.chip_balance THEN INSERT INTO journal VALUES(current_setting('app.ledger_category'),current_setting('app.ledger_counterparty'),current_setting('app.ledger_counterparty_entity')::uuid,'player_wallet',NEW.user_id,NEW.chip_balance-OLD.chip_balance,NEW.club_id,current_setting('app.ledger_idempotency_key')); END IF; RETURN NEW;
END $$;
SELECT set_config('app.ledger_autoskip_club_members','1',false);
UPDATE club_members SET chip_balance=1000 WHERE role='owner';
SELECT set_config('app.ledger_autoskip_club_members','',false);
