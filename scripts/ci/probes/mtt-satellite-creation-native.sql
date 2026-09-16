-- R46 source-only authority probe. NOT EXECUTED.
-- Requires a complete, current, migrated protected local PostgreSQL fixture.
-- The real creation RPC and all installed creation/financial/format triggers
-- remain enabled. Synthetic owner/target seeding is not entry-funding proof.
-- Separate multi-session and full funded lifecycle catalogs remain mandatory.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
DO $local_only$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'R46 creation requires an owned local PostgreSQL fixture';
  END IF;
  IF to_regprocedure('public.fn_ensure_scheduled_mtt_satellite(jsonb)') IS NULL
     OR to_regprocedure('public.fn_poker_diamond_tournament(uuid)') IS NULL THEN
    RAISE EXCEPTION 'R46 current creation authority is incomplete';
  END IF;
  IF EXISTS(SELECT 1 FROM public.engine_maintenance_break) THEN
    RAISE EXCEPTION 'R46 requires an isolated maintenance fixture';
  END IF;
END $local_only$;

CREATE FUNCTION pg_temp.r46_assert(p_ok boolean,p_case text) RETURNS void
LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'R46 FAIL: %',p_case; END IF;
  RAISE NOTICE 'R46 PASS: %',p_case;
END $assert$;

CREATE TEMP TABLE r46_satellite_config(config jsonb NOT NULL);
INSERT INTO r46_satellite_config
SELECT jsonb_build_object(
  'club_id','46461000-0000-4000-8000-000000000001','union_id',NULL,
  'name','R46 target identity satellite','game_type','NLH','variant','satellite',
  'tournament_type','SATELLITE','buy_in_amount',90,'buy_in_fee',10,
  'guaranteed_prize',0,'starting_chips',10000,'max_players',2,'min_players',3,
  'table_size',9,'current_players',0,'status','REGISTERING',
  'blind_structure',jsonb_agg(jsonb_build_object('level',n,'smallBlind',25*n,
    'bigBlind',50*n,'ante',0,'durationMinutes',4) ORDER BY n),
  'blind_speed','turbo','is_turbo',true,
  'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
  'start_time',clock_timestamp()+interval '5 minutes','late_reg_levels',0,'late_reg_mins',0,
  'synchronized_breaks',true,'satellite_target_id','46461000-0000-4000-8000-000000000002',
  'satellite_seats',1,'short_description','R46 native probe; one funded seat')
FROM generate_series(1,24) n;

-- Only fixture inputs bypass triggers. Do not clone/replace authority bodies.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46461000-0000-4000-8000-000000000004');
INSERT INTO public.users(id,username)
VALUES('46461000-0000-4000-8000-000000000004','r46_satellite_fixture_owner');
INSERT INTO public.clubs(id,club_id,name,asset,owner_id)
VALUES('46461000-0000-4000-8000-000000000001',994610,'R46 native chips club','chips',
  '46461000-0000-4000-8000-000000000004');
INSERT INTO public.tournaments(
  id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,
  starting_chips,min_players,max_players,table_size,current_players,status,start_time,
  is_bounty,is_pko,is_mystery_bounty,is_premium_spin,guaranteed_prize,prize_pool,
  prize_pool_finalized,blind_structure,payout_structure,payout_math_version,payout_unit_cents
)
SELECT '46461000-0000-4000-8000-000000000002',
  '46461000-0000-4000-8000-000000000001','R46 plain target','MTT','freezeout','NLH',180,20,
  10000,3,2,9,0,'REGISTERING',clock_timestamp()+interval '4 hours',
  false,false,false,false,0,0,false,(config->'blind_structure')::text,
  (config->'payout_structure')::text,1,1 FROM r46_satellite_config;
SET LOCAL session_replication_role=origin;

DO $authorization$
DECLARE cfg jsonb; denied boolean:=false;
BEGIN
  SELECT config INTO cfg FROM r46_satellite_config;
  PERFORM pg_temp.r46_assert(NOT has_function_privilege('anon',
    'public.fn_ensure_scheduled_mtt_satellite(jsonb)','EXECUTE'),'anonymous ACL refusal');
  PERFORM pg_temp.r46_assert(NOT has_function_privilege('authenticated',
    'public.fn_ensure_scheduled_mtt_satellite(jsonb)','EXECUTE'),'authenticated ACL refusal');
  PERFORM pg_temp.r46_assert(has_function_privilege('service_role',
    'public.fn_ensure_scheduled_mtt_satellite(jsonb)','EXECUTE'),'service role has explicit execution grant');
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
  BEGIN
    PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  PERFORM pg_temp.r46_assert(denied,'body also refuses non-service claim');
END $authorization$;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);

DO $invalid_inputs$
DECLARE cfg jsonb; patch jsonb; refused boolean;
BEGIN
  SELECT config INTO cfg FROM r46_satellite_config;
  FOR patch IN SELECT value FROM jsonb_array_elements('[
    {"id":"46461000-0000-4000-8000-000000000099"},
    {"min_players":2},{"table_size":10},{"satellite_seats":2},
    {"buy_in_fee":5},{"buy_in_amount":45,"buy_in_fee":5},
    {"union_id":"46461000-0000-4000-8000-000000000099"},
    {"satellite_target_id":"46461000-0000-4000-8000-000000000099"},
    {"payout_structure":[{"place":1,"percentage":90}]},
    {"synchronized_breaks":false},{"blind_structure":[]}
  ]'::jsonb) LOOP
    refused:=false;
    BEGIN
      PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg||patch);
    EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
    END;
    PERFORM pg_temp.r46_assert(refused,'invalid config refused without creation: '||patch::text);
  END LOOP;
  PERFORM pg_temp.r46_assert(NOT EXISTS(SELECT 1 FROM public.tournaments
    WHERE satellite_target_id='46461000-0000-4000-8000-000000000002'),
    'invalid requests created no feeder');
END $invalid_inputs$;

-- Exercise the same installed source/target trigger body at the direct-writer
-- boundary. Its actual public attachment is required by the complete catalog.
CREATE TEMP TABLE r46_direct_feeder_probe(
  satellite_target_id uuid,satellite_target uuid,tournament_type text,variant text,
  is_bounty boolean,is_pko boolean,is_mystery_bounty boolean,is_premium_spin boolean,
  club_id uuid,union_id uuid,id uuid DEFAULT gen_random_uuid()
);
CREATE TRIGGER r46_actual_new_target_guard BEFORE INSERT ON r46_direct_feeder_probe
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_new_satellite_target();
DO $source_authority$
DECLARE flag text; refused boolean;
BEGIN
  FOREACH flag IN ARRAY ARRAY['is_bounty','is_pko','is_mystery_bounty','is_premium_spin'] LOOP
    refused:=false;
    BEGIN
      INSERT INTO r46_direct_feeder_probe VALUES(
        '46461000-0000-4000-8000-000000000002',NULL,'SATELLITE','satellite',
        flag='is_bounty',flag='is_pko',flag='is_mystery_bounty',flag='is_premium_spin',
        '46461000-0000-4000-8000-000000000001',NULL);
    EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
    END;
    PERFORM pg_temp.r46_assert(refused,'plain target cannot admit incompatible feeder source: '||flag);
  END LOOP;
  refused:=false;
  BEGIN
    INSERT INTO r46_direct_feeder_probe VALUES(NULL,NULL,'SATELLITE','satellite',false,false,false,false,
      '46461000-0000-4000-8000-000000000001',NULL);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'a new explicit satellite requires its qualification target');
END $source_authority$;

SAVEPOINT r46_freeze;
INSERT INTO public.engine_maintenance_break
  (id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,
   updated_at,enforce_freeze,ownership_token)
VALUES(true,'counting_down',clock_timestamp()-interval '2 minutes',clock_timestamp(),
  clock_timestamp()+interval '5 minutes','R46 native probe','R46 fixture',
  clock_timestamp(),true,'46461000-0000-4000-8000-000000000003');
SELECT pg_temp.r46_assert((public.fn_ensure_scheduled_mtt_satellite(config)->>'reason')='platform_frozen',
  'entry freeze refuses creation') FROM r46_satellite_config;
ROLLBACK TO SAVEPOINT r46_freeze;

-- A new feeder must not bypass unsupported Diamond ticket funding.
SAVEPOINT r46_diamond;
DO $diamond$
DECLARE cfg jsonb; diamond_club uuid; refused boolean:=false;
BEGIN
  -- The arena has a unique identity even with replication triggers disabled.
  -- Use the fixture's real identity; never seed a competing Diamond arena.
  SELECT id INTO diamond_club FROM public.clubs
   WHERE asset='diamonds' AND is_platform IS TRUE AND union_id IS NULL;
  IF diamond_club IS NULL THEN
    RAISE EXCEPTION 'R46 requires the current Diamond arena identity in its fixture';
  END IF;
  UPDATE r46_satellite_config SET config=config||jsonb_build_object('club_id',diamond_club);
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.tournaments SET club_id=diamond_club
   WHERE id='46461000-0000-4000-8000-000000000002';
  PERFORM set_config('session_replication_role','origin',true);
  SELECT config INTO cfg FROM r46_satellite_config;
  BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'Diamond target cannot use chip ticket creator');
END $diamond$;
ROLLBACK TO SAVEPOINT r46_diamond;

SAVEPOINT r46_target_rules;
DO $target_rules$
DECLARE cfg jsonb; label text; refused boolean;
BEGIN
  SELECT config INTO cfg FROM r46_satellite_config;
  FOREACH label IN ARRAY ARRAY['BOUNTY','PROGRESSIVE','PROGRESSIVE_BOUNTY','PKO','MYSTERY','MYSTERY_BOUNTY'] LOOP
    -- Model a stale, contradictory target row; real new creator stays active.
    PERFORM set_config('session_replication_role','replica',true);
    UPDATE public.tournaments SET variant=lower(label),tournament_type='MTT'
     WHERE id='46461000-0000-4000-8000-000000000002';
    PERFORM set_config('session_replication_role','origin',true);
    refused:=false;
    BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg);
    EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
    END;
    PERFORM pg_temp.r46_assert(refused,'bounty label is refused despite false flags: '||label);
    PERFORM set_config('session_replication_role','replica',true);
    UPDATE public.tournaments SET variant='freezeout',tournament_type=label
     WHERE id='46461000-0000-4000-8000-000000000002';
    PERFORM set_config('session_replication_role','origin',true);
    refused:=false;
    BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg);
    EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
    END;
    PERFORM pg_temp.r46_assert(refused,'bounty type is refused despite false flags: '||label);
  END LOOP;
END $target_rules$;
ROLLBACK TO SAVEPOINT r46_target_rules;

SAVEPOINT r46_target_time;
DO $target_time$
DECLARE cfg jsonb; deadline timestamptz; refused boolean;
BEGIN
  SELECT config INTO cfg FROM r46_satellite_config;
  FOREACH deadline IN ARRAY ARRAY[
    clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '8 days',
    'infinity'::timestamptz
  ] LOOP
    PERFORM set_config('session_replication_role','replica',true);
    UPDATE public.tournaments SET start_time=deadline
     WHERE id='46461000-0000-4000-8000-000000000002';
    PERFORM set_config('session_replication_role','origin',true);
    refused:=false;
    BEGIN PERFORM public.fn_ensure_scheduled_mtt_satellite(cfg);
    EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
    END;
    PERFORM pg_temp.r46_assert(refused,'new feeder enforces finite target horizon: '||deadline::text);
  END LOOP;
END $target_time$;
ROLLBACK TO SAVEPOINT r46_target_time;

CREATE TEMP TABLE r46_created(receipt jsonb NOT NULL);
INSERT INTO r46_created SELECT public.fn_ensure_scheduled_mtt_satellite(config)
FROM r46_satellite_config;
DO $created$
DECLARE r jsonb; cfg jsonb; replay jsonb; t public.tournaments%ROWTYPE;
BEGIN
  SELECT receipt INTO r FROM r46_created;
  SELECT config INTO cfg FROM r46_satellite_config;
  PERFORM pg_temp.r46_assert(r->>'outcome'='created' AND (r->>'ok')::boolean,
    'actual authority creates the feeder');
  SELECT * INTO t FROM public.tournaments WHERE id=(r->>'tournament_id')::uuid;
  PERFORM pg_temp.r46_assert(t.max_players IS NULL AND t.min_players=3
    AND t.table_size=9 AND t.status='REGISTERING' AND t.synchronized_breaks,
    'persisted unlimited MTT and finite table contract');
  replay:=public.fn_ensure_scheduled_mtt_satellite(cfg||'{"name":"Changed display name"}'::jsonb);
  PERFORM pg_temp.r46_assert(replay->>'outcome'='existing_active'
    AND replay->>'tournament_id'=r->>'tournament_id','target identity survives changed display name');
  PERFORM pg_temp.r46_assert(NOT EXISTS(SELECT 1 FROM public.tables WHERE tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=t.id),
    'creation invents no physical table or entrant');
  PERFORM pg_temp.r46_assert(COALESCE(t.prize_pool,0)=0 AND COALESCE(t.total_rake,0)=0
    AND COALESCE(t.bounty_pool,0)=0,'creation books no entry funding');
END $created$;

-- Admission must remain true after creation: updating the upstream event's
-- label cannot strand a live feeder while its boolean flags still say plain.
-- Both spellings of the incoming target pointer exercise the actual trigger.
SAVEPOINT r46_incoming_target_contract;
DO $incoming_target_contract$
DECLARE
  feeder_id uuid; legacy boolean; label text; refused boolean;
BEGIN
  SELECT (receipt->>'tournament_id')::uuid INTO feeder_id FROM r46_created;
  FOREACH legacy IN ARRAY ARRAY[false,true] LOOP
    UPDATE public.tournaments
       SET satellite_target_id=CASE WHEN legacy THEN NULL
             ELSE '46461000-0000-4000-8000-000000000002'::uuid END,
           satellite_target=CASE WHEN legacy THEN '46461000-0000-4000-8000-000000000002'::uuid
             ELSE NULL END
     WHERE id=feeder_id;
    FOREACH label IN ARRAY ARRAY['BOUNTY','PROGRESSIVE','PROGRESSIVE_BOUNTY','PKO','MYSTERY','MYSTERY_BOUNTY','SPIN'] LOOP
      refused:=false;
      BEGIN
        UPDATE public.tournaments SET variant=lower(label)
         WHERE id='46461000-0000-4000-8000-000000000002';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM<>'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' THEN RAISE; END IF;
        refused:=true;
      END;
      PERFORM pg_temp.r46_assert(refused,
        'live feeder protects target variant: '||label||', legacy='||legacy);
      refused:=false;
      BEGIN
        UPDATE public.tournaments SET tournament_type=label
         WHERE id='46461000-0000-4000-8000-000000000002';
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM<>'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' THEN RAISE; END IF;
        refused:=true;
      END;
      PERFORM pg_temp.r46_assert(refused,
        'live feeder protects target type: '||label||', legacy='||legacy);
    END LOOP;
  END LOOP;
  refused:=false;
  BEGIN
    UPDATE public.tournaments SET is_pko=true WHERE id=feeder_id;
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM<>'SATELLITE_NEW_SOURCE_UNSUPPORTED' THEN RAISE; END IF;
    refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'an existing feeder cannot add a PKO payout split');
  PERFORM pg_temp.r46_assert((SELECT variant='freezeout' AND tournament_type='MTT'
    AND is_bounty IS FALSE AND is_pko IS FALSE
    FROM public.tournaments WHERE id='46461000-0000-4000-8000-000000000002'),
    'refused target edits preserve the original plain entry contract');
END $incoming_target_contract$;
ROLLBACK TO SAVEPOINT r46_incoming_target_contract;

-- Exercise the installed restart guard and unique source identity using a
-- minimal native insert, separately from the client/engine clone-mapper tests.
SAVEPOINT r46_restart;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='COMPLETED',ended_at=clock_timestamp()-interval '1 minute',
  restart_every_minutes=5
 WHERE id=(SELECT (receipt->>'tournament_id')::uuid FROM r46_created);
SET LOCAL session_replication_role=origin;
CREATE FUNCTION pg_temp.r46_restart(p_source uuid,p_start timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $restart_fixture$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.tournaments(
    club_id,union_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
    guaranteed_prize,starting_chips,max_players,min_players,table_size,current_players,status,
    blind_structure,blind_speed,is_turbo,payout_structure,start_time,late_reg_levels,late_reg_mins,
    synchronized_breaks,satellite_target_id,satellite_seats,short_description,
    restart_every_minutes,restart_source_id
  ) SELECT
    club_id,union_id,name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,
    guaranteed_prize,starting_chips,NULL,min_players,table_size,0,'REGISTERING',
    blind_structure,blind_speed,is_turbo,payout_structure,p_start,late_reg_levels,late_reg_mins,
    synchronized_breaks,COALESCE(satellite_target_id,satellite_target),satellite_seats,short_description,
    restart_every_minutes,p_source
  FROM public.tournaments WHERE id=p_source RETURNING id INTO v_id;
  RETURN v_id;
END $restart_fixture$;
DO $restart_identity$
DECLARE source_id uuid; child_id uuid; next_id uuid; refused boolean;
BEGIN
  SELECT (receipt->>'tournament_id')::uuid INTO source_id FROM r46_created;
  -- Roll back a successful inner insert, modeling a failed original transaction.
  BEGIN
    PERFORM pg_temp.r46_restart(source_id,clock_timestamp()+interval '5 minutes');
    RAISE EXCEPTION 'R46 injected transaction rollback' USING ERRCODE='P4646';
  EXCEPTION WHEN SQLSTATE 'P4646' THEN NULL;
  END;
  PERFORM pg_temp.r46_assert(NOT EXISTS(SELECT 1 FROM public.tournaments WHERE restart_source_id=source_id),
    'rollback leaves no consumed restart identity');
  child_id:=pg_temp.r46_restart(source_id,clock_timestamp()+interval '6 minutes');
  PERFORM pg_temp.r46_assert(child_id IS NOT NULL,'restart creates a child after original rollback');
  refused:=false;
  BEGIN PERFORM pg_temp.r46_restart(source_id,clock_timestamp()+interval '7 minutes');
  EXCEPTION WHEN unique_violation THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'different start time cannot duplicate the same source');
  refused:=false;
  BEGIN UPDATE public.tournaments SET restart_source_id=NULL WHERE id=child_id;
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'child cannot discard its restart source');
  refused:=false;
  BEGIN UPDATE public.tournaments SET restart_source_id=child_id WHERE id=source_id;
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'an existing event cannot acquire a restart identity by update');
  refused:=false;
  BEGIN DELETE FROM public.tournaments WHERE id=child_id;
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'deleting a child cannot reopen the source identity');
  -- Model completion without claiming any funded hand or settlement proof.
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.tournaments SET status='COMPLETED',ended_at=clock_timestamp()-interval '1 minute'
   WHERE id=child_id;
  PERFORM set_config('session_replication_role','origin',true);
  refused:=false;
  BEGIN PERFORM pg_temp.r46_restart(source_id,clock_timestamp()+interval '8 minutes');
  EXCEPTION WHEN unique_violation THEN refused:=true;
  END;
  PERFORM pg_temp.r46_assert(refused,'terminal child still consumes its original source identity');
  next_id:=pg_temp.r46_restart(child_id,clock_timestamp()+interval '9 minutes');
  PERFORM pg_temp.r46_assert(EXISTS(SELECT 1 FROM public.tournaments
    WHERE id=next_id AND restart_source_id=child_id),'a completed child can be the next distinct source');
END $restart_identity$;
ROLLBACK TO SAVEPOINT r46_restart;

-- Legacy representation and a crossed future cutoff must still return the
-- active feeder; neither case authorizes creating a duplicate.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET satellite_target=satellite_target_id,satellite_target_id=NULL,
  variant='sng',tournament_type='SATELLITE',status='RUNNING',max_players=2
 WHERE id=(SELECT (receipt->>'tournament_id')::uuid FROM r46_created);
UPDATE public.tournaments SET start_time=clock_timestamp()+interval '30 minutes'
 WHERE id='46461000-0000-4000-8000-000000000002';
SET LOCAL session_replication_role=origin;
SELECT pg_temp.r46_assert(
  (public.fn_ensure_scheduled_mtt_satellite(c.config)->>'tournament_id')=r.receipt->>'tournament_id',
  'legacy target spelling, running status and crossed cutoff keep one active feeder')
FROM r46_satellite_config c CROSS JOIN r46_created r;
ROLLBACK;

-- Stronger snapshots need their own transactions. Do not attempt to change
-- isolation after the main fixture has already queried or seeded data.
-- This temporary function invokes the actual guard against isolated rows;
-- it proves the refusal contract only, not concurrent public-table execution.
CREATE FUNCTION pg_temp.r46_isolation_contract_probe() RETURNS void
LANGUAGE plpgsql AS $isolation_probe$
DECLARE refused boolean;
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'R46 isolation requires an owned local PostgreSQL fixture';
  END IF;
  CREATE TEMP TABLE r46_isolation_rows(
    id uuid,satellite_target_id uuid,satellite_target uuid,tournament_type text,variant text,
    is_bounty boolean DEFAULT false,is_pko boolean DEFAULT false,
    is_mystery_bounty boolean DEFAULT false,is_premium_spin boolean DEFAULT false,
    club_id uuid,union_id uuid,status text DEFAULT 'REGISTERING'
  );
  -- One plain target with no visible feeder and one unchanged legacy link.
  INSERT INTO r46_isolation_rows(id,tournament_type,variant,satellite_target_id) VALUES
    ('46461000-0000-4000-8000-000000000081','MTT','freezeout',NULL),
    ('46461000-0000-4000-8000-000000000082','SATELLITE','satellite',
     '46461000-0000-4000-8000-000000000083');
  CREATE TRIGGER r46_isolation_actual_guard
    BEFORE INSERT OR UPDATE OF satellite_target_id,satellite_target,
      is_bounty,is_pko,is_mystery_bounty,is_premium_spin,variant,tournament_type,club_id,union_id
    ON r46_isolation_rows FOR EACH ROW
    EXECUTE FUNCTION public.fn_ca_guard_new_satellite_target();
  UPDATE r46_isolation_rows SET variant=variant;
  UPDATE r46_isolation_rows SET status='RUNNING';
  IF (SELECT count(*) FROM r46_isolation_rows WHERE status='RUNNING')<>2 THEN
    RAISE EXCEPTION 'R46 FAIL: no-op and status updates must remain available';
  END IF;
  refused:=false;
  BEGIN
    UPDATE r46_isolation_rows SET variant='pko'
     WHERE id='46461000-0000-4000-8000-000000000081';
  EXCEPTION WHEN feature_not_supported THEN
    IF SQLERRM<>'SATELLITE_CONTRACT_REQUIRES_READ_COMMITTED' THEN RAISE; END IF;
    refused:=true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'R46 FAIL: old snapshot cannot authorize a target edit with no visible feeder';
  END IF;
  refused:=false;
  BEGIN
    INSERT INTO r46_isolation_rows(id,tournament_type,variant,satellite_target_id)
    VALUES('46461000-0000-4000-8000-000000000084','SATELLITE','satellite',
      '46461000-0000-4000-8000-000000000083');
  EXCEPTION WHEN feature_not_supported THEN
    IF SQLERRM<>'SATELLITE_CONTRACT_REQUIRES_READ_COMMITTED' THEN RAISE; END IF;
    refused:=true;
  END;
  IF NOT refused OR (SELECT count(*) FROM r46_isolation_rows)<>2 THEN
    RAISE EXCEPTION 'R46 FAIL: unsupported isolation must refuse a new linked feeder';
  END IF;
  RAISE NOTICE 'R46 PASS: % contract refusals and historical no-op/status compatibility',
    current_setting('transaction_isolation');
END $isolation_probe$;

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_temp.r46_isolation_contract_probe();
ROLLBACK;
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT pg_temp.r46_isolation_contract_probe();
ROLLBACK;
BEGIN ISOLATION LEVEL READ UNCOMMITTED;
SELECT pg_temp.r46_isolation_contract_probe();
ROLLBACK;
DROP FUNCTION pg_temp.r46_isolation_contract_probe();
SELECT 'R46_SATELLITE_CREATION_NATIVE_PASS' AS result;
