-- R46 source-only multi-session fixture. NOT EXECUTED.
-- Load only through the protected catalog into a newly provisioned complete
-- schema with the candidate migration already installed. One database per
-- .spec file; the owning fixture provider must destroy it and prove disposal.
-- No production functions are copied/replaced and no test cleanup disables
-- the restart-history guard. Local/name checks below do not confer admission.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
DO $preflight$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
     OR current_database() !~ '^r46_mtt_isolation_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'R46 requires its separately admitted disposable local fixture';
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournaments)
     OR EXISTS(SELECT 1 FROM public.tournament_players)
     OR EXISTS(SELECT 1 FROM public.tables)
     OR EXISTS(SELECT 1 FROM public.engine_maintenance_break) THEN
    RAISE EXCEPTION 'R46 isolation fixture must have no existing game state';
  END IF;
  IF to_regprocedure('public.fn_ensure_scheduled_mtt_satellite(jsonb)') IS NULL
     OR to_regprocedure('public.fn_ca_guard_new_satellite_target()') IS NULL
     OR to_regprocedure('public.fn_ca_guard_tournament_restart_source()') IS NULL
     OR to_regclass('public.tournaments_one_restart_per_source') IS NULL THEN
    RAISE EXCEPTION 'R46 current authority graph is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
      AND tgname IN ('a0_tournaments_dual_entry_capacity',
        'a1_tournaments_restart_source','a2_tournaments_new_satellite_target')
      AND tgenabled='O')<>3 THEN
    RAISE EXCEPTION 'R46 real table guards must be installed and enabled';
  END IF;
END $preflight$;

CREATE SCHEMA r46_mtt_isolation;
REVOKE ALL ON SCHEMA r46_mtt_isolation FROM PUBLIC;
CREATE TABLE r46_mtt_isolation.observations(actor text PRIMARY KEY, outcome text NOT NULL, event_id uuid);
CREATE TABLE r46_mtt_isolation.connections(
  actor text PRIMARY KEY CHECK (actor IN ('a','b')), pid integer UNIQUE NOT NULL
);

-- Synthetic input only. A completed source is not evidence of prior hands,
-- funding, winner selection or terminal settlement. Actual race writes below
-- always run with the real origin triggers and service request claims.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46462000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id,username) VALUES('46462000-0000-4000-8000-000000000001','r46_isolation_owner');
INSERT INTO public.users(id,username)
VALUES('46462000-0000-4000-8000-000000000001','r46_isolation_owner');
INSERT INTO public.clubs(id,club_id,name,asset,owner_id)
VALUES('46462000-0000-4000-8000-000000000002',994620,'R46 isolation chips club','chips',
  '46462000-0000-4000-8000-000000000001');
INSERT INTO public.tournaments(
  id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,
  starting_chips,min_players,max_players,table_size,current_players,status,start_time,
  is_bounty,is_pko,is_mystery_bounty,is_premium_spin,guaranteed_prize,prize_pool,
  prize_pool_finalized,blind_structure,payout_structure,payout_math_version,payout_unit_cents,format_contract
)
SELECT '46462000-0000-4000-8000-000000000003','46462000-0000-4000-8000-000000000002',
  'R46 isolation target','MTT','freezeout','NLH',180,20,10000,3,200,9,0,
  'REGISTERING',clock_timestamp()+interval '4 hours',false,false,false,false,0,0,false,
  jsonb_agg(jsonb_build_object('level',n,'smallBlind',25*n,'bigBlind',50*n,
    'ante',0,'durationMinutes',4) ORDER BY n)::text,
  '[{"place":1,"percentage":100}]',1,1,'mtt-v1' FROM generate_series(1,24) n;
INSERT INTO public.tournaments(
  id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,
  starting_chips,min_players,max_players,table_size,current_players,status,start_time,ended_at,
  is_bounty,is_pko,is_mystery_bounty,is_premium_spin,guaranteed_prize,prize_pool,
  prize_pool_finalized,blind_structure,payout_structure,payout_math_version,payout_unit_cents,
  restart_every_minutes,satellite_target,satellite_seats,synchronized_breaks,late_reg_levels,late_reg_mins,format_contract
)
SELECT '46462000-0000-4000-8000-000000000004',club_id,'R46 completed legacy source',
  'MTT','satellite',game_type,90,10,starting_chips,3,200,9,0,'COMPLETED',
  clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 minute',
  false,false,false,false,0,0,false,blind_structure,payout_structure,1,1,5,id,1,true,0,0,'mtt-v1'
FROM public.tournaments WHERE id='46462000-0000-4000-8000-000000000003';
-- Leave the actual preparation ABI at legacy-capacity-v1.
SET LOCAL session_replication_role=origin;

CREATE FUNCTION r46_mtt_isolation.assert_true(p_ok boolean,p_case text) RETURNS void
LANGUAGE plpgsql AS $check$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'R46 ASSERTION FAILED: %',p_case; END IF;
END $check$;

CREATE FUNCTION r46_mtt_isolation.economic_snapshot() RETURNS jsonb
LANGUAGE sql STABLE AS $economic$
  SELECT jsonb_build_object(
    'wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.wallets x),
    'club_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.club_wallets x),
    'union_wallets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.union_wallets x),
    'chip_ledger',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.chip_ledger x),
    'chip_transactions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.chip_transactions x),
    'wallet_transactions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.wallet_transactions x),
    'rake',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.rake_records x),
    'tickets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_tickets x),
    'payouts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_payouts x),
    'awards',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_satellite_awards x),
    'refund_entitlements',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.tournament_refund_entitlements x)
  );
$economic$;
CREATE TABLE r46_mtt_isolation.baseline AS
SELECT r46_mtt_isolation.economic_snapshot() AS economic;

CREATE FUNCTION r46_mtt_isolation.scheduled_config(p_name text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $config$
  SELECT jsonb_build_object(
    'club_id',club_id,'union_id',NULL,'name',p_name,'game_type','NLH',
    'variant','satellite','tournament_type','SATELLITE','buy_in_amount',90,'buy_in_fee',10,
    'guaranteed_prize',0,'starting_chips',10000,'max_players',NULL,'min_players',3,
    'table_size',9,'current_players',0,'status','REGISTERING',
    'blind_structure',blind_structure::jsonb,'blind_speed','turbo','is_turbo',true,
    'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
    'start_time',clock_timestamp()+interval '5 minutes','late_reg_levels',0,'late_reg_mins',0,
    'synchronized_breaks',true,'satellite_target_id',id,'satellite_seats',1,
    'short_description','R46 isolated concurrency test')
  FROM public.tournaments WHERE id='46462000-0000-4000-8000-000000000003';
$config$;

CREATE FUNCTION r46_mtt_isolation.config(p_name text) RETURNS jsonb
LANGUAGE sql VOLATILE AS $pair$
 SELECT jsonb_build_object('scheduled_config',v,'legacy_config',
 (v-'blind_speed'-'is_turbo'-'synchronized_breaks')||jsonb_build_object('variant','sng',
 'buy_in_amount',142.5,'buy_in_fee',7.5,'starting_chips',300,'max_players',2,'min_players',2,'table_size',2,
 'blind_structure','[{"level":1,"smallBlind":5,"bigBlind":10,"duration":180}]'::jsonb))
 FROM (SELECT r46_mtt_isolation.scheduled_config(p_name) v)q;
$pair$;

CREATE FUNCTION r46_mtt_isolation.pristine() RETURNS void
LANGUAGE plpgsql AS $pristine$
BEGIN
  PERFORM r46_mtt_isolation.assert_true((SELECT count(*)=2 FROM public.tournaments)
    AND NOT EXISTS(SELECT 1 FROM r46_mtt_isolation.observations)
    AND NOT EXISTS(SELECT 1 FROM r46_mtt_isolation.connections),
    'each permutation requires a fresh disposable fixture');
END $pristine$;

CREATE FUNCTION r46_mtt_isolation.ensure(p_actor text,p_expected text) RETURNS void
LANGUAGE plpgsql AS $ensure$
DECLARE r jsonb;
BEGIN
  r:=public.fn_ensure_scheduled_mtt_satellite(r46_mtt_isolation.config('R46 creator '||p_actor));
  PERFORM r46_mtt_isolation.assert_true(r->'ok'='true'::jsonb AND r->>'outcome'=p_expected
    AND r->>'club_id'='46462000-0000-4000-8000-000000000002'
    AND r->>'target_id'='46462000-0000-4000-8000-000000000003'
    AND r->'union_id'='null'::jsonb AND (r->>'tournament_id')::uuid IS NOT NULL
    AND r->>'format_contract'='seat-first-satellite-v1'
    AND EXISTS(SELECT 1 FROM public.tables WHERE id=(r->>'table_id')::uuid AND tournament_id=(r->>'tournament_id')::uuid AND max_players=2), 'exact ensure outcome and owner/target receipt');
  INSERT INTO r46_mtt_isolation.observations VALUES(p_actor,p_expected,(r->>'tournament_id')::uuid);
END $ensure$;

CREATE FUNCTION r46_mtt_isolation.expect_direct_target_refusal() RETURNS void
LANGUAGE plpgsql AS $unavailable$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    INSERT INTO public.tournaments(
      club_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
      guaranteed_prize,starting_chips,max_players,min_players,table_size,current_players,status,
      blind_structure,payout_structure,start_time,late_reg_levels,late_reg_mins,
      synchronized_breaks,satellite_target_id,satellite_seats
    ) SELECT club_id,'R46 direct creator','NLH','satellite','SATELLITE',90,10,
      0,10000,NULL,3,9,0,'REGISTERING',blind_structure,payout_structure,
      clock_timestamp()+interval '5 minutes',0,0,true,id,1
    FROM public.tournaments WHERE id='46462000-0000-4000-8000-000000000003';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM<>'SATELLITE_NEW_TARGET_UNSUPPORTED' THEN RAISE; END IF;
    refused:=true;
  END;
  PERFORM r46_mtt_isolation.assert_true(refused,'committed target edit refuses creation');
  INSERT INTO r46_mtt_isolation.observations VALUES('a','target_unsupported',NULL);
END $unavailable$;

CREATE FUNCTION r46_mtt_isolation.edit_target(p_refused boolean) RETURNS void
LANGUAGE plpgsql AS $edit$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    UPDATE public.tournaments SET variant='progressive_bounty' WHERE id='46462000-0000-4000-8000-000000000003';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM<>'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' THEN RAISE; END IF;
    refused:=true;
  END;
  PERFORM r46_mtt_isolation.assert_true(refused=p_refused,'target edit has the specified authoritative outcome');
  INSERT INTO r46_mtt_isolation.observations VALUES('b',CASE WHEN refused THEN 'edit_refused' ELSE 'edited' END,NULL);
END $edit$;

CREATE FUNCTION r46_mtt_isolation.clone_source(source_id uuid, overrides jsonb DEFAULT '{}'::jsonb) RETURNS uuid
LANGUAGE plpgsql AS $restart$ DECLARE cfg jsonb; v public.tournaments%ROWTYPE; new_id uuid;BEGIN
 SELECT jsonb_object_agg(key,value) INTO cfg FROM public.tournaments t,
 LATERAL jsonb_each(to_jsonb(t)) WHERE t.id=source_id AND key=ANY(ARRAY['club_id','union_id','is_xmtt','name','game_type','variant','tournament_type','buy_in_amount','buy_in_fee','starting_chips','max_players','min_players','blind_structure','payout_structure','payout_percent','guaranteed_prize','late_reg_levels','late_reg_mins','rebuy_levels','is_rebuy','is_reentry','rebuy_cost','rebuy_chips','add_on_available','addon_cost','addon_chips','addon_levels','is_bounty','bounty_amount','is_pko','is_mystery_bounty','mystery_bounty_min','mystery_bounty_max','mystery_bounty_profile','mystery_bounty_activation','mystery_bounty_activation_value','mystery_bounty_pool_percent','mystery_bounty_regular_pool_percent','mystery_bounty_top_percent','spin_type','satellite_target_id','satellite_target','satellite_seats','is_private','short_description','is_vip_only','ban_chat','all_in_or_fold','label_as_new','hide_club_name','action_time_seconds','table_size','accelerated_mtt','addon_break_minutes','big_blind_ante','authorized_to_register','early_bird_enabled','early_bird_chips','bubble_protection','final_table_deal_enabled','restart_every_minutes','synchronized_breaks','max_rebuys','max_reentries','is_multi_day','total_days','is_pinned']);
 cfg:=cfg||jsonb_build_object('restart_source_id',source_id,'current_players',0,'status','REGISTERING',
  'start_time',now()+interval '10 minutes','schedule_id',NULL)||overrides;
 SELECT * INTO v FROM jsonb_populate_record(NULL::public.tournaments,cfg);
 INSERT INTO public.tournaments(club_id,union_id,is_xmtt,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,starting_chips,max_players,min_players,blind_structure,payout_structure,payout_percent,guaranteed_prize,late_reg_levels,late_reg_mins,rebuy_levels,is_rebuy,is_reentry,rebuy_cost,rebuy_chips,add_on_available,addon_cost,addon_chips,addon_levels,is_bounty,bounty_amount,is_pko,is_mystery_bounty,mystery_bounty_min,mystery_bounty_max,mystery_bounty_profile,mystery_bounty_activation,mystery_bounty_activation_value,mystery_bounty_pool_percent,mystery_bounty_regular_pool_percent,mystery_bounty_top_percent,spin_type,satellite_target_id,satellite_target,satellite_seats,is_private,short_description,is_vip_only,ban_chat,all_in_or_fold,label_as_new,hide_club_name,action_time_seconds,table_size,accelerated_mtt,addon_break_minutes,big_blind_ante,authorized_to_register,early_bird_enabled,early_bird_chips,bubble_protection,final_table_deal_enabled,restart_every_minutes,synchronized_breaks,max_rebuys,max_reentries,is_multi_day,total_days,is_pinned,restart_source_id,current_players,status,start_time,schedule_id,format_contract) SELECT v.club_id,v.union_id,v.is_xmtt,v.name,v.game_type,v.variant,v.tournament_type,v.buy_in_amount,v.buy_in_fee,v.starting_chips,v.max_players,v.min_players,v.blind_structure,v.payout_structure,v.payout_percent,v.guaranteed_prize,v.late_reg_levels,v.late_reg_mins,v.rebuy_levels,v.is_rebuy,v.is_reentry,v.rebuy_cost,v.rebuy_chips,v.add_on_available,v.addon_cost,v.addon_chips,v.addon_levels,v.is_bounty,v.bounty_amount,v.is_pko,v.is_mystery_bounty,v.mystery_bounty_min,v.mystery_bounty_max,v.mystery_bounty_profile,v.mystery_bounty_activation,v.mystery_bounty_activation_value,v.mystery_bounty_pool_percent,v.mystery_bounty_regular_pool_percent,v.mystery_bounty_top_percent,v.spin_type,v.satellite_target_id,v.satellite_target,v.satellite_seats,v.is_private,v.short_description,v.is_vip_only,v.ban_chat,v.all_in_or_fold,v.label_as_new,v.hide_club_name,v.action_time_seconds,v.table_size,v.accelerated_mtt,v.addon_break_minutes,v.big_blind_ante,v.authorized_to_register,v.early_bird_enabled,v.early_bird_chips,v.bubble_protection,v.final_table_deal_enabled,v.restart_every_minutes,v.synchronized_breaks,v.max_rebuys,v.max_reentries,v.is_multi_day,v.total_days,v.is_pinned,v.restart_source_id,v.current_players,v.status,v.start_time,v.schedule_id,v.format_contract RETURNING id INTO new_id;
 RETURN new_id;
END $restart$;
CREATE FUNCTION r46_mtt_isolation.restart(p_actor text,p_minutes integer,p_duplicate boolean) RETURNS void
LANGUAGE plpgsql AS $restart$
DECLARE v_id uuid; duplicate boolean:=false; violated_constraint text;
BEGIN
  BEGIN
    v_id:=r46_mtt_isolation.clone_source('46462000-0000-4000-8000-000000000004',
      jsonb_build_object('start_time',clock_timestamp()+make_interval(mins=>p_minutes)));
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint=CONSTRAINT_NAME;
    IF violated_constraint<>'tournaments_one_restart_per_source' THEN RAISE; END IF;
    duplicate:=true;
  END;
  PERFORM r46_mtt_isolation.assert_true(duplicate=p_duplicate
    AND (duplicate OR v_id IS NOT NULL),'only the permanent source identity can refuse a duplicate restart');
  INSERT INTO r46_mtt_isolation.observations
    VALUES(p_actor,CASE WHEN duplicate THEN 'duplicate_refused' ELSE 'created' END,v_id);
END $restart$;

CREATE FUNCTION r46_mtt_isolation.blocked(p_owner text,p_waiter text) RETURNS void
LANGUAGE plpgsql AS $blocked$
BEGIN
  PERFORM r46_mtt_isolation.assert_true(EXISTS(
    SELECT 1 FROM r46_mtt_isolation.connections owner
    JOIN pg_stat_activity a ON a.pid=owner.pid
    CROSS JOIN r46_mtt_isolation.connections waiter
    JOIN pg_stat_activity b ON b.pid=waiter.pid
    WHERE owner.actor=p_owner AND waiter.actor=p_waiter
      AND a.datname=current_database() AND b.datname=current_database()
      AND a.application_name='r46-mtt-'||owner.actor
      AND b.application_name='r46-mtt-'||waiter.actor
      AND a.pid<>b.pid AND b.wait_event_type='Lock' AND a.pid=ANY(pg_blocking_pids(b.pid))
  ),'the exact competing session must actually wait for its owner');
END $blocked$;

CREATE FUNCTION r46_mtt_isolation.verify_final(p_case text) RETURNS void
LANGUAGE plpgsql AS $final$
DECLARE v_count integer; v_event uuid; v_observed jsonb;
BEGIN
  PERFORM r46_mtt_isolation.assert_true(p_case IN ('creation_commit','creation_rollback'),'legacy qualification is limited to creator cases');
  SELECT count(*),min(id::text)::uuid INTO v_count,v_event FROM public.tournaments
   WHERE id NOT IN ('46462000-0000-4000-8000-000000000003','46462000-0000-4000-8000-000000000004');
  SELECT jsonb_object_agg(actor,outcome) INTO v_observed FROM r46_mtt_isolation.observations;
  PERFORM r46_mtt_isolation.assert_true(v_observed=CASE p_case
    WHEN 'creation_commit' THEN '{"a":"created","b":"existing_active"}'::jsonb
    WHEN 'creation_rollback' THEN '{"b":"created"}'::jsonb
    WHEN 'edit_after_creation' THEN '{"a":"created","b":"edit_refused"}'::jsonb
    WHEN 'edit_before_creation' THEN '{"a":"target_unsupported","b":"edited"}'::jsonb
    WHEN 'restart_commit' THEN '{"a":"created","b":"duplicate_refused"}'::jsonb
    WHEN 'restart_rollback' THEN '{"b":"created"}'::jsonb END,'exact committed outcomes; rolled-back observations disappear');
  PERFORM r46_mtt_isolation.assert_true(v_count=CASE WHEN p_case='edit_before_creation' THEN 0 ELSE 1 END,
    'expected number of committed creations');
  IF v_count=1 THEN
    PERFORM r46_mtt_isolation.assert_true((SELECT max_players=2 AND min_players=2 AND table_size=2
      AND format_contract='seat-first-satellite-v1' AND tournament_type='SATELLITE' AND variant='sng' AND status='REGISTERING'
      AND starting_chips=300 AND buy_in_amount=142.5 AND buy_in_fee=7.5
      AND COALESCE(satellite_target_id,satellite_target)='46462000-0000-4000-8000-000000000003'
      AND club_id='46462000-0000-4000-8000-000000000002' AND union_id IS NULL
      AND current_players=0 AND COALESCE(prize_pool,0)=0 AND COALESCE(total_rake,0)=0
      AND COALESCE(bounty_pool,0)=0
      FROM public.tournaments WHERE id=v_event),'committed legacy HU keeps its fixed and unfunded300stack5percent contract');
    PERFORM r46_mtt_isolation.assert_true(NOT EXISTS(SELECT 1 FROM r46_mtt_isolation.observations
      WHERE outcome IN ('created','existing_active') AND event_id IS DISTINCT FROM v_event),'every successful receipt names that exact event');
    IF p_case LIKE 'restart_%' THEN
      PERFORM r46_mtt_isolation.assert_true((SELECT restart_source_id='46462000-0000-4000-8000-000000000004'
        FROM public.tournaments WHERE id=v_event),'restart keeps its immediate completed source');
    END IF;
  END IF;
  PERFORM r46_mtt_isolation.assert_true((SELECT variant=CASE WHEN p_case='edit_before_creation' THEN 'progressive_bounty' ELSE 'freezeout' END
    AND is_pko IS FALSE AND is_bounty IS FALSE FROM public.tournaments
    WHERE id='46462000-0000-4000-8000-000000000003'),'target mutation either commits or is refused exactly');
  PERFORM r46_mtt_isolation.assert_true(NOT EXISTS(SELECT 1 FROM public.tournament_players)
    AND (SELECT count(*)=1 FROM public.tables)
    AND EXISTS(SELECT 1 FROM public.tables WHERE tournament_id=v_event AND club_id='46462000-0000-4000-8000-000000000002'
      AND max_players=2 AND current_players=0 AND status='waiting')
    AND NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE tournament_id IN
      (SELECT id FROM public.tournaments)),'legacy creation opens exactly its real empty two-seat table without entrant or money movement');
  PERFORM r46_mtt_isolation.assert_true((SELECT economic=r46_mtt_isolation.economic_snapshot()
    FROM r46_mtt_isolation.baseline),'wallets, money history, tickets and entitlements remain exactly unchanged');
  PERFORM r46_mtt_isolation.assert_true(NOT EXISTS(SELECT 1 FROM public.tournament_escrow
    WHERE tournament_id IN (SELECT id FROM public.tournaments)
      AND (gross_in=0 AND fee_entries_in=0 AND satellite_fee_in=0
        AND bounty_in=0 AND overlay_in=0 AND satellite_in=0
        AND prize_out=0 AND bounty_out=0 AND fee_out=0
        AND refund_prize=0 AND refund_bounty=0 AND refund_fee=0
        AND reserve_in=0 AND reserve_out=0
        AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0) IS DISTINCT FROM true),
    'creation race books no custody activity, including offsetting inflows and outflows');
  RAISE NOTICE 'R46 ISOLATION ASSERTIONS COMPLETE: %',p_case;
END $final$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r46_mtt_isolation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA r46_mtt_isolation FROM PUBLIC;
COMMIT;
