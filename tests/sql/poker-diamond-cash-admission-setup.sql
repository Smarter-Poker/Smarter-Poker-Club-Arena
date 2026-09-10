-- Run after the isolated custody contract, in the same dedicated database.
DO $$ BEGIN
 IF current_database()<>'poker_diamond_phase6_test' OR inet_server_addr() IS NOT NULL
    OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated phase6 fixture only'; END IF;
END $$;
ALTER TABLE public.clubs ADD COLUMN club_id integer, ADD COLUMN slug text, ADD COLUMN lifecycle_status text DEFAULT 'active';
ALTER TABLE public.club_members ADD COLUMN user_id uuid, ADD COLUMN role text, ADD COLUMN status text;
ALTER TABLE public.tables ADD COLUMN small_blind numeric DEFAULT 1,
 ADD COLUMN big_blind numeric DEFAULT 2, ADD COLUMN ante numeric DEFAULT 0,
 ADD COLUMN max_players integer DEFAULT 6,
 ADD COLUMN is_template boolean DEFAULT false, ADD COLUMN current_players integer DEFAULT 0,
 ADD COLUMN is_vip_only boolean DEFAULT false, ADD COLUMN rake_percent numeric DEFAULT 0,
 ADD COLUMN bbj_percent numeric DEFAULT 0, ADD COLUMN cluster_id uuid,
 ADD COLUMN insurance_enabled boolean DEFAULT false, ADD COLUMN bomb_pot_enabled boolean DEFAULT false,
 ADD COLUMN run_it_twice_enabled boolean DEFAULT false, ADD COLUMN run_it_twice boolean DEFAULT false,
 ADD COLUMN allow_run_it_twice boolean DEFAULT false, ADD COLUMN straddle_enabled boolean DEFAULT false,
 ADD COLUMN seven_deuce_enabled boolean DEFAULT false, ADD COLUMN nit_game boolean DEFAULT false,
 ADD COLUMN all_in_or_fold boolean DEFAULT false, ADD COLUMN pineapple_holdem boolean DEFAULT false,
 ADD COLUMN cap_enabled boolean DEFAULT false,
 ADD COLUMN auto_utg_straddle boolean DEFAULT false, ADD COLUMN voluntary_straddle boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN is_vip boolean DEFAULT false, ADD COLUMN vip_expires_at timestamptz;
ALTER TABLE public.tournaments ADD COLUMN variant text, ADD COLUMN max_players integer, ADD COLUMN starting_chips numeric;
ALTER TABLE public.table_seats ADD COLUMN status text DEFAULT 'active',
 ADD COLUMN auto_rebuy boolean DEFAULT false, ADD COLUMN leave_pending boolean DEFAULT false;
CREATE UNIQUE INDEX fixture_live_chair ON public.table_seats(table_id,seat_number) WHERE left_at IS NULL;
CREATE TABLE public.blacklists(id uuid DEFAULT gen_random_uuid(),user_id uuid,club_id uuid,expires_at timestamptz);
CREATE TABLE public.table_waitlist(table_id uuid,user_id uuid,status text,
 hold_expires_at timestamptz,notified_at timestamptz);
CREATE TABLE public.engine_maintenance_break(phase text,enforce_freeze boolean DEFAULT true,
 announced_at timestamptz,break_started_at timestamptz,break_ends_at timestamptz);
CREATE TABLE public.engine_maintenance_thaws(contract_version integer,release_target_at timestamptz,shifted jsonb);
CREATE TABLE public.entry_purchase_idempotency_receipts(
 key_domain text,idempotency_key text,request jsonb NOT NULL,response jsonb,completed_at timestamptz,
 PRIMARY KEY(key_domain,idempotency_key));
CREATE TABLE public.transaction_idempotency_keys(key uuid PRIMARY KEY,user_id uuid,action text,amount numeric);
CREATE TABLE public.seat_cashout_receipts(occupancy_id uuid PRIMARY KEY,user_id uuid,table_id uuid,
 seat_id uuid,seat_number integer,receipt jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE public.seat_departure_requests(occupancy_id uuid,user_id uuid,table_id uuid,seat_number integer,leave_mode text);
CREATE TABLE public.seat_admin_departure_authorizations(occupancy_id uuid,user_id uuid,table_id uuid,seat_number integer);
DROP TABLE IF EXISTS auth.sessions;
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,not_after timestamptz);
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$
 SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
 nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') $$;
\ir poker-diamond-cash-admission-prerequisites.sql
CREATE TRIGGER poker_arena_chip_seat_guard BEFORE INSERT OR UPDATE OF table_id ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_poker_guard_chip_seat();
CREATE TRIGGER trg_ca_guard_seat_creation BEFORE INSERT OR UPDATE OF left_at ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_seat_creation();
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_occupancy();
CREATE TRIGGER trg_log_seat_stack_exit BEFORE DELETE OR UPDATE OF left_at ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_log_seat_stack_exit();
CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated AFTER UPDATE OF left_at
 ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.trg_fn_close_session_when_seat_vacated();
\ir ../../supabase/migrations/20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql
CREATE FUNCTION fixture_diamond_buyin(a numeric DEFAULT 100,k uuid DEFAULT '40000000-0000-0000-0000-000000000006')
 RETURNS void LANGUAGE sql AS $$
 SELECT public.atomic_table_buyin('10000000-0000-0000-0000-000000000001',
 '30000000-0000-0000-0000-000000000001',1,a,false,
 '20000000-0000-0000-0000-000000000001',k) $$;
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','diamond_cash_not_open');
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT count(*)=0 FROM entry_purchase_idempotency_receipts),
 'closed release gate leaves wallets and purchase receipts unchanged');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT fixture_assert((fn_poker_arena_context('20000000-0000-0000-0000-000000000001')->>'cashGamesEnabled')::boolean=false,
 'authenticated arena context reflects closed cash admission');
-- Local-only certification enables its own fixture settings. Never run on production.
UPDATE ca_arena_settings SET cash_games_enabled=true WHERE id=1;
SELECT fixture_assert((fn_poker_arena_context('20000000-0000-0000-0000-000000000001')->>'cashGamesEnabled')::boolean=true,
 'authenticated arena context reflects enabled isolated cash admission');
INSERT INTO auth.sessions(id) VALUES('60000000-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000009"}',false);
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','SESSION_REVOKED');
SELECT set_config('request.jwt.claims','{"role":"authenticated","session_id":"60000000-0000-0000-0000-000000000001"}',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',false);
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','Cannot buy in for another user');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);
INSERT INTO engine_maintenance_break(phase,announced_at) VALUES('last_hand',now());
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','PLATFORM_FROZEN');
DELETE FROM engine_maintenance_break WHERE phase='last_hand';
BEGIN;
UPDATE tables SET small_blind=0.5 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','diamond_cash_requires_whole_amounts');
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT count(*)=0 FROM table_seats WHERE left_at IS NULL)
 AND (SELECT count(*)=0 FROM poker_diamond_custody WHERE state IN ('active','reserved'))
 AND (SELECT count(*)=0 FROM entry_purchase_idempotency_receipts),
 'fractional table blind refuses before wallet custody seat or purchase receipt writes');
ROLLBACK;
SELECT fixture_refuses('SELECT fixture_diamond_buyin(100.5)','invalid_diamond_cash_purchase');
SELECT fixture_refuses('SELECT fixture_diamond_buyin(100,NULL)','invalid_diamond_cash_purchase');
UPDATE tables SET cluster_id='70000000-0000-0000-0000-000000000001' WHERE id='30000000-0000-0000-0000-000000000001';
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','diamond_plain_cash_table_required');
UPDATE tables SET cluster_id=NULL WHERE id='30000000-0000-0000-0000-000000000001';
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT count(*)=0 FROM entry_purchase_idempotency_receipts),
 'auth, maintenance and amount refusals leave no debit or incomplete receipt');

CREATE FUNCTION fixture_refuse_funded_seat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fixture_seat_insert_failed_after_reserve'; END $$;
CREATE TRIGGER zz_fixture_refuse_funded_seat BEFORE INSERT ON table_seats
 FOR EACH ROW EXECUTE FUNCTION fixture_refuse_funded_seat();
SELECT fixture_refuses('SELECT fixture_diamond_buyin()','fixture_seat_insert_failed_after_reserve');
SELECT fixture_assert((SELECT sum(diamonds)=2000 FROM profiles)
 AND (SELECT count(*)=0 FROM entry_purchase_idempotency_receipts)
 AND (SELECT count(*)=0 FROM poker_diamond_custody WHERE state='active' OR state='reserved')
 AND (SELECT sum(arena_reserved)=0 FROM diamond_purchase_lots),
 'seat insertion failure rolls back wallet, lots, custody and purchase receipt');
DROP TRIGGER zz_fixture_refuse_funded_seat ON table_seats;
