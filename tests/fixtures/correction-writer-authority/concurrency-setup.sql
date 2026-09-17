\set ON_ERROR_STOP on
-- UNRUN. Separate fresh disposable full-candidate database, phase14 after
-- the prior13 phases. Real concurrent cases retain their committed evidence.
BEGIN;
SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
 OR current_setting('session_replication_role')<>'origin' OR to_regclass('public.ca_correction_request_intents_v1') IS NULL
 OR to_regclass('public.correction_writer_fixture_marker') IS NOT NULL
 THEN RAISE EXCEPTION 'fresh isolated full successor concurrency fixture required';END IF;END$guard$;
CREATE FUNCTION pg_temp.cw_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('e6361000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
\ir captured-store-policy.sql
DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM auth.users WHERE id=pg_temp.cw_id(1))
 THEN RAISE EXCEPTION 'concurrency fixture identities must be absent';END IF;END$guard$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT pg_temp.cw_id(n) FROM generate_series(1,4)n;
INSERT INTO public.users(id,username) SELECT pg_temp.cw_id(n),'correction_writer_fixture_'||n FROM generate_series(1,4)n;
INSERT INTO public.profiles(id,username,display_name) SELECT pg_temp.cw_id(n),'correction_writer_fixture_'||n,'Correction Writer Fixture '||n FROM generate_series(1,4)n;
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union,asset)
 VALUES(pg_temp.cw_id(101),963601,'Correction Writer Fixture',pg_temp.cw_id(1),1000,false,'chips');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 SELECT pg_temp.cw_id(101),pg_temp.cw_id(n),CASE n WHEN 1 THEN 'owner' ELSE 'player' END,'active',true,'active',100
 FROM generate_series(1,4)n;
INSERT INTO public.ca_drift_incidents(id,source,dedupe_key,discrepancy_amount)
 SELECT pg_temp.cw_id(300+n),'correction-writer-fixture','correction-writer-fixture:'||n,1 FROM generate_series(1,30)n;
INSERT INTO public.ca_ledger_write_failures(id,club_id,user_id,delta,sqlstate,message)
 SELECT 9636000+n,pg_temp.cw_id(101),pg_temp.cw_id(2),1,'XX000','Synthetic correction writer reference '||n FROM generate_series(1,3)n;
SET LOCAL session_replication_role=origin;
SET LOCAL session_replication_role=replica;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet)
 VALUES(pg_temp.cw_id(110),'Correction Overlay Fixture',pg_temp.cw_id(1),'correction-writer-overlay-fixture',1000,0,0,0);
INSERT INTO public.tournaments(id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,
 prize_pool,bounty_pool,bounty_pool_paid,total_rake,guaranteed_prize,current_players,payout_structure,prize_pool_finalized,
 started_at,current_level,late_reg_levels,rebuy_levels,late_reg_mins,is_rebuy,is_reentry,add_on_available)
 VALUES(pg_temp.cw_id(401),pg_temp.cw_id(101),'Correction Overlay Fixture',10,0,now(),9,'RUNNING',
 10,0,0,0,0,0,'[{"place":1,"percentage":100}]',false,now(),5,4,4,60,false,false,false);
INSERT INTO public.tournament_escrow(tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,overlay_in,
 satellite_in,prize_out,bounty_out,fee_out,refund_prize,refund_bounty,refund_fee,reserve_out,reserve_in,
 prize_balance,bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
 VALUES(pg_temp.cw_id(401),10,0,0,0,0,0,0,0,0,0,0,0,0,0,10,0,0,'correction-writer-fixture',now(),now(),true);
SET LOCAL session_replication_role=origin;
-- Fixture-only identity, atomically committed with its synthetic starting book.
-- No application role can access it. A postmaster restart or reused setup fails
-- admission; this does not authorize a production database or provider operation.
CREATE TABLE public.correction_writer_fixture_marker(
 singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 database_oid oid NOT NULL,postmaster_started_at timestamptz NOT NULL);
REVOKE ALL ON public.correction_writer_fixture_marker FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.correction_writer_fixture_marker(singleton,database_oid,postmaster_started_at)
 VALUES(true,(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time());
COMMIT;
