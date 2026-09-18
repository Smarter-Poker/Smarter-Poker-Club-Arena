-- Synthetic initial accounts/game scene only. All entry debits, entitlements,
-- reserve contributions, raw fees and settlement are produced by real owners.
CREATE SCHEMA spin_fixture;
CREATE FUNCTION spin_fixture.u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('b7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
CREATE TABLE spin_fixture.assertions(label text PRIMARY KEY);
CREATE FUNCTION spin_fixture.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO spin_fixture.assertions VALUES(label);RAISE NOTICE 'PASS %',label; END $$;
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT spin_fixture.u(n) FROM generate_series(1,4)n;
INSERT INTO public.users(id,username) SELECT spin_fixture.u(n),'mixed_spin_'||n FROM generate_series(1,4)n;
INSERT INTO public.profiles(id,username,display_name) SELECT spin_fixture.u(n),'mixed_spin_'||n,'Mixed Spin '||n FROM generate_series(1,4)n;
INSERT INTO public.clubs(id,club_id,name,chip_treasury) VALUES(spin_fixture.u(101),999781,'Original Mixed Spin',10000);
INSERT INTO public.unions(id,name,owner_id,slug) VALUES(spin_fixture.u(151),'Original Spin Union',spin_fixture.u(4),'mixed-spin-union');
INSERT INTO public.clubs(id,club_id,name,chip_treasury,union_id) VALUES(spin_fixture.u(102),999782,'Original Union Spin',10000,spin_fixture.u(151));
INSERT INTO public.union_clubs(union_id,club_id) VALUES(spin_fixture.u(151),spin_fixture.u(102));
INSERT INTO public.union_wallets(union_id,spin_reserve_wallet) VALUES(spin_fixture.u(151),1000);
INSERT INTO public.club_wallets(club_id) VALUES(spin_fixture.u(101)),(spin_fixture.u(102));
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at)
 SELECT spin_fixture.u(c),spin_fixture.u(n),'player','active',100,now()-interval '1 day' FROM generate_series(1,4)n CROSS JOIN generate_series(101,102)c;
INSERT INTO public.agents(id,club_id,user_id,role,commission_rate,player_rakeback_rate,status)
 VALUES(spin_fixture.u(801),spin_fixture.u(101),spin_fixture.u(4),'agent',.25,0,'active');
UPDATE public.club_members SET agent_id=spin_fixture.u(4) WHERE club_id=spin_fixture.u(101) AND user_id IN(spin_fixture.u(1),spin_fixture.u(2),spin_fixture.u(3));
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'agents',a.id::text,a.club_id,a.user_id,'baseline',transaction_timestamp()-interval '1 day',to_jsonb(a) FROM public.agents a WHERE id=spin_fixture.u(801);
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
 SELECT 'club_members',m.club_id::text||':'||m.user_id::text,m.club_id,m.user_id,'baseline',transaction_timestamp()-interval '1 day',to_jsonb(m)
 FROM public.club_members m WHERE m.club_id IN(spin_fixture.u(101),spin_fixture.u(102));
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,observed_at,after_terms)
 SELECT 'union_clubs',u.id::text,u.club_id,'baseline',transaction_timestamp()-interval '1 day',to_jsonb(u) FROM public.union_clubs u WHERE club_id=spin_fixture.u(102);
INSERT INTO public.tournaments(id,club_id,name,variant,tournament_type,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
 current_players,max_players,current_level,prize_pool,total_rake,bounty_pool,entry_contract_locked,is_rebuy,is_reentry,
 rebuy_levels,late_reg_levels,late_reg_mins,is_private,union_id,min_players,table_size)
 VALUES(spin_fixture.u(201),spin_fixture.u(101),'Original Mixed Spin','spin','SPIN',2,0,300,now()+interval '1 day','REGISTERING',0,3,1,0,0,0,false,false,false,0,0,0,false,NULL,3,3);
INSERT INTO public.tournaments SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
 'id',spin_fixture.u(202),'club_id',spin_fixture.u(102),'union_id',spin_fixture.u(151),'name','Original Union Mixed Spin'))).*
 FROM public.tournaments t WHERE t.id=spin_fixture.u(201);
INSERT INTO public.managed_game_contract_versions(game_kind,game_id,club_id,union_id,version,contract,contract_hash,published_at,change_reason)
 SELECT 'tournament',t.id,t.club_id,t.union_id,1,public.fn_managed_game_contract_document('tournament',to_jsonb(t)),
  public.fn_managed_game_contract_hash(public.fn_managed_game_contract_document('tournament',to_jsonb(t))),transaction_timestamp(),'created'
 FROM public.tournaments t WHERE id IN(spin_fixture.u(201),spin_fixture.u(202));
INSERT INTO public.spin_bonus_pools(club_id,balance,is_active,owner_kind) VALUES(spin_fixture.u(101),1000,true,'club'),(spin_fixture.u(151),1000,true,'union');
SET LOCAL session_replication_role=origin;
COMMIT;
-- Real original seat-first registration core, with its existing financial
-- triggers enabled. The table/seat scene is supplied before book_entry below.
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',spin_fixture.u(1),'role','authenticated')::text,true);
SELECT spin_fixture.assert(public.fn_register_for_tournament_before_atomic_capacity_20260907(spin_fixture.u(201),true)->>'ok'='true','First original entry succeeds');
COMMIT;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',spin_fixture.u(2),'role','authenticated')::text,true);
SELECT spin_fixture.assert(public.fn_register_for_tournament_before_atomic_capacity_20260907(spin_fixture.u(201),true)->>'ok'='true','Second original entry succeeds');
COMMIT;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',spin_fixture.u(1),'role','authenticated')::text,true);
SELECT spin_fixture.assert(public.fn_register_for_tournament_before_atomic_capacity_20260907(spin_fixture.u(202),true)->>'ok'='true','Original Union entry before cutover succeeds');
COMMIT;
-- Establish the one cutover of this synthetic scene between real entries.
-- This is only isolated fixture construction, never a successor migration write.
BEGIN;
SET LOCAL session_replication_role=replica;
UPDATE public.accounting_tournament_fee_cutover SET starts_at=clock_timestamp();
SET LOCAL session_replication_role=origin;
COMMIT;
BEGIN;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',spin_fixture.u(3),'role','authenticated')::text,true);
SELECT spin_fixture.assert(public.fn_register_for_tournament_before_atomic_capacity_20260907(spin_fixture.u(201),true)->>'ok'='true','Third original entry succeeds');
SET LOCAL session_replication_role=replica;
INSERT INTO public.tables(id,club_id,tournament_id,name,game_type,max_players,status,starting_chips,seat_game_scope,seat_admission_key)
 VALUES(spin_fixture.u(301),spin_fixture.u(101),spin_fixture.u(201),'Original Spin Table','tournament',3,'waiting',300,'table:'||spin_fixture.u(301)::text,'tournament:'||spin_fixture.u(201)::text);
INSERT INTO public.table_seats(id,table_id,user_id,seat_number,stack,club_id,occupancy_id,active_game_scope,active_parent_key)
 SELECT spin_fixture.u(400+n),spin_fixture.u(301),spin_fixture.u(n),n,300,spin_fixture.u(101),spin_fixture.u(500+n),
  'table:'||spin_fixture.u(301)::text,'tournament:'||spin_fixture.u(201)::text FROM generate_series(1,3)n;
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SELECT spin_fixture.assert(public.fn_spin_book_entry(spin_fixture.u(201))->>'ok'='true','Original Spin owner books actual three charges and reserve');
COMMIT;
SELECT spin_fixture.assert((SELECT count(*)=1 AND min(b.status)='legacy_unverified' AND bool_and(b.source_manifest IS NULL)
 FROM public.accounting_tournament_fee_batches b WHERE tournament_id=spin_fixture.u(201)),'Original stamp reproduces mixed-cutover legacy refusal');
SELECT spin_fixture.assert((SELECT count(*)=3 AND sum(l.amount)=6 FROM public.chip_ledger l
 WHERE l.tournament_id=spin_fixture.u(201) AND l.category='tournament_buyin'),'Original entry owner produced three exact journal debits');
CREATE TABLE spin_fixture.original_batch AS SELECT to_jsonb(b) original FROM public.accounting_tournament_fee_batches b WHERE tournament_id=spin_fixture.u(201);
-- The cards/finish state is synthetic. The existing financial close and all
-- bank, source, escrow, recognition, commission and immutable guards stay live.
BEGIN;SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='COMPLETING' WHERE id=spin_fixture.u(201);
SET LOCAL session_replication_role=origin;COMMIT;
DO $$ BEGIN
 BEGIN
  PERFORM public.fn_settle_tournament_rake(spin_fixture.u(201),'mixed-cutover-before');
  RAISE EXCEPTION 'Original mixed cutover unexpectedly settled';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN
  IF SQLERRM NOT LIKE '%rake attribution incomplete: tournament_fee_sources_require_reconciliation' THEN RAISE; END IF;
 END;
 PERFORM spin_fixture.assert(NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=spin_fixture.u(201)),
  'Before successor real settlement refuses and rolls its claim back');
END $$;

-- A real later agreement change cannot replace earning-time history.
UPDATE public.agents SET commission_rate=.50 WHERE id=spin_fixture.u(801);
