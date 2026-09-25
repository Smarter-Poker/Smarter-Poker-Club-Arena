-- Real creation authorities, origin triggers, ACLs and immutable parent history.
-- Synthetic owner/club inputs are local; no financial authority is replaced.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN RAISE EXCEPTION 'owned PG17 fixture required';END IF;
END $local$;
CREATE FUNCTION pg_temp.creation_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'DUAL CREATION FAIL: %',label;END IF;
 RAISE NOTICE 'DUAL CREATION PASS: %',label;
END $$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46464599-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id,username,display_name,role) VALUES
 ('46464599-0000-4000-8000-000000000001','native_creation_owner','Native Creation Owner','admin');
INSERT INTO public.clubs(id,name,owner_id,chip_treasury,asset,is_platform) VALUES
 ('46464598-0000-4000-8000-000000000001','Native Creation Club','46464599-0000-4000-8000-000000000001',1000,'chips',false);
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','46464599-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"46464599-0000-4000-8000-000000000001"}',true);
CREATE TEMP TABLE creation_inputs(key text PRIMARY KEY,value jsonb);
INSERT INTO creation_inputs VALUES('governed',jsonb_build_object(
 'name','Native MTT','type','mtt','gameVariant','NLH','buyIn',20,'maxPlayers',100,
 'minPlayers',3,'startingStack',10000,'startTime',(now()+interval '1 day')::text,
 'blindStructure','[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
 'payoutStructure','[{"place":1,"percentage":100}]'::jsonb));
DO $legacy$
DECLARE r jsonb;t public.tournaments%ROWTYPE; c jsonb; refused boolean;
BEGIN
 SELECT value INTO c FROM creation_inputs WHERE key='governed';
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert((r->>'success')::boolean AND t.format_contract='mtt-v1'
  AND t.max_players=100 AND t.min_players=3 AND t.buy_in_amount=18 AND t.buy_in_fee=2,
  'actual governed creator preserves legacy100 cap and18+2 price: '||r::text);
 INSERT INTO creation_inputs VALUES('legacy_mtt',to_jsonb(t));
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c||'{"maxPlayers":null}'::jsonb);
 PERFORM pg_temp.creation_assert(r->>'error'='max_players_must_be_positive','legacy creator still refuses NULL cap');
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c||'{"name":"Native fixed HU","type":"sng","maxPlayers":2,"minPlayers":2,"tableSize":2}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert((r->>'success')::boolean AND t.format_contract='sng-v1'
  AND t.max_players=2 AND t.buy_in_amount=19 AND t.buy_in_fee=1,'actual fixed HU retains5 percent fee');
 INSERT INTO creation_inputs VALUES('fixed',to_jsonb(t));
 r:=public.fn_poker_diamond_create_tournament(c);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert(t.format_contract='mtt-v1' AND t.max_players=100
  AND t.buy_in_amount=18 AND t.buy_in_fee=2,'actual Diamond creator preserves legacy cap and unit fee: '||r::text);
 r:=public.fn_poker_diamond_create_tournament(c||'{"name":"Native legacy mystery","type":"mystery_bounty","bountyAmount":5}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert(t.format_contract='mtt-v1' AND t.is_mystery_bounty AND t.bounty_amount=5
  AND t.mystery_bounty_activation='at_the_money' AND t.mystery_bounty_profile='classic'
  AND t.mystery_bounty_pool_percent=50 AND t.mystery_bounty_regular_pool_percent=50,
  'actual legacy Diamond mystery configuration remains explicit and unchanged');
 c:=jsonb_build_object('club_id','46464598-0000-4000-8000-000000000001','union_id',NULL,
  'name','Native accepted satellite','game_type','NLH','variant','sng','tournament_type','SATELLITE',
  'buy_in_amount',9.5,'buy_in_fee',0.5,'guaranteed_prize',0,'starting_chips',300,
  'max_players',2,'min_players',2,'table_size',2,'current_players',0,'status','REGISTERING',
  'blind_structure','[{"level":1,"smallBlind":5,"bigBlind":10,"duration":180}]'::jsonb,
  'payout_structure','[{"place":1,"percentage":100}]'::jsonb,'start_time',now()+interval '5 minutes',
  'late_reg_levels',0,'late_reg_mins',0,'satellite_target_id',(SELECT value->>'id' FROM creation_inputs WHERE key='legacy_mtt'),
  'satellite_seats',1,'short_description','Native accepted HU satellite');
 r:=public.fn_create_seat_first_game_atomic('46464500-0000-4000-8000-000000000001',c);
 PERFORM pg_temp.creation_assert((r->>'ok')::boolean AND r#>>'{tournament,format_contract}'='seat-first-satellite-v1'
  AND r#>>'{tournament,max_players}'='2' AND (SELECT count(*) FROM public.tables WHERE tournament_id='46464500-0000-4000-8000-000000000001')=1,
  'actual legacy satellite creates its unchanged parent and physical HU table');
 INSERT INTO creation_inputs VALUES('legacy_hu_config',c),('legacy_hu_result',r);
 refused:=false;
 BEGIN UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'MTT_ADMISSION_ACTIVATION_NOT_PREPARED' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.creation_assert(refused,'real activation remains blocked');
END $legacy$;
-- Exercise the prepared future branch only inside this rollback-safe fixture.
SET LOCAL session_replication_role=replica;
UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';
SET LOCAL session_replication_role=origin;
DO $future$
DECLARE r jsonb;t public.tournaments%ROWTYPE;c jsonb; legacy_id uuid; fixed_id uuid;
 refused boolean; before_history jsonb; after_history jsonb; mismatch jsonb;
BEGIN
 SELECT value INTO c FROM creation_inputs WHERE key='governed';
 SELECT (value->>'id')::uuid INTO legacy_id FROM creation_inputs WHERE key='legacy_mtt';
 SELECT (value->>'id')::uuid INTO fixed_id FROM creation_inputs WHERE key='fixed';
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c||'{"name":"Native uncapped MTT","maxPlayers":"obsolete cap ignored","minPlayers":2}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert((r->>'success')::boolean AND t.format_contract='mtt-v2'
  AND t.max_players IS NULL AND t.min_players=3 AND t.buy_in_amount=18 AND t.buy_in_fee=2,
  'actual future governed creator ignores obsolete cap before cast and uses3minimum: '||r::text);
 PERFORM pg_temp.creation_assert(public.fn_tournament_management_readiness_for_row(to_jsonb(t))->>'state'='ready',
  'actual readiness accepts recorded NULL MTT with unchanged funding rules');
 INSERT INTO creation_inputs VALUES('future_mtt',to_jsonb(t));
 r:=public.fn_poker_diamond_create_tournament(c||'{"name":"Native uncapped Diamond MTT","maxPlayers":2,"minPlayers":2,"tableSize":9}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert(t.format_contract='mtt-v2' AND t.max_players IS NULL AND t.min_players=3
  AND t.table_size=9 AND t.buy_in_amount=18 AND t.buy_in_fee=2,'actual future Diamond ignores old2 cap without repricing to HU: '||r::text);
 r:=public.fn_poker_diamond_create_tournament(c||'{"name":"Native future mystery","type":"mystery_bounty","bountyAmount":5,"maxPlayers":null}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert(t.format_contract='mtt-v2' AND t.max_players IS NULL AND t.is_mystery_bounty
  AND t.bounty_amount=5 AND t.mystery_bounty_top_percent=20 AND t.mystery_bounty_pool_percent=50,
  'actual future Diamond mystery preserves bounty terms with unlimited capacity');
 r:=public.fn_create_seat_first_game_atomic('46464500-0000-4000-8000-000000000001',
  (SELECT value FROM creation_inputs WHERE key='legacy_hu_config'));
 PERFORM pg_temp.creation_assert((r->>'ok')::boolean AND (r->>'replayed')::boolean
  AND r->'tournament'=(SELECT value->'tournament' FROM creation_inputs WHERE key='legacy_hu_result')
  AND r->>'table_id'=(SELECT value->>'table_id' FROM creation_inputs WHERE key='legacy_hu_result'),
  'future ABI preserves exact accepted legacy HU parent/table replay');
 refused:=false;BEGIN PERFORM public.fn_create_seat_first_game_atomic('46464500-0000-4000-8000-000000000002',
  (SELECT value FROM creation_inputs WHERE key='legacy_hu_config'));
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.creation_assert(refused AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='46464500-0000-4000-8000-000000000002'),
  'old creator cannot silently turn newly requested HU terms into a scheduled MTT');
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c||'{"name":"Native still fixed HU","type":"sng","maxPlayers":2,"minPlayers":2,"tableSize":2}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=COALESCE(r->>'tournament_id',r->>'tournamentId')::uuid;
 PERFORM pg_temp.creation_assert((r->>'success')::boolean AND t.format_contract='sng-v1'
  AND t.max_players=2 AND t.buy_in_amount=19 AND t.buy_in_fee=1,'future ABI preserves actual SNG2/5 percent economics');
 SELECT jsonb_agg(to_jsonb(v) ORDER BY version) INTO before_history FROM public.managed_game_contract_versions v WHERE game_id=legacy_id;
 r:=public.fn_update_managed_game('tournament',legacy_id,jsonb_build_object('name','Native MTT','max_players','obsolete cap ignored'));
 SELECT jsonb_agg(to_jsonb(v) ORDER BY version) INTO after_history FROM public.managed_game_contract_versions v WHERE game_id=legacy_id;
 PERFORM pg_temp.creation_assert((r->>'ok')::boolean AND (SELECT max_players=100 AND format_contract='mtt-v1' FROM public.tournaments WHERE id=legacy_id)
  AND before_history=after_history,'obsolete capacity edit preserves exact version1 storage and history');
 refused:=false;BEGIN UPDATE public.tournaments SET max_players=NULL WHERE id=fixed_id;
 EXCEPTION WHEN check_violation OR object_not_in_prerequisite_state THEN refused:=true;END;
 PERFORM pg_temp.creation_assert(refused AND (SELECT max_players=2 FROM public.tournaments WHERE id=fixed_id),'fixed cap cannot be removed');
 refused:=false;BEGIN UPDATE public.tournaments SET format_contract='mtt-v2' WHERE id=legacy_id;
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'TOURNAMENT_FORMAT_IMMUTABLE' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.creation_assert(refused,'accepted parent marker cannot be relabeled');
 refused:=false;BEGIN UPDATE public.tournaments SET blind_structure='[{"smallBlind":50,"bigBlind":20,"duration":300}]'
 WHERE id=(SELECT (value->>'id')::uuid FROM creation_inputs WHERE key='future_mtt');
 EXCEPTION WHEN invalid_parameter_value THEN refused:=true;END;
 PERFORM pg_temp.creation_assert(refused,'actual future MTT blind guard rejects decreasing invalid blind pair');
 refused:=false;BEGIN INSERT INTO public.tournament_waitlists(tournament_id,user_id,position)
 VALUES(legacy_id,'46464599-0000-4000-8000-000000000001',1);
 EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM<>'MTTs and satellites register directly; no entry-cap waitlist' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.creation_assert(refused,'actual legacy-MTT waitlist admission refuses after activation');
 INSERT INTO public.tournaments(club_id,name,tournament_type,variant,max_players,min_players,table_size,
  buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,blind_structure,payout_structure,synchronized_breaks)
 VALUES('46464598-0000-4000-8000-000000000001','Explicit new MTT with obsolete SNG alias','MTT','sng',2,3,9,
  0,0,10000,0,'REGISTERING',now()+interval '1 day',c->'blindStructure',c->'payoutStructure',true)
 RETURNING * INTO t;
 PERFORM pg_temp.creation_assert(t.format_contract='mtt-v2' AND t.max_players IS NULL AND t.synchronized_breaks,
  'explicit new MTT does not inherit short-format break suppression from obsolete alias');
 INSERT INTO public.tournaments(club_id,name,tournament_type,variant,max_players,min_players,table_size,
  buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,blind_structure,payout_structure,
  payout_math_version,payout_unit_cents)
 VALUES('46460000-0000-4000-8000-000000000002','Explicit new version2 Diamond MTT','MTT','freezeout',NULL,3,9,
  18,2,10000,0,'REGISTERING',now()+interval '1 day',c->'blindStructure',c->'payoutStructure',2,1)
 RETURNING * INTO t;
 PERFORM pg_temp.creation_assert(t.format_contract='mtt-v2' AND t.max_players IS NULL
  AND t.payout_math_version=2 AND t.payout_unit_cents=100,
  'NULL MTT prize constraint retains actual Diamond denomination authority');
 PERFORM pg_temp.creation_assert((SELECT count(*) FROM pg_trigger tr JOIN pg_proc f ON f.oid=tr.tgfoid
  JOIN public.ca_declared_money_triggers d ON d.table_name=tr.tgrelid::regclass::text AND d.trigger_name=tr.tgname
  WHERE tr.tgenabled='O' AND ((tr.tgname='a0_tournaments_dual_entry_capacity' AND f.proname='fn_ca_normalize_new_mtt_capacity')
   OR (tr.tgname='tournament_waitlists_fixed_format_only' AND f.proname='fn_ca_fixed_tournament_waitlist_only')))=2,
  'both new enabled triggers are declared with exact actual functions');
 PERFORM pg_temp.creation_assert(NOT has_function_privilege('anon','public.fn_ca_new_tournament_is_unlimited(jsonb)','EXECUTE')
  AND has_function_privilege('authenticated','public.fn_ca_new_tournament_is_unlimited(jsonb)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.fn_ca_is_new_mtt(jsonb)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_ca_normalize_new_mtt_capacity()','EXECUTE'),
  'new private helpers and invoker-safe authority retain bounded execution grants');
 refused:=false;BEGIN
  INSERT INTO public.tournaments(club_id,name,tournament_type,variant,max_players,min_players,table_size,
   buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,blind_structure,payout_structure,
   satellite_target_id,satellite_seats)
  VALUES('46464598-0000-4000-8000-000000000001','Rejected old raw HU satellite','SATELLITE','sng',2,2,2,
   9.5,0.5,300,0,'REGISTERING',now()+interval '5 minutes',
   '[{"smallBlind":5,"bigBlind":10,"duration":180}]','[{"place":1,"percentage":100}]',legacy_id,1);
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.creation_assert(refused,'raw old HU config cannot become a new MTT merely by clearing its cap');
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',
  c||jsonb_build_object('name','Rejected governed fixed satellite','type','sng','satelliteTargetId',legacy_id,'maxPlayers',2));
 PERFORM pg_temp.creation_assert(r->>'error'='satellite_requires_scheduled_mtt_config',
  'governed fixed target config must supply a true scheduled configuration');
 FOR mismatch IN SELECT value FROM jsonb_array_elements('[
  {"type":"mtt","tournament_type":"SNG","maxPlayers":2},
  {"type":"mtt","tournamentType":"SPIN","maxPlayers":2},
  {"type":"sng","tournament_type":"MTT","satellite_target_id":"46464500-0000-4000-8000-000000000001","maxPlayers":2,"minPlayers":2,"tableSize":2},
  {"type":"sng","tournamentType":"MTT","satelliteTarget":{"tournamentId":"46464500-0000-4000-8000-000000000001"},"maxPlayers":2,"minPlayers":2,"tableSize":2}
 ]'::jsonb) LOOP
  r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c||mismatch||jsonb_build_object('name','Canonical chip '||mismatch::text));
  SELECT * INTO t FROM public.tournaments WHERE id=(r->>'tournament_id')::uuid;
  PERFORM pg_temp.creation_assert((r->>'success')::boolean
   AND t.format_contract=CASE WHEN mismatch->>'type'='sng' THEN 'sng-v1' ELSE 'mtt-v2' END
   AND t.buy_in_fee=CASE WHEN mismatch->>'type'='sng' THEN 1 ELSE 2 END
   AND t.satellite_target_id IS NULL,
   'governed classification uses only actually persistedtype/target: '||mismatch::text);
  r:=public.fn_poker_diamond_create_tournament(c||mismatch||jsonb_build_object('name','Canonical Diamond '||mismatch::text));
  SELECT * INTO t FROM public.tournaments WHERE id=(r->>'tournamentId')::uuid;
  PERFORM pg_temp.creation_assert((r->>'success')::boolean
   AND t.format_contract=CASE WHEN mismatch->>'type'='sng' THEN 'sng-v1' ELSE 'mtt-v2' END
   AND t.buy_in_fee=CASE WHEN mismatch->>'type'='sng' THEN 1 ELSE 2 END
   AND t.satellite_target_id IS NULL,
   'Diamond classification uses only actually persistedtype/target: '||mismatch::text);
 END LOOP;
 r:=public.fn_create_tournament_governed_legacy('46464598-0000-4000-8000-000000000001',c||'{"name":"Original governed uppercase semantics","type":"SNG","maxPlayers":2}'::jsonb);
 SELECT * INTO t FROM public.tournaments WHERE id=(r->>'tournament_id')::uuid;
 PERFORM pg_temp.creation_assert((r->>'success')::boolean AND t.tournament_type='MTT'
  AND t.variant='freezeout' AND t.format_contract='mtt-v2' AND t.buy_in_fee=2,
  'governed exactcase writer andfee classifier agree for uppercase legacyinput');
 PERFORM pg_temp.creation_assert(NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id IN(SELECT id FROM public.tournaments WHERE club_id IN('46464598-0000-4000-8000-000000000001','46460000-0000-4000-8000-000000000002')))
  AND NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE club_id IN('46464598-0000-4000-8000-000000000001','46460000-0000-4000-8000-000000000002')),
  'configuration creation posts no entries or chip payments');
END $future$;
ROLLBACK;
SELECT 'MTT_DUAL_CREATION_PREPARATION_NATIVE_PASS' AS result;
