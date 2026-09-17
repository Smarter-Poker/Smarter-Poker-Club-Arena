INSERT INTO profiles SELECT u(n),'Fixture account '||n FROM generate_series(100,106)n;
INSERT INTO clubs(id,name,owner_id,union_id,is_union) VALUES(u(1),'Union house',u(100),u(1),true),(u(2),'Club A',u(101),u(1),false),(u(3),'Club B',u(102),NULL,false);
INSERT INTO unions VALUES(u(1),'Union',u(100));
INSERT INTO union_wallets(union_id,rake_wallet,chip_balance) VALUES(u(1),350,10);
INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-09-01Z');
INSERT INTO accounting_agreement_history VALUES
 (1,'union_clubs',u(21)::text,u(2),'2026-09-01Z',jsonb_build_object('id',u(21),'club_id',u(2),'union_id',u(1),'club_commission_rate',.9)),
 (2,'union_clubs',u(21)::text,u(2),'2026-09-10Z',jsonb_build_object('id',u(21),'club_id',u(2),'union_id',u(1),'club_commission_rate',.8)),
 (3,'union_clubs',u(31)::text,u(3),'2026-09-01Z',jsonb_build_object('id',u(31),'club_id',u(3),'union_id',u(1),'club_commission_rate',.75));
CREATE FUNCTION contract(c int,p int,credit numeric,terms_at timestamptz,hist bigint) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('player_id',u(p),'club_id',u(c),'union_id',u(1),'coordinator_union_id',u(1),'rake_credit',credit,
  'terms_at',terms_at,'is_union_house',c=1,'union_agreement',CASE WHEN hist IS NULL THEN NULL ELSE
   (SELECT jsonb_build_object('history_id',id,'observed_at',observed_at,'terms',after_terms) FROM accounting_agreement_history WHERE id=hist) END)
$$;
-- Two cash rake credits straddle a rate change; a 50-chip house source is
-- explicit, and a later recognized tournament belongs to its charge-time club.
INSERT INTO rake_records VALUES(u(40),u(140),u(1),150,'2026-09-09T12:00Z',false,NULL),(u(41),u(141),u(1),100,'2026-09-11T12:00Z',false,NULL);
INSERT INTO union_wallet_transactions(id,union_id,amount,tx_type,wallet,direction,created_at) VALUES
 (u(50),u(1),150,'rake','rake_wallet','credit','2026-09-09T12:00Z'),(u(51),u(1),100,'rake','rake_wallet','credit','2026-09-11T12:00Z'),(u(52),u(1),100,'rake','rake_wallet','credit','2026-09-12T12:00Z');
INSERT INTO accounting_cash_bank_receipts VALUES(u(40),u(1),u(1),u(50),NULL,'2026-09-09T12:00Z',150),(u(41),u(1),u(1),u(51),NULL,'2026-09-11T12:00Z',100);
INSERT INTO accounting_cash_accrual_batches VALUES(u(40),'2026-09-09T12:00Z','accrued'),(u(41),'2026-09-11T12:00Z','accrued');
INSERT INTO accounting_cash_rake_sources VALUES
 (u(60),u(40),u(103),u(2),u(1),u(1),'2026-09-09T12:00Z',100,contract(2,103,100,'2026-09-09T12:00Z',1)),
 (u(61),u(40),u(104),u(1),u(1),u(1),'2026-09-09T12:00Z',50,contract(1,104,50,'2026-09-09T12:00Z',NULL)),
 (u(62),u(41),u(103),u(2),u(1),u(1),'2026-09-11T12:00Z',100,contract(2,103,100,'2026-09-11T12:00Z',2));
INSERT INTO tournaments VALUES(u(70),'mtt');
INSERT INTO accounting_tournament_fee_sources VALUES(u(60),u(71),u(70),u(105),u(3),u(1),u(1),'2026-09-06T12:00Z',100,contract(3,105,100,'2026-09-06T12:00Z',3),'mtt');
INSERT INTO accounting_tournament_fee_recognitions VALUES(u(70),'2026-09-12T12:00Z','recognized',100,u(1),u(52),NULL);
INSERT INTO accounting_tournament_recognized_sources VALUES(u(60),u(70),'2026-09-12T12:00Z','earned',100);
CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF chip_treasury ON clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury');
CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich();
CREATE FUNCTION plan() RETURNS jsonb LANGUAGE sql AS $$SELECT fn_accounting_union_earned_plan(u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z')$$;
CREATE FUNCTION close_week() RETURNS jsonb LANGUAGE sql AS $$SELECT fn_union_weekly_rakeback_close(u(1),'2026-09-07T07:00Z','2026-09-14T07:00Z')$$;
