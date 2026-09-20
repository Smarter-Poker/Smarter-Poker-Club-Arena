-- Rollback-only retention estate. Actual creator, cancellation and owner history
-- projection writer; all real triggers remain enabled. Histories are explicitly
-- synthetic zero-money projections, never fabricated accepted-hand receipts.
CREATE TEMP TABLE retention_inputs AS SELECT
  :'execution_uuid'::uuid execution, :'ordinary_user_uuid'::uuid horse,
  :'tournament_uuid'::uuid supplied_tournament,
  '47965354-0e56-43ef-931c-ddaab82af765'::uuid owner_user,
  extensions.uuid_generate_v5(:'execution_uuid'::uuid,'retention-host') club_id;
CREATE TEMP TABLE retention_cases(
  name text PRIMARY KEY, tournament_id uuid, table_id uuid, hand_id uuid NOT NULL UNIQUE,
  original_deletes boolean NOT NULL,candidate_deletes boolean NOT NULL);
INSERT INTO retention_cases(name,tournament_id,hand_id,original_deletes,candidate_deletes)
SELECT name,CASE WHEN name IN('cash','reported','human') THEN NULL ELSE
  extensions.uuid_generate_v5(q.execution,'retention-tournament:'||name) END,
  extensions.uuid_generate_v5(q.execution,'retention-history:'||name),old_deletes,new_deletes
FROM retention_inputs q CROSS JOIN (VALUES
  ('spin',true,false),('unknown',true,false),('cash',true,true),
  ('cancelled',true,true),('cancelled_unknown',true,false),
  ('reported',false,false),('human',false,false)) c(name,old_deletes,new_deletes);
DO $estate_admission$
DECLARE q record; n text; occupied boolean;
BEGIN
 SELECT * INTO STRICT q FROM retention_inputs;
 IF q.execution::text IS DISTINCT FROM current_setting('qualification.execution_uuid',true)
   OR (SELECT count(DISTINCT x) FROM unnest(ARRAY[q.execution,q.horse,q.owner_user,q.supplied_tournament,q.club_id]) x)<>5
   OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=q.horse AND is_horse IS FALSE)
   OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=q.owner_user AND is_horse IS FALSE)
   OR md5(pg_get_functiondef('public.fn_create_seat_first_game_atomic(uuid,jsonb)'::regprocedure))<>'92cbf5680d78bdbaa4309412b3d19dfd'
   OR md5(pg_get_functiondef('public.atomic_cancel_tournament(uuid,uuid)'::regprocedure))<>'6dac23baee41ff69ee0e1243f0a26c8e'
   OR md5(pg_get_functiondef('public.fn_ca_tournament_cancellation_receipt(uuid,uuid)'::regprocedure))<>'cf0bf7f56e2e50376626c37b59cfaca8'
   OR md5(pg_get_functiondef('public.fn_cash_template_defaults(text,text)'::regprocedure))<>'f8616b0433f0420032a6233879876c79'
   OR NOT has_function_privilege(current_user,'public.fn_cash_template_defaults(text,text)','EXECUTE')
   OR md5(pg_get_functiondef('public.fn_ca_insert_hand_with_awards(jsonb,jsonb)'::regprocedure))<>'e7f05bb7d61360be7424c5f429066047' THEN
   RAISE EXCEPTION 'retention estate: exact principals and actual writer authorities required';
 END IF;
 FOREACH n IN ARRAY ARRAY['clubs','unions','union_clubs','union_creators','club_members',
   'tournaments','cash_games','tables','table_seats','tournament_players','tournament_escrow',
   'tournament_terminal_settlements','tournament_cancellation_receipts','hand_history',
   'hand_atomic_commits','settlement_idempotency_keys','hand_history_retention_policy',
   'chip_ledger','wallet_transactions','chip_transactions','ca_mint_ledger'] LOOP
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',n) INTO occupied;
   IF occupied THEN RAISE EXCEPTION 'retention estate: nonempty initial relation %',n; END IF;
 END LOOP;
END $estate_admission$;
SELECT 'retention_setup_claims',set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','service_role')::text,true),
  set_config('request.jwt.claim.sub',owner_user::text,true),set_config('request.jwt.claim.role','service_role',true)
FROM retention_inputs;
-- Same zero-opening-grant Union-host construction as the retained genuine
-- funded fixture. No Mint, balance seed, treasury transfer or entry is needed.
INSERT INTO public.union_creators(user_id,note)
SELECT owner_user,'Rollback-only retention qualification' FROM retention_inputs;
INSERT INTO public.unions(id,name,owner_id,slug,chip_balance,rake_wallet,bbj_wallet,promo_wallet,total_rake)
SELECT club_id,'Retention qualification',owner_user,'retention-'||execution,0,0,0,0,0 FROM retention_inputs;
INSERT INTO public.clubs(id,name,owner_id,is_union,chip_treasury,chip_pool,asset)
SELECT club_id,'Retention qualification',owner_user,true,0,0,'chips' FROM retention_inputs;
INSERT INTO public.union_clubs(union_id,club_id) SELECT club_id,club_id FROM retention_inputs;
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT q.club_id,u.id,'player','active',0 FROM retention_inputs q
CROSS JOIN LATERAL (VALUES(q.owner_user),(q.horse)) u(id);
SELECT set_config('app.club_membership_source','',true);
-- Exercise the actual server-owned profile update and its real social trigger;
-- no trigger is disabled and all resulting auxiliary rows must roll back.
\ir social-alias-reference.sql
UPDATE public.profiles SET is_horse=true WHERE id=(SELECT horse FROM retention_inputs);
DO $horse_social_evidence$
BEGIN
 IF (SELECT count(*) FROM public.content_authors WHERE profile_id=(SELECT horse FROM retention_inputs)
      AND is_active IS TRUE AND personality->>'seeded_by'='fn_socialize_horse')<>1
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=(SELECT horse FROM retention_inputs)
      AND is_horse IS TRUE AND social_profile_completed IS TRUE)
    OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0 OR diamond_balance IS DISTINCT FROM 0) THEN
  RAISE EXCEPTION 'retention estate: actual horse social trigger or zero profile balance differs';
 END IF;
END $horse_social_evidence$;
GRANT SELECT ON retention_inputs TO service_role;
GRANT SELECT,UPDATE ON retention_cases TO service_role;
SET LOCAL ROLE service_role;
DO $create_boards$
DECLARE q record; c record; v_config jsonb; v_result jsonb;
BEGIN
 SELECT * INTO STRICT q FROM retention_inputs;
 IF current_user<>'service_role' OR auth.role()<>'service_role' THEN
   RAISE EXCEPTION 'retention estate: real creator caller missing'; END IF;
 FOR c IN SELECT * FROM retention_cases WHERE tournament_id IS NOT NULL ORDER BY name LOOP
  v_config:=jsonb_build_object('club_id',q.club_id,'union_id',q.club_id,
    'name','Retention '||c.name,'game_type','NLH','variant','spin','tournament_type','SPIN',
    'buy_in_amount',1,'buy_in_fee',0,'guaranteed_prize',0,'starting_chips',1000,
    'max_players',3,'min_players',3,'table_size',3,'current_players',0,'status','REGISTERING',
    'blind_structure',jsonb_build_array(jsonb_build_object('level',1,'smallBlind',10,'bigBlind',20,'ante',0,'duration',180)),
    'payout_structure',jsonb_build_array(jsonb_build_object('place',1,'percentage',100)),
    'start_time',clock_timestamp()+interval '1 day','late_reg_levels',0,'late_reg_mins',0,
    'satellite_target_id',NULL,'satellite_seats',NULL,'short_description',NULL,
    'spin_multiplier',NULL,'spin_locked_tiers',NULL);
  v_result:=public.fn_create_seat_first_game_atomic(c.tournament_id,v_config);
  IF v_result->>'ok' IS DISTINCT FROM 'true' OR v_result->>'replayed' IS DISTINCT FROM 'false'
    OR v_result->'tournament'->>'id' IS DISTINCT FROM c.tournament_id::text
    OR NULLIF(v_result->>'table_id','') IS NULL THEN
    RAISE EXCEPTION 'retention estate: real creator refused %: %',c.name,v_result; END IF;
  UPDATE retention_cases SET table_id=(v_result->>'table_id')::uuid WHERE name=c.name;
 END LOOP;
END $create_boards$;
RESET ROLE;
-- Deliberate malformed classification control, through the real guarded update.
-- This is not a terminal/payment bypass; cancellation below is still canonical.
UPDATE public.tournaments SET variant=NULL
WHERE id IN(SELECT tournament_id FROM retention_cases WHERE name IN('unknown','cancelled_unknown'));
-- Gate 7 requires every open cash table to belong to cash_games. This is a
-- declared zero-money starting estate, not cash-creator/gameplay qualification.
-- Use the existing pure template and real parent/table triggers; do not close
-- the cash positive control or omit its stakes to bypass the parent requirement.
INSERT INTO public.cash_games(id,club_id,union_id,name,template_name,variant,
  sb,bb,handedness,ruleset_snapshot,created_by,must_move)
SELECT extensions.uuid_generate_v5(execution,'retention-cash-game'),club_id,club_id,
 'Retention cash control','classic','nlh',1,2,6,
 public.fn_cash_template_defaults('classic','nlh')||jsonb_build_object(
   'seats',6,'sb',1,'bb',2,'table_mode','manual'),owner_user,false
FROM retention_inputs;
INSERT INTO public.tables(id,club_id,union_id,name,game_type,game_variant,status,
  small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,created_by,
  cluster_id,role,main_index,lifecycle)
SELECT extensions.uuid_generate_v5(q.execution,'retention-cash-table'),q.club_id,q.club_id,
 'Retention cash control','cash','nlh','waiting',g.sb,g.bb,
 (g.ruleset_snapshot->>'min_buyin_bb')::numeric*g.bb,
 (g.ruleset_snapshot->>'max_buyin_bb')::numeric*g.bb,6,0,q.owner_user,
 g.id,'main',1,'live'
FROM retention_inputs q JOIN public.cash_games g
 ON g.id=extensions.uuid_generate_v5(q.execution,'retention-cash-game');
DO $cash_parent_evidence$
BEGIN
 IF (SELECT count(*) FROM public.cash_games)<>1 OR NOT EXISTS(
  SELECT 1 FROM retention_inputs q
  JOIN public.cash_games g ON g.id=extensions.uuid_generate_v5(q.execution,'retention-cash-game')
  JOIN public.tables t ON t.id=extensions.uuid_generate_v5(q.execution,'retention-cash-table')
  WHERE g.club_id=q.club_id AND g.union_id=q.club_id AND g.created_by=q.owner_user
   AND g.template_name='classic' AND g.variant='nlh' AND g.sb=1 AND g.bb=2 AND g.handedness=6
   AND g.enabled IS TRUE AND g.state='live' AND g.must_move IS FALSE
   AND g.ruleset_snapshot=public.fn_cash_template_defaults('classic','nlh')||jsonb_build_object(
     'seats',6,'sb',1,'bb',2,'table_mode','manual')
   AND t.cluster_id=g.id AND t.tournament_id IS NULL AND t.club_id=q.club_id AND t.union_id=q.club_id
   AND t.game_type='cash' AND t.game_variant='nlh' AND t.status='waiting' AND t.is_deleted IS FALSE
   AND t.role='main' AND t.main_index=1 AND t.lifecycle='live' AND t.current_players=0
   AND t.small_blind=g.sb AND t.big_blind=g.bb AND t.max_players=g.handedness
   AND t.min_buy_in=(g.ruleset_snapshot->>'min_buyin_bb')::numeric*g.bb
   AND t.max_buy_in=(g.ruleset_snapshot->>'max_buyin_bb')::numeric*g.bb
   AND t.seat_game_scope='cluster:'||g.id::text AND t.seat_admission_key='cash'
   AND t.terminal_closed_at IS NULL) THEN
  RAISE EXCEPTION 'retention estate: exact open cash parent/table projection differs'; END IF;
END $cash_parent_evidence$;
UPDATE retention_cases SET table_id=(SELECT extensions.uuid_generate_v5(execution,'retention-cash-table') FROM retention_inputs)
WHERE tournament_id IS NULL;
-- Canonical cancellation is called BEFORE any history exists; its real guard
-- forbids cancelling a played board. Later rows are delayed projections only.
SELECT 'retention_cancel_claims',set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
DO $cancel_boards$
DECLARE c record; r jsonb;
BEGIN
 IF current_user<>'service_role' OR auth.role()<>'service_role' OR auth.uid() IS NOT NULL THEN
   RAISE EXCEPTION 'retention estate: real service cancellation caller missing'; END IF;
 FOR c IN SELECT * FROM retention_cases WHERE name IN('cancelled','cancelled_unknown') ORDER BY name LOOP
  r:=public.atomic_cancel_tournament(c.tournament_id,NULL);
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'fully_settled' IS DISTINCT FROM 'true'
     OR r->>'tournament_id' IS DISTINCT FROM c.tournament_id::text
     OR r->>'status' IS DISTINCT FROM 'CANCELLED'
     OR (r->>'total_refunded')::numeric IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'retention estate: actual zero-entry cancellation failed %: %',c.name,r; END IF;
 END LOOP;
END $cancel_boards$;
RESET ROLE;
DO $cancel_evidence$
BEGIN
 IF (SELECT count(*) FROM public.tournament_cancellation_receipts)<>2
  OR EXISTS(SELECT 1 FROM retention_cases c LEFT JOIN public.tournament_cancellation_receipts r
    ON r.tournament_id=c.tournament_id LEFT JOIN public.tournaments t ON t.id=c.tournament_id
    WHERE c.name IN('cancelled','cancelled_unknown') AND (r.tournament_id IS NULL
      OR t.status IS DISTINCT FROM 'CANCELLED' OR r.source_player_count<>0 OR r.source_seat_count<>0
      OR r.total_refunded<>0 OR r.fees_reversed<>0 OR r.refund_line_count<>0
      OR r.closed_table_ids IS DISTINCT FROM ARRAY[c.table_id] OR r.escrow_closed_at IS NULL))
  OR EXISTS(SELECT 1 FROM public.chip_ledger) OR EXISTS(SELECT 1 FROM public.wallet_transactions)
  OR EXISTS(SELECT 1 FROM public.chip_transactions) OR EXISTS(SELECT 1 FROM public.ca_mint_ledger)
  OR EXISTS(SELECT 1 FROM public.club_members WHERE chip_balance IS DISTINCT FROM 0)
  OR EXISTS(SELECT 1 FROM public.clubs WHERE chip_treasury IS DISTINCT FROM 0 OR chip_pool IS DISTINCT FROM 0)
 THEN RAISE EXCEPTION 'retention estate: cancellation or zero-money evidence differs'; END IF;
END $cancel_evidence$;
DO $history_projections$
DECLARE c record; q record; n integer:=0; returned uuid; who uuid;
BEGIN
 SELECT * INTO STRICT q FROM retention_inputs;
 FOR c IN SELECT * FROM retention_cases ORDER BY name LOOP
  n:=n+1; who:=CASE WHEN c.name='human' THEN q.owner_user ELSE q.horse END;
  returned:=public.fn_ca_insert_hand_with_awards(jsonb_build_object(
    'id',c.hand_id,'table_id',c.table_id,'tournament_id',c.tournament_id,
    'hand_number',987000000+n,'created_at',transaction_timestamp()-interval '8 days',
    'started_at',transaction_timestamp()-interval '8 days','ended_at',transaction_timestamp()-interval '8 days',
    'game_variant','nlh','small_blind',1,'big_blind',2,'pot_size',0,'rake_amount',0,'bbj_amount',0,
    'players',jsonb_build_array(jsonb_build_object('userId',who,'seat',1,'startStack',0,'endStack',0)),
    'winners','[]'::jsonb,'actions','[]'::jsonb,'reported',c.name='reported','has_human',c.name='human',
    'source','retention_qualification_projection','summary','Synthetic zero-money retention projection; no accepted settlement receipt'),
    '[]'::jsonb);
  IF returned IS DISTINCT FROM c.hand_id THEN RAISE EXCEPTION 'retention estate: real history writer changed identity'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits) OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys) THEN
  RAISE EXCEPTION 'retention estate: projection fabricated accepted-hand receipts'; END IF;
END $history_projections$;
-- Force every genuine deferred proof now, before calling either pruner image.
SET CONSTRAINTS ALL IMMEDIATE;
