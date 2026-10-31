-- Two synthetic, independently priced standalone clubs. Financial stage,
-- payer, ledger and invoice owners are real. Scope/preparation and external
-- standalone mint transport are explicit controlled native boundaries.
CREATE TABLE public.tournament_rake_settlements(destination text,settled_at timestamptz,amount numeric);
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on';
$function$;
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR UPDATE OR DELETE ON clubs FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_treasury');
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR UPDATE OR DELETE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_balance');
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR UPDATE OR DELETE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR UPDATE OR DELETE ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();
ALTER TABLE profiles ADD COLUMN is_horse boolean NOT NULL DEFAULT false;
CREATE TABLE fixture_clock(n timestamptz);
INSERT INTO fixture_clock VALUES('2026-10-12 08:58Z');
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_clock()RETURNS timestamptz
 LANGUAGE sql VOLATILE AS $$SELECT n FROM fixture_clock$$;
UPDATE smarter_private.weekly_payout_phase_configuration SET cutover_period_end='2026-10-12 07:00Z';
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_scope_plan(p_end timestamptz,p_now timestamptz)
 RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_array(
 jsonb_build_object('kind','club','id',caw_u('club'),'period_start','2026-10-05T07:00:00+00:00','period_end','2026-10-12T07:00:00+00:00'),
 jsonb_build_object('kind','club','id',caw2_u('club'),'period_start','2026-10-05T07:00:00+00:00','period_end','2026-10-12T07:00:00+00:00'))$$;
CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)
 RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('success',true,'fixture_boundary','precomputed-original-inventory')$$;
CREATE TABLE fixture_order(seq bigserial,kind text,club_id uuid);
CREATE FUNCTION fixture_observe_money()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.category='commission'AND NEW.status='posted' THEN
  INSERT INTO fixture_order(kind,club_id)VALUES('agent',NEW.club_id);
 ELSIF NEW.category='rakeback'AND NEW.status='posted' THEN
  IF current_setting('fixture.refuse_player',true)='on'THEN RAISE EXCEPTION 'fixture-player-fault';END IF;
  IF(SELECT count(*)FROM accounting_routed_settlement_runs WHERE round_no=2)<>2
   THEN RAISE EXCEPTION 'player-before-all-agent-rounds';END IF;
  INSERT INTO fixture_order(kind,club_id)VALUES('player',NEW.club_id);
 END IF;RETURN NEW;END$$;
CREATE TRIGGER fixture_observe AFTER INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fixture_observe_money();
CREATE FUNCTION public.fn_ca_fund_club(c uuid,a numeric,description text,op text)RETURNS jsonb
 LANGUAGE plpgsql AS $$DECLARE l uuid;b numeric;BEGIN
 IF EXISTS(SELECT FROM ca_mint_ledger WHERE op_id=op)THEN RETURN jsonb_build_object('ok',true,'duplicate',true,'amount',a);END IF;
 SELECT chip_treasury INTO STRICT b FROM clubs WHERE id=c FOR UPDATE;
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);
 UPDATE clubs SET chip_treasury=chip_treasury+a WHERE id=c;
 INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,description,idempotency_key,pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
 VALUES(caw_u('O'),'system_mint',caw_u('native-external-mint'),'club_treasury',c,a,'mint',c,description,op,10000,10000-a,b,b+a)RETURNING id INTO l;
 INSERT INTO ca_mint_ledger VALUES(op,l,a);
 INSERT INTO fixture_order(kind,club_id)VALUES('bank',c);
 PERFORM set_config('app.ledger_autoskip_clubs','',true);
 RETURN jsonb_build_object('ok',true,'amount',a,'ledger_id',l);
 END$$;
CREATE FUNCTION fixture_owned_seed()RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM caw_seed(false);PERFORM caw2_seed(false);
 UPDATE profiles SET is_horse=true WHERE id IN(caw_u('P1'),caw2_u('P1'));
 INSERT INTO accounting_period_recompute_requests(club_id,period_start,period_end,status,last_requested_at,attempted_at,last_result)
 SELECT id,'2026-10-05','2026-10-11','complete',now()-interval '1 hour',now(),
 jsonb_build_object('accounting_version',2,'status','ready','club_id',id,'period_start','2026-10-05','period_end','2026-10-11')FROM clubs;
 UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5(jsonb_build_object('allocations',source_allocations,'rake',rake_generated,'amount',rakeback_amount,'rate',display_rate)::text);
 UPDATE accounting_rakeback_payer_contracts pc SET source_fingerprint=c.source_fingerprint FROM accounting_rakeback_period_calculations c WHERE c.id=pc.calculation_id;
 INSERT INTO accounting_cash_bank_receipts(rake_record_id,club_id,club_ledger_id,banked_at,amount)
 SELECT rake_record_id,club_id,gen_random_uuid(),earned_at,rake_credit FROM accounting_cash_rake_sources;
 INSERT INTO engine_table_leases VALUES(caw_u('table'),'fixture-engine','fixture',now(),'2026-10-12 08:58Z',caw_u('lease'),2);
 INSERT INTO weekly_accounting_payout_pauses(run_id,ownership_token,period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)
 VALUES(caw_u('owned-run'),caw_u('owned-token'),'2026-10-05 07:00Z','2026-10-12 07:00Z','2026-10-12 08:58Z','2026-10-12 09:00Z','2026-10-12 09:04Z','2026-10-12 09:05Z',smarter_private.weekly_payout_scope_plan('2026-10-12 07:00Z','2026-10-12 08:58Z'));
 UPDATE dr_controls SET frozen=true;
 END$$;
CREATE FUNCTION fixture_owned_ack()RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM public.fn_weekly_accounting_payout_pause_ack(caw_u('owned-run'),caw_u('owned-token'),'fixture-engine',jsonb_build_array(jsonb_build_object('scope','cash','table_id',caw_u('table'),'tournament_id',NULL,'lease_generation',caw_u('lease'))));END$$;
CREATE FUNCTION fixture_owned_assert()RETURNS void LANGUAGE plpgsql AS $$DECLARE c uuid;u uuid;BEGIN
 FOREACH c IN ARRAY ARRAY[caw_u('club'),caw2_u('club')]LOOP
  PERFORM caw_assert((SELECT chip_treasury=1421 FROM clubs WHERE id=c),'club-mint500-minus65agent-minus14player');
  PERFORM caw_assert((SELECT count(*)=2 AND sum(agent_wallet_balance)=526 FROM agents WHERE club_id=c AND user_id<>CASE WHEN c=caw_u('club')THEN caw_u('S')ELSE caw2_u('S')END),'owner500-and-A26');
  PERFORM caw_assert((SELECT count(*)=4 AND sum(chip_balance)=28 FROM club_members WHERE club_id=c AND role='player'),'all-player-benefits28');
 END LOOP;
 PERFORM caw_assert((SELECT sum(chip_treasury)FROM clubs)+(SELECT sum(chip_balance)FROM club_members)+(SELECT sum(agent_wallet_balance)FROM agents)=7000,'all-wallets-plus-external-mint-conserved');
 PERFORM caw_assert(NOT EXISTS(SELECT FROM chip_ledger l WHERE l.category IN('commission','rakeback') AND l.to_type IN('agent_wallet','player_wallet') AND NOT EXISTS(SELECT FROM settlement_invoices i WHERE i.source_ledger_id=l.id AND i.message_sent)),'every-downstream-leg-has-delivered-original-invoice');
 PERFORM caw_assert((SELECT count(*)=2 AND sum(amount)=1000 FROM ca_mint_ledger),'two-standalone-bank-receipts');
 PERFORM caw_assert((SELECT max(seq)FROM fixture_order WHERE kind='bank')<(SELECT min(seq)FROM fixture_order WHERE kind='agent'),'all-bank-before-agent');
 PERFORM caw_assert((SELECT max(seq)FROM fixture_order WHERE kind='agent')<(SELECT min(seq)FROM fixture_order WHERE kind='player'),'all-agent-before-player');
 PERFORM caw_assert((SELECT count(*)=4 FROM accounting_routed_settlement_runs),'four-real-stage-receipts');
 PERFORM caw_assert((SELECT count(*)=8 FROM rakeback_period_payouts WHERE status='paid'),'eight-paid-original-payouts');
 PERFORM caw_assert((SELECT phase='released'AND result->>'success'='true'FROM weekly_accounting_payout_pauses),'durable-original-success');
 PERFORM caw_assert(NOT EXISTS(SELECT FROM smarter_private.weekly_payout_owned_transactions),'private-capability-retired');
 END$$;
