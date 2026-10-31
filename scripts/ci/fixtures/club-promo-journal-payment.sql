CREATE TRIGGER member_ledger AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();
CREATE TRIGGER agent_ledger AFTER UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet','promo_wallet_balance=promo_wallet');
INSERT INTO club_members VALUES ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','10000000-0000-0000-0000-000000000002','player','active',0,now()),('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','10000000-0000-0000-0000-000000000003','agent','active',0,now());
INSERT INTO agents VALUES ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0,0,now());
BEGIN;
DO $$ DECLARE r jsonb; dest text; recipient uuid; op uuid; b numeric; c integer; BEGIN
FOREACH dest IN ARRAY ARRAY['player_wallet','cashier_agent_wallet','cashier_promo_wallet','agent_wallet'] LOOP
recipient:=CASE WHEN dest='player_wallet' THEN '10000000-0000-0000-0000-000000000002' ELSE '10000000-0000-0000-0000-000000000003' END::uuid;
op:=gen_random_uuid();SELECT count(*) INTO c FROM chip_ledger;
r:=fn_club_promo_send_core_20261004('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',recipient,10,dest,NULL,op);
IF r->>'success'<>'true' OR (SELECT count(*) FROM chip_ledger)<>c+1 THEN RAISE EXCEPTION 'payment failed: %',r; END IF;
IF NOT EXISTS(SELECT 1 FROM chip_ledger WHERE from_entity_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND from_label='clubs.promo_balance' AND amount=10 AND to_entity_id=recipient) THEN RAISE EXCEPTION 'source label missing: %',dest; END IF;
SELECT promo_balance INTO b FROM clubs WHERE id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
r:=fn_club_promo_send_core_20261004('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',recipient,10,dest,NULL,op);
IF r->>'replayed'<>'true' OR (SELECT promo_balance FROM clubs WHERE id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4')<>b OR (SELECT count(*) FROM chip_ledger)<>c+1 THEN RAISE EXCEPTION 'duplicate paid'; END IF;
END LOOP;
-- Negative member movement carries the declared counterparty on the TO side.
PERFORM fn_ca_declare_ledger('promo_send','promo_wallet','a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
PERFORM set_config('app.ledger_counterparty_label','clubs.promo_balance',true);
UPDATE club_members SET chip_balance=chip_balance-1 WHERE user_id='10000000-0000-0000-0000-000000000002';
IF NOT EXISTS(SELECT 1 FROM chip_ledger WHERE amount=1 AND to_label='clubs.promo_balance' AND from_label='club_members.chip_balance') THEN RAISE EXCEPTION 'reverse side label lost'; END IF;
-- Invalid stale label cannot name a different kind of counterparty.
PERFORM fn_ca_declare_ledger('promo_send','promo_wallet','a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
IF current_setting('app.ledger_counterparty_label',true)<>'' THEN RAISE EXCEPTION 'declaration leaked previous label'; END IF;
PERFORM set_config('app.ledger_counterparty_label','unions.chip_balance',true);
UPDATE club_members SET chip_balance=chip_balance+2 WHERE user_id='10000000-0000-0000-0000-000000000002';
IF EXISTS(SELECT 1 FROM chip_ledger WHERE amount=2 AND from_label IS NOT NULL) THEN RAISE EXCEPTION 'invalid label accepted'; END IF;
-- A trigger error rolls the original payment and debit back together.
SELECT promo_balance INTO b FROM clubs WHERE id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';SELECT count(*) INTO c FROM chip_ledger;
BEGIN
 ALTER TABLE chip_ledger ADD CONSTRAINT fixture_reject CHECK(amount<>11) NOT VALID;
 PERFORM fn_club_promo_send_core_20261004('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','10000000-0000-0000-0000-000000000002',11,'player_wallet',NULL,gen_random_uuid());
 RAISE EXCEPTION 'fixture did not refuse';
EXCEPTION WHEN check_violation THEN NULL;
END;
IF (SELECT promo_balance FROM clubs WHERE id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4')<>b OR (SELECT count(*) FROM chip_ledger)<>c THEN RAISE EXCEPTION 'partial financial write'; END IF;
END $$;
ROLLBACK;
DO $$ BEGIN IF (SELECT promo_balance FROM clubs WHERE id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4')<>2280 THEN RAISE EXCEPTION 'fixture rollback failed'; END IF; END $$;
