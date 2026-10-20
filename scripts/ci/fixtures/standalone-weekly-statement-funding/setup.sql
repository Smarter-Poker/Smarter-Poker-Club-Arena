-- Actual bank/fund/autoledger/enrich/summary/issuer bodies are loaded separately.
-- External access/epoch, quality, routing and delivery boundaries are controlled
-- fixture collaborators, not evidence of production authorization or delivery.
CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SEQUENCE public.chip_ledger_chain_seq;
CREATE TABLE public.ca_mint_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),op_id text NOT NULL UNIQUE,action text NOT NULL,asset text NOT NULL,holder_type text NOT NULL,holder_id uuid,holder_label text,amount numeric NOT NULL,balance_before numeric,balance_after numeric,supply_after numeric,reason text,performed_by uuid,performed_by_label text,db_role text DEFAULT current_user,created_at timestamptz NOT NULL DEFAULT now(),chip_ledger_id uuid,diamond_tx_id uuid,origin text);
CREATE UNIQUE INDEX ca_mint_ledger_chip_leg_uidx ON public.ca_mint_ledger(chip_ledger_id) WHERE chip_ledger_id IS NOT NULL;
CREATE TABLE public.tournament_rake_settlements(tournament_id uuid PRIMARY KEY,amount numeric NOT NULL,destination text NOT NULL,settled_at timestamptz NOT NULL);
CREATE SCHEMA smarter_private;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.role()='service_role'$$;
CREATE FUNCTION public.fn_accounting_party_users(text,uuid) RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE AS $$SELECT '20000000-0000-0000-0000-000000000001'::uuid$$;
CREATE FUNCTION public.fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE FUNCTION public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"status":"ready"}'::jsonb$$;
CREATE FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT NULL::jsonb$$;
CREATE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql STABLE AS $$SELECT ARRAY[]::text[]$$;
CREATE FUNCTION smarter_private.original_inventory_proof_sources_match() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
CREATE FUNCTION smarter_private.original_inventory_basis_generation() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'fixture-unchanged-generation'::text$$;
CREATE FUNCTION public.fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) RETURNS TABLE(union_id uuid,standalone_club_id uuid) LANGUAGE sql STABLE AS $$SELECT CASE WHEN $1='union' THEN $2 END,CASE WHEN $1='club' THEN $2 END$$;
CREATE FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) RETURNS TABLE(club_id uuid) LANGUAGE sql STABLE AS $$SELECT $2$$;
CREATE FUNCTION public.fn_deliver_accounting_invoice(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN UPDATE public.settlement_invoices SET message_sent=true WHERE id=$1;RETURN '{"success":true}'::jsonb;END$$;
CREATE SCHEMA fixture;
CREATE FUNCTION fixture.u(integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('10000000-0000-0000-0000-'||lpad($1::text,12,'0'))::uuid$$;
INSERT INTO public.clubs(id,name,is_union,chip_treasury) VALUES(fixture.u(1),'Standalone fixture',false,1000);
INSERT INTO public.settlement_periods(id,club_id,period_number,year,start_at,end_at,status) VALUES(fixture.u(2),fixture.u(1),42,2026,'2026-10-12 07:00Z','2026-10-19 07:00Z','settled');
INSERT INTO public.union_accounting_runs(period_start,period_end,scheduled_at,status,standalone_club_id) VALUES('2026-10-12 07:00Z','2026-10-19 07:00Z','2026-10-19 07:00Z','complete',fixture.u(1));
INSERT INTO public.accounting_routed_settlement_runs(period_start,period_end,round_no,source_fingerprint,result,standalone_club_id)
 SELECT '2026-10-12 07:00Z','2026-10-19 07:00Z',n,'fixture',jsonb_build_object('success',true,'routing_version',3,'source_contract_version',3,'scope_kind','club','scope_id',fixture.u(1),'shortfalls',0),fixture.u(1) FROM generate_series(2,3)n;
INSERT INTO public.chip_ledger(id,from_type,to_type,amount,category,club_id,created_at) VALUES(fixture.u(10),'table_stack','chip_retirement',3759.56,'burn',fixture.u(1),'2026-10-17 12:00Z');
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,to_type,amount,category,club_id,created_at) VALUES(fixture.u(11),'prize_liability',fixture.u(20),'chip_retirement',319.38,'burn',fixture.u(1),'2026-10-17 13:00Z');
INSERT INTO public.accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract) VALUES(fixture.u(12),fixture.u(13),fixture.u(14),fixture.u(1),'2026-10-17 12:00Z',3759.56,'{}');
INSERT INTO public.accounting_cash_bank_receipts VALUES(fixture.u(13),NULL,fixture.u(1),NULL,fixture.u(10),'2026-10-17 12:00Z',3759.56);
INSERT INTO public.accounting_tournament_fee_sources(id,rake_record_id,tournament_id,player_id,club_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
 VALUES(fixture.u(21),fixture.u(22),fixture.u(20),fixture.u(14),fixture.u(1),'mtt',fixture.u(23),fixture.u(24),fixture.u(25),'2026-10-17 12:00Z',319.38,'{}');
INSERT INTO public.accounting_tournament_fee_recognitions VALUES(fixture.u(20),'2026-10-17 13:00Z','recognized',319.38,NULL,fixture.u(1),NULL,fixture.u(11),'fixture','{}');
INSERT INTO public.accounting_tournament_recognized_sources VALUES(fixture.u(21),fixture.u(20),'2026-10-17 13:00Z','earned',319.38);
INSERT INTO public.tournament_rake_settlements VALUES(fixture.u(20),319.38,'chip_retirement:'||fixture.u(1)::text,'2026-10-17 13:00Z');
-- Existing paid receipts are inputs to the summary; their producer was proved
-- separately. No replacement payout implementation is used here.
INSERT INTO public.chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,metadata)
 SELECT fixture.u(100+n),'club_treasury',fixture.u(1),'player_wallet',fixture.u(1000+n),CASE WHEN n=119 THEN 3.42 ELSE 1.70 END,'rakeback',fixture.u(1),jsonb_build_object('routing_version',3,'accounting_scope_kind','club','accounting_scope_id',fixture.u(1),'period_start','2026-10-12T07:00:00Z','period_end','2026-10-19T07:00:00Z') FROM generate_series(1,119)n;
INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,net_amount,status,chips_transferred,message_sent,source_ledger_id)
 SELECT club_id,'transaction_receipt','club',from_entity_id::text,'player',to_entity_id::text,amount,'paid',true,true,id FROM public.chip_ledger WHERE category='rakeback';

INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-01-01');
