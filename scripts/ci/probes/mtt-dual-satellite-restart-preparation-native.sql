-- Real legacy/scheduled creator, target guards and immediate-source restart.
-- Local synthetic parents are not proof of historical funding or terminal play.
-- Every exercised creation uses real origin triggers and booked terms.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
DO $private$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR current_database() !~ '^r46_mtt_' THEN
  RAISE EXCEPTION 'owned satellite/restart fixture required';END IF;
END $private$;
CREATE FUNCTION pg_temp.satellite_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'DUAL SATELLITE FAIL: %',label;END IF;
 RAISE NOTICE 'DUAL SATELLITE PASS: %',label;
END $$;
CREATE TEMP TABLE satellite_inputs(key text PRIMARY KEY,value jsonb);
INSERT INTO satellite_inputs
SELECT 'scheduled',jsonb_build_object('club_id','46464700-0000-4000-8000-000000000001','union_id',NULL,
 'name','Native scheduled satellite','game_type','NLH','variant','satellite','tournament_type','SATELLITE',
 'buy_in_amount',90,'buy_in_fee',10,'guaranteed_prize',0,'starting_chips',10000,
 'max_players',NULL,'min_players',3,'table_size',9,'current_players',0,'status','REGISTERING',
 'blind_structure',jsonb_agg(jsonb_build_object('level',n,'smallBlind',25*n,'bigBlind',50*n,'ante',0,'durationMinutes',4) ORDER BY n),
 'blind_speed','turbo','is_turbo',true,'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
 'start_time',now()+interval '5 minutes','late_reg_levels',0,'late_reg_mins',0,'synchronized_breaks',true,
 'satellite_target_id','46464700-0000-4000-8000-000000000002','satellite_seats',1,'short_description','Native one seat')
FROM generate_series(1,24)n;
INSERT INTO satellite_inputs
SELECT 'legacy',(value-'blind_speed'-'is_turbo'-'synchronized_breaks')||jsonb_build_object(
 'name','Native legacy HU satellite','variant','sng','buy_in_amount',142.5,'buy_in_fee',7.5,
 'starting_chips',300,'max_players',2,'min_players',2,'table_size',2,
 'blind_structure','[{"level":1,"smallBlind":5,"bigBlind":10,"duration":180}]'::jsonb)
FROM satellite_inputs WHERE key='scheduled';
CREATE FUNCTION pg_temp.satellite_config(target uuid, label text DEFAULT 'Native feeder') RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object(
 'legacy_config',(SELECT value FROM satellite_inputs WHERE key='legacy')||jsonb_build_object('satellite_target_id',target,'name',label||' HU'),
 'scheduled_config',(SELECT value FROM satellite_inputs WHERE key='scheduled')||jsonb_build_object('satellite_target_id',target,'name',label||' MTT')) $$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46464700-0000-4000-8000-000000000010');
INSERT INTO public.profiles(id,username,display_name) VALUES
 ('46464700-0000-4000-8000-000000000010','native_dual_satellite_owner','Native Satellite Owner');
INSERT INTO public.users(id,username) VALUES('46464700-0000-4000-8000-000000000010','native_dual_satellite_owner');
INSERT INTO public.clubs(id,club_id,name,owner_id,asset,is_platform,chip_treasury)
 VALUES('46464700-0000-4000-8000-000000000001',994647,'Native satellite club','46464700-0000-4000-8000-000000000010','chips',false,1000);
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,
 starting_chips,min_players,max_players,table_size,current_players,status,start_time,
 is_bounty,is_pko,is_mystery_bounty,is_premium_spin,guaranteed_prize,prize_pool,prize_pool_finalized,
 blind_structure,payout_structure,payout_math_version,payout_unit_cents,format_contract)
SELECT ('46464700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'46464700-0000-4000-8000-000000000001',
 'Native target '||n,'MTT','freezeout','NLH',180,20,10000,3,200,9,0,'REGISTERING',now()+interval '4 hours',
 false,false,false,false,0,0,false,(value->'blind_structure')::text,(value->'payout_structure')::text,1,1,'mtt-v1'
FROM generate_series(2,5)n CROSS JOIN satellite_inputs WHERE key='scheduled';
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
CREATE FUNCTION pg_temp.satellite_money() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.wallets x),
 'club_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.club_wallets x),
 'union_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.union_wallets x),
 'ledger',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.chip_ledger x),
 'transactions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.chip_transactions x),
 'wallet_transactions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.wallet_transactions x),
 'rake',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.rake_records x),
 'tickets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_tickets x),
 'payouts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_payouts x),
 'awards',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_satellite_awards x)); $$;
INSERT INTO satellite_inputs VALUES('money',pg_temp.satellite_money());
DO $acl$ DECLARE refused boolean:=false;BEGIN
 PERFORM pg_temp.satellite_assert(NOT has_function_privilege('anon','public.fn_ensure_scheduled_mtt_satellite(jsonb)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_ensure_scheduled_mtt_satellite(jsonb)','EXECUTE')
  AND has_function_privilege('service_role','public.fn_ensure_scheduled_mtt_satellite(jsonb)','EXECUTE'),'exact service-only creator ACL');
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite('{}');EXCEPTION WHEN insufficient_privilege THEN refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'body also refuses nonservice claims');
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
END $acl$;
DO $legacy$ DECLARE r jsonb;again jsonb;BEGIN
 r:=public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000002'));
 PERFORM pg_temp.satellite_assert(r->>'outcome'='created' AND r->>'format_contract'='seat-first-satellite-v1'
  AND r#>>'{tournament,format_contract}'='seat-first-satellite-v1'
  AND r#>>'{tournament,max_players}'='2' AND r#>>'{tournament,starting_chips}'='300'
  AND (r#>>'{tournament,buy_in_fee}')::numeric=7.5 AND (r#>>'{tournament,buy_in_amount}')::numeric=142.5,
  'legacy ABI creates actual fixed HU with unchanged300stack and5percent terms');
 PERFORM pg_temp.satellite_assert(EXISTS(SELECT 1 FROM public.tables WHERE id=(r->>'table_id')::uuid
  AND tournament_id=(r->>'tournament_id')::uuid AND max_players=2 AND status='waiting'),
  'legacy receipt identifies the actual open physical table');
 again:=public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000002','Renamed request'));
 PERFORM pg_temp.satellite_assert(again->>'outcome'='existing_active' AND again-'outcome'=r-'outcome',
  'owner-target replay returns the exact accepted row and table without renaming');
 INSERT INTO satellite_inputs VALUES('legacy_receipt',r);
 PERFORM pg_temp.satellite_assert(pg_temp.satellite_money()=(SELECT value FROM satellite_inputs WHERE key='money'),
  'legacy creation/replay fabricates no money or ticket movement');
END $legacy$;
-- Synthetic future ABI is a rollback-only input; the real activation guard stays enabled.
DO $blocked$ DECLARE refused boolean:=false;BEGIN
 BEGIN UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'MTT_ADMISSION_ACTIVATION_NOT_PREPARED' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'actual activation remains refused');
END $blocked$;
SET LOCAL session_replication_role=replica;
UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2';
SET LOCAL session_replication_role=origin;
DO $future$ DECLARE r jsonb;again jsonb;cfg jsonb;patch jsonb;refused boolean;BEGIN
 r:=public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000002'));
 PERFORM pg_temp.satellite_assert(r->>'outcome'='existing_active' AND r-'outcome'=(SELECT value-'outcome' FROM satellite_inputs WHERE key='legacy_receipt'),
  'future ABI replays accepted legacy HU unchanged rather than replacing it');
 r:=public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000003'));
 RAISE NOTICE 'DUAL SATELLITE OBSERVED: %',jsonb_build_object('outcome',r->'outcome','format',r->'format_contract','max',r#>'{tournament,max_players}','min',r#>'{tournament,min_players}','stack',r#>'{tournament,starting_chips}','fee',r#>'{tournament,buy_in_fee}','entry',r#>'{tournament,buy_in_amount}','table',r->'table_id');
 PERFORM pg_temp.satellite_assert(r->>'outcome'='created' AND r->>'format_contract'='mtt-v2'
  AND r#>'{tournament,max_players}'='null'::jsonb AND r#>>'{tournament,min_players}'='3'
  AND r#>>'{tournament,starting_chips}'='10000' AND (r#>>'{tournament,buy_in_fee}')::numeric=10
  AND (r#>>'{tournament,buy_in_amount}')::numeric=90 AND r->'table_id'='null'::jsonb,
  'future ABI chooses genuine scheduled10000stack10percentNULLcapacity configuration');
 PERFORM pg_temp.satellite_assert(NOT EXISTS(SELECT 1 FROM public.tables WHERE tournament_id=(r->>'tournament_id')::uuid),
  'scheduled creation invents no seat-first physical table');
 again:=public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000003','Different display'));
 PERFORM pg_temp.satellite_assert(again->>'outcome'='existing_active' AND again-'outcome'=r-'outcome','scheduled replay returns exact same durable identity');
 INSERT INTO satellite_inputs VALUES('future_receipt',r);
 cfg:=pg_temp.satellite_config('46464700-0000-4000-8000-000000000004');
 FOR patch IN SELECT value FROM jsonb_array_elements('[
  {"format_contract":"seat-first-satellite-v1"},{"max_players":2},{"min_players":2},
  {"buy_in_fee":5},{"buy_in_amount":45,"buy_in_fee":5},{"satellite_seats":2},
  {"club_id":"46464700-0000-4000-8000-000000000005"},{"synchronized_breaks":false},
  {"blind_structure":[]},{"payout_structure":[{"place":1,"percentage":90}]}
 ]'::jsonb) LOOP
  refused:=false;BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(jsonb_set(cfg,'{scheduled_config}',cfg->'scheduled_config'||patch));
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true;END;
  PERFORM pg_temp.satellite_assert(refused,'invalid scheduled branch refuses: '||patch::text);
 END LOOP;
 refused:=false;BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg||'{"id":"forged"}'::jsonb);
 EXCEPTION WHEN invalid_parameter_value THEN refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'unknown outer request identity refused');
 PERFORM pg_temp.satellite_assert(NOT EXISTS(SELECT 1 FROM public.tournaments WHERE satellite_target_id='46464700-0000-4000-8000-000000000004'),
  'all invalid requests create no feeder');
 PERFORM pg_temp.satellite_assert(pg_temp.satellite_money()=(SELECT value FROM satellite_inputs WHERE key='money'),
  'scheduled creation/replay and refusals preserve money and tickets exactly');
END $future$;
SAVEPOINT target_cases;
UPDATE public.tournaments SET start_time=now()+interval '2 hours' WHERE id='46464700-0000-4000-8000-000000000004';
DO $horizon$ DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000004'));
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'SATELLITE_CREATE_TARGET_UNAVAILABLE' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'future feeder requires at least three hours of target lead');
END $horizon$;
ROLLBACK TO SAVEPOINT target_cases;
UPDATE public.tournaments SET variant='progressive_bounty' WHERE id='46464700-0000-4000-8000-000000000004';
DO $target$ DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000004'));
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'SATELLITE_CREATE_TARGET_UNAVAILABLE' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'unsupported target spelling is refused even with false bounty flags');
 refused:=false;BEGIN UPDATE public.tournaments SET variant='progressive_bounty' WHERE id='46464700-0000-4000-8000-000000000003';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'actual target edit guard protects a committed scheduled feeder');
END $target$;
ROLLBACK TO SAVEPOINT target_cases;
-- Input-only legacy aliases/corruption are exercised inside their own savepoint.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET satellite_target=satellite_target_id,satellite_target_id=NULL
 WHERE id=(SELECT (value->>'tournament_id')::uuid FROM satellite_inputs WHERE key='legacy_receipt');
SET LOCAL session_replication_role=origin;
DO $aliases$ DECLARE r jsonb;BEGIN
 r:=public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000002'));
 PERFORM pg_temp.satellite_assert(r->>'outcome'='existing_active' AND r->>'tournament_id'=(SELECT value->>'tournament_id' FROM satellite_inputs WHERE key='legacy_receipt')
  AND r->>'table_id'=(SELECT value->>'table_id' FROM satellite_inputs WHERE key='legacy_receipt'),
  'historical alternate target pointer replays its real accepted table');
END $aliases$;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET satellite_target_id='46464700-0000-4000-8000-000000000004'
 WHERE id=(SELECT (value->>'tournament_id')::uuid FROM satellite_inputs WHERE key='legacy_receipt');
SET LOCAL session_replication_role=origin;
DO $contradiction$ DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(pg_temp.satellite_config('46464700-0000-4000-8000-000000000002'));
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'SATELLITE_TARGET_POINTER_CONTRADICTION' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'contradictory target pointers fail closed');
END $contradiction$;
ROLLBACK TO SAVEPOINT target_cases;
-- Exact existing engine copy surface, with lifecycle fields freshly authored.
CREATE FUNCTION pg_temp.restart(source_id uuid, overrides jsonb DEFAULT '{}'::jsonb) RETURNS uuid
LANGUAGE plpgsql AS $restart$ DECLARE cfg jsonb; v public.tournaments%ROWTYPE; new_id uuid;BEGIN
 SELECT jsonb_object_agg(key,value) INTO cfg FROM public.tournaments t,
 LATERAL jsonb_each(to_jsonb(t)) WHERE t.id=source_id AND key=ANY(ARRAY['club_id','union_id','is_xmtt','name','game_type','variant','tournament_type','buy_in_amount','buy_in_fee','starting_chips','max_players','min_players','blind_structure','payout_structure','payout_percent','guaranteed_prize','late_reg_levels','late_reg_mins','rebuy_levels','is_rebuy','is_reentry','rebuy_cost','rebuy_chips','add_on_available','addon_cost','addon_chips','addon_levels','is_bounty','bounty_amount','is_pko','is_mystery_bounty','mystery_bounty_min','mystery_bounty_max','mystery_bounty_profile','mystery_bounty_activation','mystery_bounty_activation_value','mystery_bounty_pool_percent','mystery_bounty_regular_pool_percent','mystery_bounty_top_percent','spin_type','satellite_target_id','satellite_target','satellite_seats','is_private','short_description','is_vip_only','ban_chat','all_in_or_fold','label_as_new','hide_club_name','action_time_seconds','table_size','accelerated_mtt','addon_break_minutes','big_blind_ante','authorized_to_register','early_bird_enabled','early_bird_chips','bubble_protection','final_table_deal_enabled','restart_every_minutes','synchronized_breaks','max_rebuys','max_reentries','is_multi_day','total_days','is_pinned']);
 cfg:=cfg||jsonb_build_object('restart_source_id',source_id,'current_players',0,'status','REGISTERING',
  'start_time',now()+interval '10 minutes','schedule_id',NULL)||overrides;
 SELECT * INTO v FROM jsonb_populate_record(NULL::public.tournaments,cfg);
 INSERT INTO public.tournaments(club_id,union_id,is_xmtt,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,starting_chips,max_players,min_players,blind_structure,payout_structure,payout_percent,guaranteed_prize,late_reg_levels,late_reg_mins,rebuy_levels,is_rebuy,is_reentry,rebuy_cost,rebuy_chips,add_on_available,addon_cost,addon_chips,addon_levels,is_bounty,bounty_amount,is_pko,is_mystery_bounty,mystery_bounty_min,mystery_bounty_max,mystery_bounty_profile,mystery_bounty_activation,mystery_bounty_activation_value,mystery_bounty_pool_percent,mystery_bounty_regular_pool_percent,mystery_bounty_top_percent,spin_type,satellite_target_id,satellite_target,satellite_seats,is_private,short_description,is_vip_only,ban_chat,all_in_or_fold,label_as_new,hide_club_name,action_time_seconds,table_size,accelerated_mtt,addon_break_minutes,big_blind_ante,authorized_to_register,early_bird_enabled,early_bird_chips,bubble_protection,final_table_deal_enabled,restart_every_minutes,synchronized_breaks,max_rebuys,max_reentries,is_multi_day,total_days,is_pinned,restart_source_id,current_players,status,start_time,schedule_id,format_contract) SELECT v.club_id,v.union_id,v.is_xmtt,v.name,v.game_type,v.variant,v.tournament_type,v.buy_in_amount,v.buy_in_fee,v.starting_chips,v.max_players,v.min_players,v.blind_structure,v.payout_structure,v.payout_percent,v.guaranteed_prize,v.late_reg_levels,v.late_reg_mins,v.rebuy_levels,v.is_rebuy,v.is_reentry,v.rebuy_cost,v.rebuy_chips,v.add_on_available,v.addon_cost,v.addon_chips,v.addon_levels,v.is_bounty,v.bounty_amount,v.is_pko,v.is_mystery_bounty,v.mystery_bounty_min,v.mystery_bounty_max,v.mystery_bounty_profile,v.mystery_bounty_activation,v.mystery_bounty_activation_value,v.mystery_bounty_pool_percent,v.mystery_bounty_regular_pool_percent,v.mystery_bounty_top_percent,v.spin_type,v.satellite_target_id,v.satellite_target,v.satellite_seats,v.is_private,v.short_description,v.is_vip_only,v.ban_chat,v.all_in_or_fold,v.label_as_new,v.hide_club_name,v.action_time_seconds,v.table_size,v.accelerated_mtt,v.addon_break_minutes,v.big_blind_ante,v.authorized_to_register,v.early_bird_enabled,v.early_bird_chips,v.bubble_protection,v.final_table_deal_enabled,v.restart_every_minutes,v.synchronized_breaks,v.max_rebuys,v.max_reentries,v.is_multi_day,v.total_days,v.is_pinned,v.restart_source_id,v.current_players,v.status,v.start_time,v.schedule_id,v.format_contract RETURNING id INTO new_id;
 RETURN new_id;
END $restart$;
SAVEPOINT restart_cases;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='COMPLETED',ended_at=now()-interval '1 minute',restart_every_minutes=5
 WHERE id='46464700-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=origin;
DO $restart$ DECLARE child uuid;refused boolean;constraint_name text;patch jsonb;BEGIN
 FOR patch IN SELECT value FROM jsonb_array_elements('[{"name":"changed funded name"},{"buy_in_amount":170},{"starting_chips":20000},{"satellite_target_id":"46464700-0000-4000-8000-000000000005"},{"format_contract":"mtt-v1"}]'::jsonb) LOOP
  refused:=false;BEGIN PERFORM pg_temp.restart('46464700-0000-4000-8000-000000000004',patch);
  EXCEPTION WHEN invalid_parameter_value OR object_not_in_prerequisite_state THEN refused:=true;END;
  PERFORM pg_temp.satellite_assert(refused,'restart cannot alter source contract: '||patch::text);
 END LOOP;
 child:=pg_temp.restart('46464700-0000-4000-8000-000000000004');
 PERFORM pg_temp.satellite_assert(EXISTS(SELECT 1 FROM public.tournaments WHERE id=child
  AND restart_source_id='46464700-0000-4000-8000-000000000004' AND format_contract='mtt-v2'
  AND max_players IS NULL AND min_players=3 AND buy_in_amount=180 AND buy_in_fee=20),
  'new MTT restart keeps immediate source and price while admitting actualv2');
 refused:=false;BEGIN PERFORM pg_temp.restart('46464700-0000-4000-8000-000000000004',jsonb_build_object('start_time',now()+interval '11 minutes'));
 EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
  IF constraint_name<>'tournaments_one_restart_per_source' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'second worker timestamp cannot create a second child');
 refused:=false;BEGIN UPDATE public.tournaments SET restart_source_id=NULL WHERE id=child;
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'TOURNAMENT_RESTART_SOURCE_IMMUTABLE' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'child cannot erase immediate source');
 refused:=false;BEGIN UPDATE public.tournaments SET restart_source_id=child WHERE id='46464700-0000-4000-8000-000000000005';
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'TOURNAMENT_RESTART_SOURCE_IMMUTABLE' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'existing untagged row cannot acquire restart source');
 refused:=false;BEGIN DELETE FROM public.tournaments WHERE id=child;
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'TOURNAMENT_RESTART_HISTORY_IMMUTABLE' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'child deletion cannot release durable source identity');
END $restart$;
ROLLBACK TO SAVEPOINT restart_cases;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='COMPLETED',ended_at=now()-interval '1 minute',restart_every_minutes=5,
 tournament_type='SNG',variant='sng',format_contract='sng-v1',min_players=6,max_players=6,table_size=6,synchronized_breaks=false
 WHERE id='46464700-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=origin;
DO $fixed$ DECLARE child uuid;BEGIN
 child:=pg_temp.restart('46464700-0000-4000-8000-000000000004');
 PERFORM pg_temp.satellite_assert(EXISTS(SELECT 1 FROM public.tournaments WHERE id=child AND format_contract='sng-v1'
  AND max_players=6 AND min_players=6 AND table_size=6 AND buy_in_amount=180 AND buy_in_fee=20),
  'existing non-HU fixed SNG restart remains fixed and preserves business terms');
END $fixed$;
ROLLBACK TO SAVEPOINT restart_cases;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='COMPLETED',ended_at=now()-interval '1 minute',restart_every_minutes=5,
 tournament_type='SNG',variant='sng',format_contract='sng-v1',min_players=2,max_players=2,table_size=2,synchronized_breaks=false,buy_in_amount=190,buy_in_fee=10
 WHERE id='46464700-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=origin;
DO $hu$ DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM pg_temp.restart('46464700-0000-4000-8000-000000000004');
 EXCEPTION WHEN invalid_parameter_value THEN IF SQLERRM<>'TOURNAMENT_RESTART_FORMAT_MISMATCH' THEN RAISE;END IF;refused:=true;END;
 PERFORM pg_temp.satellite_assert(refused,'fixed two-seat events are never restarted on the clock');
END $hu$;
ROLLBACK TO SAVEPOINT restart_cases;
DO $final$ BEGIN
 PERFORM pg_temp.satellite_assert(pg_temp.satellite_money()=(SELECT value FROM satellite_inputs WHERE key='money'),
  'all creator/restart cases preserve wallets ledgers tickets and awards exactly');
 PERFORM pg_temp.satellite_assert(NOT EXISTS(SELECT 1 FROM public.tournament_players),
  'creation invents no entry or funded player');
 PERFORM pg_temp.satellite_assert(EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournaments'::regclass
  AND conname='tournaments_restart_source_id_fkey' AND contype='f' AND confdeltype='r' AND confupdtype='r'),
  'immediate source uses actual restrictive foreign key');
END $final$;
ROLLBACK;
SELECT 'MTT_DUAL_SATELLITE_RESTART_PREPARATION_NATIVE_PASS';
