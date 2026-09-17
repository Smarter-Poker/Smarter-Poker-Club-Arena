-- Controlled fixture bank authorities for the manually constructed source
-- cases. The real producer is exercised later with this fixture trigger gone.
CREATE FUNCTION test_seed_source_bank() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE bank_id uuid;game_union uuid;BEGIN
 IF NEW.metadata->>'accounting_source_version'='2' THEN
  game_union:=NULLIF(NEW.metadata->>'union_id','')::uuid;
  IF game_union IS NOT NULL THEN
   INSERT INTO union_wallet_transactions(union_id,club_id,amount,tx_type,wallet,direction,created_at)
    VALUES(game_union,NEW.club_id,NEW.rake_amount,'rake','rake_wallet','credit',NEW.created_at) RETURNING id INTO bank_id;
   INSERT INTO accounting_cash_bank_receipts VALUES(NEW.id,game_union,NEW.club_id,bank_id,NULL,NEW.created_at,NEW.rake_amount);
  ELSE
   INSERT INTO chip_ledger(from_type,to_type,to_entity_id,club_id,amount,category,created_at)
    VALUES('table_stack','chip_retirement',NULL,NEW.club_id,NEW.rake_amount,'burn',NEW.created_at) RETURNING id INTO bank_id;
   INSERT INTO accounting_cash_bank_receipts VALUES(NEW.id,NULL,NEW.club_id,NULL,bank_id,NEW.created_at,NEW.rake_amount);
  END IF;
 END IF;RETURN NEW;END$$;
CREATE TRIGGER test_seed_source_bank AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION test_seed_source_bank();
INSERT INTO clubs VALUES(u(10),u(20),false),(u(20),u(20),true),(u(40),NULL,false);
UPDATE agents SET role='sub_agent',commission_rate=.25,parent_agent_id=u(2) WHERE id=u(1);
INSERT INTO agents(id,club_id,user_id,parent_agent_id,role,status,commission_rate) VALUES(u(2),u(10),u(21),u(3),'agent','active',.5),(u(3),u(10),u(31),NULL,'super_agent','active',.4);
INSERT INTO club_members(club_id,user_id,agent_id,role,status,is_active) VALUES(u(10),u(13),u(11),'player','approved',true),(u(40),u(41),NULL,'player','active',true);
INSERT INTO rake_records(id,hand_id,club_id,rake_amount,created_at,metadata) VALUES(u(100),u(101),u(20),10,clock_timestamp(),jsonb_build_object('accounting_source_version',2,'union_id',u(20),'is_private',false));
INSERT INTO rake_attributions VALUES(u(102),u(100),u(101),u(12),u(10),4),(u(103),u(100),u(101),u(13),u(10),6);
