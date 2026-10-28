CREATE SCHEMA smarter_private;
CREATE FUNCTION fixture_clock()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('test.now',true),''),'2026-10-26 08:00Z')::timestamptz$$;
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean,union_id uuid);
CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE agents(club_id uuid,is_prepaid boolean,credit_used numeric);
CREATE TABLE union_accounting_runs(union_id uuid,standalone_club_id uuid,period_start timestamptz,period_end timestamptz,scheduled_at timestamptz,status text,attempts int,started_at timestamptz,finished_at timestamptz,result jsonb,last_scheduler_visit_at timestamptz,
 scope_kind text GENERATED ALWAYS AS(CASE WHEN union_id IS NOT NULL THEN 'union' ELSE 'club' END)STORED,scope_id uuid GENERATED ALWAYS AS(coalesce(union_id,standalone_club_id))STORED,
 UNIQUE(union_id,period_start,period_end),UNIQUE(scope_kind,scope_id,period_start,period_end));
CREATE TABLE weekly_accounting_scheduler_visits(scope_kind text,scope_id uuid,last_visit_at timestamptz,last_outcome text,last_error jsonb,unfinished_visits int,PRIMARY KEY(scope_kind,scope_id));
CREATE TABLE financial_alerts(source text,severity text,message text,context jsonb,resolved boolean,created_at timestamptz DEFAULT now(),resolved_at timestamptz,resolution text);
CREATE TABLE accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end,window_start));
CREATE TABLE accounting_cash_accrual_cutover(singleton boolean,starts_at timestamptz);INSERT INTO accounting_cash_accrual_cutover VALUES(true,'2026-09-01');
ALTER TABLE accounting_cash_rake_sources ADD COLUMN coordinator_union_id uuid;
ALTER TABLE accounting_tournament_fee_sources ADD COLUMN coordinator_union_id uuid;
CREATE TABLE daemon_state(daemon text,high_water_mark timestamptz,high_water_mark_id uuid);
CREATE TABLE rake_records(id uuid,club_id uuid,created_at timestamptz,is_tournament boolean,tournament_id uuid,rake_amount numeric);
CREATE TABLE ca_settlements(settlement_type text,union_id uuid,state text,totals jsonb,external_ref text);
ALTER TABLE settlement_periods ADD COLUMN id uuid,ADD COLUMN club_id uuid;
ALTER TABLE settlement_invoices ADD COLUMN period_id uuid;
CREATE TABLE fixture_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,PRIMARY KEY(kind,union_id,period_start,period_end));
CREATE OR REPLACE FUNCTION fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM fixture_certificates WHERE kind=$1 AND union_id=$2 AND period_start=$3 AND period_end=$4$$;
CREATE OR REPLACE FUNCTION fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)RETURNS void LANGUAGE sql AS $$INSERT INTO fixture_certificates VALUES($1,$2,$3,$4,$5)ON CONFLICT(kind,union_id,period_start,period_end)DO UPDATE SET value=excluded.value$$;
CREATE FUNCTION fn_accounting_close_proof_lifetime()RETURNS interval LANGUAGE sql IMMUTABLE AS $$SELECT interval '8 days'$$;
CREATE FUNCTION fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)RETURNS TABLE(value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea)LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO phase_trace(event)VALUES('fee_window');
 IF current_setting('test.window_refused',true)='on'THEN RETURN;END IF;
 RETURN QUERY SELECT jsonb_build_object('bank_sum',1,'source_sum',1,'house_sum',0,'basis',jsonb_build_array(jsonb_build_object('club_id',c(),'game_type','cash','rake_in',1,'weighted',.9))),ARRAY[md5($2::text)::uuid],decode(md5($2::text),'hex'),ARRAY[]::uuid[],''::bytea;END$$;
CREATE FUNCTION fn_accounting_union_earned_plan_v3(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'original_window_source_refused';END$$;
CREATE FUNCTION fn_accounting_union_earned_plan_sets(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'unexpected_whole_week_fallback';END$$;
CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forbidden_later_book_work_before_fees';END$$;
CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.frozen',true),'off')='on'$$;
CREATE FUNCTION fn_accounting_close_gate_holds(text,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.gate_held',true),'off')='on'$$;
CREATE FUNCTION fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_accounting_close_report_keep(uuid,timestamptz,timestamptz)RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_accounting_failure_identity(jsonb)RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT $1->>'error'$$;
CREATE FUNCTION fn_accounting_close_prepared_long(uuid,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_ca_launch_accounting_start(text,uuid,timestamptz)RETURNS timestamptz LANGUAGE sql AS $$SELECT $3$$;
CREATE FUNCTION fn_club_settlement_floor_week(uuid)RETURNS timestamptz LANGUAGE sql AS $$SELECT fn_union_prev_week_start(fixture_clock())$$;
CREATE FUNCTION fn_bank_standalone_week_rake(uuid,timestamptz,timestamptz)RETURNS void LANGUAGE plpgsql AS $$BEGIN INSERT INTO phase_trace(event)VALUES('standalone_money');END$$;
CREATE FUNCTION fn_ca_launch_accounting_cutoff(text,uuid)RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;
CREATE FUNCTION fn_accounting_close_seal_held(timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_accounting_split_advance_due()RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$;
CREATE FUNCTION fn_accounting_window_advance_due()RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$;
CREATE FUNCTION fn_ca_launch_accounting_club_cutoffs()RETURNS TABLE(club_id uuid,cutoff_at timestamptz)LANGUAGE sql AS $$SELECT NULL::uuid,NULL::timestamptz WHERE false$$;
INSERT INTO unions VALUES(u());INSERT INTO clubs VALUES(c(),false,u());INSERT INTO union_settlement_floor VALUES(u(),'2026-10-19 07:00Z');
INSERT INTO daemon_state VALUES('rakeback_settler','2026-10-26 07:00Z',NULL);
-- Controlled payout boundary: the actual monetary writers have separate native
-- qualification. This test refuses at that boundary after04; before04 it must
-- never reach any of them.
CREATE FUNCTION fn_union_settlement_cascade(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN INSERT INTO phase_trace(event)VALUES('financial_cascade');RAISE EXCEPTION 'fixture_financial_boundary_reached';END$$;
ALTER TABLE accounting_tournament_fee_sources ADD COLUMN id uuid,ADD COLUMN tournament_id uuid,ADD COLUMN union_id uuid,ADD COLUMN rake_credit numeric;
CREATE TABLE accounting_tournament_recognized_sources(source_id uuid,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid,status text,recognized_at timestamptz,union_id uuid);
CREATE SEQUENCE fixture_financial_calls MINVALUE 0 START 0;
CREATE OR REPLACE FUNCTION fn_union_settlement_cascade(uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN PERFORM nextval('fixture_financial_calls');RAISE EXCEPTION 'fixture_financial_boundary_reached';END$$;
CREATE OR REPLACE FUNCTION fn_union_pnl_closed_book_barrier(timestamptz)RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1>fixture_clock()THEN RAISE EXCEPTION 'book_not_closed';END IF;END$$;
CREATE OR REPLACE FUNCTION fn_bank_standalone_week_rake(uuid,timestamptz,timestamptz)RETURNS void LANGUAGE plpgsql AS $$BEGIN PERFORM nextval('fixture_financial_calls');RAISE EXCEPTION 'fixture_standalone_financial_boundary_reached';END$$;
CREATE OR REPLACE FUNCTION fn_club_settlement_floor_week(uuid)RETURNS timestamptz LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.club_floor',true),'')::timestamptz,fn_union_prev_week_start(fixture_clock()))$$;
ALTER TABLE accounting_routed_settlement_runs DROP CONSTRAINT accounting_routed_settlement_runs_pkey;
ALTER TABLE accounting_routed_settlement_runs ALTER COLUMN union_id DROP NOT NULL;
ALTER TABLE accounting_routed_settlement_runs ADD PRIMARY KEY(scope_kind,scope_id,period_start,period_end,round_no);

CREATE TABLE union_weekly_horse_promo_runs(union_id uuid,period_end timestamptz,PRIMARY KEY(union_id,period_end));
INSERT INTO union_weekly_horse_promo_runs VALUES(u(),'2026-10-26 07:00Z');
CREATE FUNCTION fn_accounting_close_gate_lifted_unstarted()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_union_pnl_inventory_seal_in_progress()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_settle_accounting_commission_advance(text,uuid,timestamptz,timestamptz)RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
