-- Scoped native dependencies; source authority bodies are installed separately.
CREATE SCHEMA fixture;
CREATE FUNCTION fixture.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT lpad(n::text,32,'0')::uuid$$;
CREATE FUNCTION fixture.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label;END $$;
INSERT INTO auth.users(id) SELECT fixture.u(x) FROM generate_series(900,908) x;
INSERT INTO profiles(id,username,is_horse) SELECT fixture.u(x),'weekly_native_'||x,x IN(904,905,908) FROM generate_series(900,908) x;
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset) VALUES(fixture.u(101),'Original A',fixture.u(901),1000,'chips'),(fixture.u(102),'Original B',fixture.u(902),1000,'chips');
INSERT INTO unions(id,name,slug,owner_id,settings) VALUES(fixture.u(201),'Original Union','original-union-native',fixture.u(900),'{"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":0.1,"eco_include_horses":true}');
INSERT INTO union_clubs(id,union_id,club_id,club_commission_rate) VALUES(fixture.u(1),fixture.u(201),fixture.u(101),0.9),(fixture.u(2),fixture.u(201),fixture.u(102),0.9);
INSERT INTO cash_games(id,club_id,union_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES(fixture.u(300),fixture.u(101),fixture.u(201),'Original game','classic','nlh',1,2,9,'{}');
INSERT INTO tables(id,name,game_type,cluster_id,club_id,union_id,min_buy_in,max_buy_in,is_private,status,max_players) VALUES(fixture.u(301),'Original table','cash',fixture.u(300),fixture.u(101),fixture.u(201),1,1000,false,'waiting',9);
INSERT INTO club_members(user_id,club_id,chip_balance,role,status) VALUES(fixture.u(903),fixture.u(102),500,'player','active'),(fixture.u(904),fixture.u(101),500,'player','active'),(fixture.u(905),fixture.u(101),500,'player','active');
INSERT INTO union_wallets(union_id,chip_balance,rake_wallet) VALUES(fixture.u(201),1000,0);
-- Independent raked-hand book; synthetic opening balances precede all money triggers.
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(104),'Raked member',fixture.u(901),1000,'chips',false,NULL),
 (fixture.u(203),'Raked Union house',fixture.u(900),1000,'chips',true,NULL);
INSERT INTO unions(id,name,slug,owner_id,settings) VALUES(fixture.u(203),'Raked Union','raked-union-native',fixture.u(900),'{"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":0.1,"eco_include_horses":true}');
UPDATE clubs SET union_id=fixture.u(203) WHERE id IN(fixture.u(104),fixture.u(203));
INSERT INTO union_clubs(id,union_id,club_id,club_commission_rate) VALUES(fixture.u(3),fixture.u(203),fixture.u(104),0.9),(fixture.u(4),fixture.u(203),fixture.u(203),0.9);
INSERT INTO club_members(user_id,club_id,chip_balance,role,status) VALUES(fixture.u(907),fixture.u(104),500,'player','active'),(fixture.u(908),fixture.u(203),500,'player','active');
INSERT INTO union_wallets(union_id,chip_balance,rake_wallet) VALUES(fixture.u(203),1000,0);
INSERT INTO cash_games(id,club_id,union_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES(fixture.u(304),fixture.u(203),fixture.u(203),'Original raked game','classic','nlh',2,4,9,'{}');
INSERT INTO tables(id,name,game_type,cluster_id,club_id,union_id,min_buy_in,max_buy_in,is_private,status,max_players) VALUES(fixture.u(305),'Original raked table','cash',fixture.u(304),fixture.u(203),fixture.u(203),1,1000,false,'waiting',9);
CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW WHEN(OLD.chip_balance IS DISTINCT FROM NEW.chip_balance) EXECUTE FUNCTION public.fn_club_members_ledger_writer();
CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_ca_chip_ledger_enrich();
CREATE TRIGGER trg_chip_ledger_performed_by BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.enforce_chip_ledger_performed_by();
-- Missing from the bounded September14 capture; columns read live00:05UTC.
CREATE TABLE public.cash_rejoin_constraints(id uuid NOT NULL DEFAULT gen_random_uuid(),player_id uuid NOT NULL,club_id uuid NOT NULL,
 variant text NOT NULL,sb numeric(14,2) NOT NULL,bb numeric(14,2) NOT NULL,required_stack numeric(14,2) NOT NULL,
 left_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,source_table_id uuid,barred_until timestamptz);

-- Original admission identity and scope owners, required by real constraints.
CREATE TRIGGER trg_stamp_seat_horse_id BEFORE INSERT OR UPDATE OF user_id, horse_id ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_horse_id();
CREATE TRIGGER trg_table_seats_stamp_club BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_club();
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_active_seat_game_scope();
CREATE TRIGGER zzzzz_require_live_seat_parent BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_require_live_seat_parent();
CREATE TRIGGER zzzzz_seat_parent_keys_match BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION trg_seat_parent_keys_match();

-- Original settlement ledger, document and delivery owners from accepted37.
CREATE TRIGGER accounting_invoice_deliver AFTER INSERT ON public.settlement_invoices FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_invoice_deliver_on_insert();
CREATE TRIGGER accounting_invoice_immutable BEFORE DELETE OR UPDATE ON public.settlement_invoices FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_document_immutable();
CREATE TRIGGER accounting_message_immutable BEFORE DELETE OR UPDATE ON public.social_messages FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_document_immutable();
CREATE TRIGGER accounting_transfer_document AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.status = 'posted'::text) AND ((new.from_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text])) OR ((new.from_type = 'settlement_suspense'::text) AND (new.category = 'rakeback'::text))) AND (new.to_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text])))) EXECUTE FUNCTION public.fn_accounting_transfer_document_on_insert();
CREATE TRIGGER trg_ca_autoledger AFTER INSERT OR UPDATE OF chip_treasury, chip_pool, promo_balance, insurance_balance ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('chip_treasury=club_treasury', 'chip_pool=club_treasury', 'promo_balance=promo_wallet', 'insurance_balance=insurance_bank');
CREATE TRIGGER trg_ca_autoledger AFTER INSERT OR UPDATE OF chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, spin_reserve_wallet ON public.union_wallets FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('chip_balance=union_bank', 'rake_wallet=union_wallet', 'bbj_wallet=union_wallet', 'promo_wallet=union_wallet', 'insurance_wallet=union_wallet', 'spin_reserve_wallet=union_wallet');
-- Captured source cutovers are real prerequisite rows, placed on this isolated
-- fixture's calendar before its first complete week (no monetary source rows).
INSERT INTO accounting_cash_accrual_cutover(singleton,starts_at) VALUES(true,'2026-09-04 12:00Z');

-- Original tournament entry, charge and escrow owners.
CREATE TRIGGER zz_ca_escrow_wallet_tx AFTER INSERT ON wallet_transactions FOR EACH ROW WHEN (new.related_entity_id IS NOT NULL) EXECUTE FUNCTION fn_ca_escrow_on_wallet_tx();
CREATE TRIGGER trg_sync_tournament_current_players AFTER INSERT OR DELETE OR UPDATE OF status, tournament_id ON tournament_players FOR EACH ROW EXECUTE FUNCTION fn_sync_tournament_current_players();
CREATE TRIGGER trg_tournament_players_stamp_club BEFORE INSERT OR UPDATE ON tournament_players FOR EACH ROW WHEN (new.club_id IS NULL) EXECUTE FUNCTION fn_stamp_entry_club();
CREATE TRIGGER aa_ca_capture_tournament_charge_entitlement AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.tournament_id IS NOT NULL AND new.from_type = 'player_wallet'::text AND new.to_type = 'prize_liability'::text) EXECUTE FUNCTION fn_ca_capture_tournament_charge_entitlement();
CREATE TABLE public.ca_mtt_admission_contract(singleton boolean PRIMARY KEY,abi text NOT NULL);
INSERT INTO public.ca_mtt_admission_contract VALUES(true,'legacy-capacity-v1');

CREATE TRIGGER stamp_tournament_terminal_evidence_markers AFTER INSERT OR UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_terminal_evidence_markers();
INSERT INTO ca_settle_sources(source,note) VALUES('fn_unregister_from_tournament','Original refund owner present in qualified source registry');

-- Original commercial observations for the real raked-hand case.
CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF club_id, user_id, agent_id, parent_agent_id, role, status, is_active, commission_rate, rakeback_rate, player_rakeback_pct ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_capture();
CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, union_id, club_commission_rate, rate_cash, rate_mtt, rate_sng, rate_spin, rate_satellite ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_capture();
