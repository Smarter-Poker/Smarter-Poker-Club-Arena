-- CA09 current v3 candidate. Source bodies recovered from tracked history; NOT EXECUTED.
-- Run only on the coordinator's disposable full_stage1 database, after review.
-- Never run against production. Exact current tracked bodies are installed in rollback.
-- Nine authority bodies were matched to live by coordinator equality-only checks.
-- Exact narrow source composition is installed only inside this outer rollback.
-- A refusal or missing prerequisite is a proof gap, not permission to bypass it.
\set ON_ERROR_STOP on
BEGIN;
-- CA09_COMPOSITION_GUARD_BEGIN
DO $uncomposed$ BEGIN RAISE EXCEPTION 'CA09 template must be composed before execution'; END; $uncomposed$;
-- CA09_COMPOSITION_GUARD_END
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '60s';

DO $source_install_database_guard$
BEGIN
  IF current_database()<>'full_stage1' OR current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR current_setting('port')<>'55473' THEN
    RAISE EXCEPTION 'CA09 source composition requires the disposable native socket';
  END IF;
END;
$source_install_database_guard$;

-- CA09_CURRENT_AUTHORITY_SETUP

DO $native_guard$
DECLARE e record; actual text;
BEGIN
  IF current_database() <> 'full_stage1' OR current_user <> 'postgres'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('port') <> '55473'
     OR NOT EXISTS (SELECT 1 FROM public.tournaments
                    WHERE id='30000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'CA09 requires the existing disposable full_stage1 socket fixture';
  END IF;
  FOR e IN SELECT * FROM (VALUES
    ('public.fn_thaw_platform(timestamptz,numeric,text)', 'f058bfbb8fb26b8412868fc9a2cbf900'),
    ('public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)', '071941c4f82d9f676622dc671fb0db40'),
    ('public.fn_thaw_platform_checkpointed(timestamptz,numeric,text)', '8390ea3b5e92685cc29c806c494a680a'),
    ('public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric)', '43455b0ff86f51f524b6190fc6bf7dd2'),
    ('public.fn_credit_maintenance_thaw_targets(timestamptz,numeric)', 'c12308b00489adce1376ba1c1e4ea9d5'),
    ('public.fn_active_maintenance_release_boundary()', '66f0ca0e4ebf27a74dd4b7c211c4fd0f'),
    ('public.fn_platform_frozen()', '112b1265824ee082b8adc67ea367d826'),
    ('public.fn_entry_purchases_frozen()', 'a29498531e4b7d3889532e80fafc8d57')
  ) v(identity, body_md5) LOOP
    SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=to_regprocedure(e.identity) AND proowner='postgres'::regrole;
    IF actual IS DISTINCT FROM e.body_md5 THEN
      RAISE EXCEPTION 'CA09 current source composition pin absent/mismatched: %', e.identity;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc
      WHERE oid=to_regprocedure('public.fn_thaw_reconnect_states(jsonb,numeric,numeric)')
        AND md5(prosrc)='0b5ef6cd1c6ba4e9331714f7c9053bd2'
        AND provolatile='i' AND NOT prosecdef) THEN
    RAISE EXCEPTION 'CA09 requires the exact tracked reconnect thaw helper';
  END IF;
  IF has_function_privilege('anon','public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)','EXECUTE')
     OR NOT EXISTS(SELECT 1 FROM pg_proc
       WHERE oid=to_regprocedure('public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)')
         AND proconfig @> ARRAY['lock_timeout=32s','statement_timeout=35s']) THEN
    RAISE EXCEPTION 'CA09 current five-argument ACL or deadline configuration differs';
  END IF;
  IF public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
    RAISE EXCEPTION 'CA09 requires no pre-existing future release certificate';
  END IF;
END;
$native_guard$;

CREATE TEMP TABLE ca09_parameters ON COMMIT DROP AS
SELECT date_trunc('second',clock_timestamp()) - make_interval(secs=>__CA09_FROZEN_SECONDS__) AS freeze_start,
       __CA09_FROZEN_SECONDS__::numeric AS frozen_seconds,
       'ca090000-0000-0000-0000-000000000001'::uuid AS ownership_token;
CREATE TEMP TABLE ca09_evidence(kind text PRIMARY KEY, value jsonb) ON COMMIT DROP;

-- Synthetic fixture setup follows atomic-tournament-hand-boundary.sql's
-- copy-from-known-baseline pattern. Every fixture and authority trigger stays enabled.
-- No financial receipt/ledger is seeded as success.
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t) || jsonb_build_object(
    'id', ('ca090100-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
    'name','CA09 synthetic clock '||n,
    'status',CASE WHEN n=44 THEN 'REGISTERING' ELSE 'RUNNING' END,
    'on_break',n=43,
    'break_started_at',CASE WHEN n=43 THEN p.freeze_start END,
    'break_ends_at',CASE WHEN n=43 THEN p.freeze_start+interval '300 seconds' END,
    'level_started_at',CASE WHEN n=45 THEN NULL ELSE p.freeze_start-interval '570 seconds' END,
    'started_at',p.freeze_start-interval '1 hour',
    'ended_at',NULL,'updated_at',now(),
    'addon_period_ends_at',CASE WHEN n=1 THEN p.freeze_start+interval '120 seconds'
                              WHEN n=2 THEN p.freeze_start-interval '1 second' END,
    'current_players',0,'prize_pool',0,'guaranteed_prize',0,
    'prize_pool_finalized',false,'bounty_pool',0,'bounty_pool_paid',0
  ))).*
FROM public.tournaments t CROSS JOIN ca09_parameters p CROSS JOIN generate_series(1,45) n
WHERE t.id='30000000-0000-0000-0000-000000000001';

-- Reuse the existing baseline participant and set only its synthetic clock.
-- No participant acquisition, table assignment, stack or receipt is created.
DO $existing_participant_guard$ BEGIN
  IF (SELECT count(*) FROM public.tournament_players
      WHERE tournament_id='30000000-0000-0000-0000-000000000001'
        AND user_id='10000000-0000-0000-0000-000000000001')<>1 THEN
    RAISE EXCEPTION 'CA09 requires one known existing baseline participant';
  END IF;
END; $existing_participant_guard$;
UPDATE public.tournament_players tp
SET rebuy_prompt_until=p.freeze_start+interval '20 seconds'
FROM ca09_parameters p
WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'
  AND tp.user_id='10000000-0000-0000-0000-000000000001';

-- Accepted-player sit-out coverage remains absent until an actual supported
-- acquisition fixture exists. No unoccupied or unauthorized seat substitutes it.
-- This is a synthetic maintenance owner, not a fabricated thaw-completion
-- receipt. The real thaw must create/checkpoint its own ledger row.
INSERT INTO public.engine_maintenance_break
  (id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,
   updated_at,enforce_freeze,ownership_token)
SELECT true,'counting_down',freeze_start-interval '120 seconds',freeze_start,
       freeze_start+interval '300 seconds','CA09 isolated clock probe','CA09 fixture',
       clock_timestamp(),true,ownership_token
FROM ca09_parameters
ON CONFLICT (id) DO UPDATE SET phase=excluded.phase,announced_at=excluded.announced_at,
  break_started_at=excluded.break_started_at,break_ends_at=excluded.break_ends_at,
  reason=excluded.reason,declared_by=excluded.declared_by,updated_at=excluded.updated_at,
  enforce_freeze=excluded.enforce_freeze,ownership_token=excluded.ownership_token;

CREATE TEMP TABLE ca09_tournaments_before ON COMMIT DROP AS
SELECT id,level_started_at,addon_period_ends_at,on_break,break_started_at,break_ends_at,started_at
FROM public.tournaments WHERE id::text LIKE 'ca090100-%';
DO $real_thaw$
DECLARE
  p record; r jsonb; denied jsonb; replay jsonb;
  calls integer:=0; seconds numeric; credit interval; endpoint timestamptz;
  before_replay jsonb; after_replay jsonb; wait_seconds double precision;
BEGIN
  SELECT * INTO STRICT p FROM ca09_parameters;
  IF (SELECT count(*) FROM ca09_tournaments_before)<>45 THEN
    RAISE EXCEPTION 'CA09 synthetic fixture incomplete';
  END IF;
  IF NOT public.fn_platform_frozen() OR NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'CA09 genuine durable freeze predicates did not hold';
  END IF;
  denied:=public.fn_thaw_platform(p.freeze_start-interval '120 seconds',p.freeze_start,
    1,'ca090000-0000-0000-0000-000000000099','CA09 wrong owner');
  IF denied->>'reason' IS DISTINCT FROM 'maintenance_ownership_changed'
     OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaws WHERE freeze_started_at=p.freeze_start) THEN
    RAISE EXCEPTION 'CA09 wrong owner was not refused before checkpoint creation';
  END IF;
  denied:=public.fn_thaw_platform(p.freeze_start-interval '121 seconds',p.freeze_start,
    1,p.ownership_token,'CA09 wrong announcement');
  IF denied->>'reason' IS DISTINCT FROM 'maintenance_identity_mismatch' THEN
    RAISE EXCEPTION 'CA09 wrong announcement was not refused';
  END IF;
  LOOP
    calls:=calls+1;
    -- The supplied one second deliberately cannot dictate credited time.
    -- The genuine v3 authority samples its database clock under the owner lock.
    r:=public.fn_thaw_platform(p.freeze_start-interval '120 seconds',p.freeze_start,
      1,p.ownership_token,'CA09 current v3 proof');
    IF r->>'ok' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'CA09 actual v3 thaw refused: %',r->>'reason';
    END IF;
    EXIT WHEN r->>'complete'='true';
    IF r->>'released' IS DISTINCT FROM 'false'
       OR NOT EXISTS(SELECT 1 FROM public.engine_maintenance_break WHERE id=true
           AND ownership_token=p.ownership_token)
       OR NOT public.fn_platform_frozen() OR NOT public.fn_entry_purchases_frozen() THEN
      RAISE EXCEPTION 'CA09 partial installment released its durable owner';
    END IF;
    IF calls>=12 THEN RAISE EXCEPTION 'CA09 actual v3 thaw incomplete after 12 calls'; END IF;
  END LOOP;
  seconds:=(r->>'effective_frozen_seconds')::numeric;
  endpoint:=(r->>'credited_through_at')::timestamptz;
  credit:=make_interval(secs=>seconds);
  IF calls<3 OR seconds<p.frozen_seconds OR endpoint IS DISTINCT FROM p.freeze_start+credit
     OR r->>'released' IS DISTINCT FROM 'true'
     OR r->>'reason' IS DISTINCT FROM 'thaw_complete_release_scheduled'
     OR EXISTS(SELECT 1 FROM public.engine_maintenance_break WHERE id=true) THEN
    RAISE EXCEPTION 'CA09 actual v3 release did not certify the full database-owned interval';
  END IF;
  IF NOT (r->'shifted' ?& ARRAY[
      'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
      'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
      'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
      'cluster_break_eligible_since','cluster_move_expires_at',
      'reconnect_presence','reconnect_snapshots']) THEN
    RAISE EXCEPTION 'CA09 completion lacks required deadline checkpoint keys';
  END IF;
  IF EXISTS(SELECT 1 FROM ca09_tournaments_before b JOIN public.tournaments t USING(id)
      WHERE b.id::text BETWEEN 'ca090100-0000-0000-0000-000000000001'
                          AND 'ca090100-0000-0000-0000-000000000042'
        AND t.level_started_at IS DISTINCT FROM b.level_started_at+credit) THEN
    RAISE EXCEPTION 'CA09 active level did not receive exactly the certified frozen interval';
  END IF;
  IF EXISTS(SELECT 1 FROM ca09_tournaments_before b JOIN public.tournaments t USING(id)
      WHERE b.id::text >= 'ca090100-0000-0000-0000-000000000043'
        AND t.level_started_at IS DISTINCT FROM b.level_started_at) THEN
    RAISE EXCEPTION 'CA09 synchronized owner, non-running event, or null clock was changed';
  END IF;
  IF EXISTS(SELECT 1 FROM ca09_tournaments_before b JOIN public.tournaments t USING(id)
      WHERE (t.on_break,t.break_started_at,t.break_ends_at,t.started_at)
         IS DISTINCT FROM (b.on_break,b.break_started_at,b.break_ends_at,b.started_at)) THEN
    RAISE EXCEPTION 'CA09 changed independent break ownership or registration history';
  END IF;
  IF (SELECT addon_period_ends_at FROM public.tournaments
      WHERE id='ca090100-0000-0000-0000-000000000001')
        IS DISTINCT FROM p.freeze_start+interval '120 seconds'+credit
     OR (SELECT addon_period_ends_at FROM public.tournaments
      WHERE id='ca090100-0000-0000-0000-000000000002')
        IS DISTINCT FROM p.freeze_start-interval '1 second' THEN
    RAISE EXCEPTION 'CA09 add-on window lost time or resurrected expired allowance';
  END IF;
  IF (SELECT rebuy_prompt_until FROM public.tournament_players
      WHERE tournament_id='30000000-0000-0000-0000-000000000001'
        AND user_id='10000000-0000-0000-0000-000000000001')
        IS DISTINCT FROM p.freeze_start+interval '20 seconds'+credit THEN
    RAISE EXCEPTION 'CA09 rebuy window lost frozen seconds';
  END IF;
  IF (SELECT count(*) FROM public.engine_maintenance_thaw_targets
      WHERE freeze_started_at=p.freeze_start AND step='level_started_at'
        AND target_id::text LIKE 'ca090100-%')<>42
     OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaw_targets
       WHERE freeze_started_at=p.freeze_start AND credited_seconds IS DISTINCT FROM seconds)
     OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaw_targets
       WHERE freeze_started_at=p.freeze_start AND step='level_started_at'
         AND target_id='ca090100-0000-0000-0000-000000000043') THEN
    RAISE EXCEPTION 'CA09 exact target receipts do not prove each eligible row and exclude the independent owner';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.engine_maintenance_thaws
      WHERE freeze_started_at=p.freeze_start AND contract_version=3
        AND ownership_token=p.ownership_token AND frozen_seconds=seconds
        AND release_target_at=endpoint AND shifted->>'complete'='true') THEN
    RAISE EXCEPTION 'CA09 actual v3 checkpoint disagrees with its receipt';
  END IF;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO before_replay
    FROM public.tournaments t WHERE id::text LIKE 'ca090100-%';
  replay:=public.fn_thaw_platform(p.freeze_start-interval '120 seconds',p.freeze_start,
    1,p.ownership_token,'CA09 current v3 proof');
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO after_replay
    FROM public.tournaments t WHERE id::text LIKE 'ca090100-%';
  IF replay->>'reason' IS DISTINCT FROM 'release_receipt_recovered'
     OR replay->>'complete' IS DISTINCT FROM 'true'
     OR replay->>'credited_through_at' IS DISTINCT FROM r->>'credited_through_at'
     OR replay->>'effective_frozen_seconds' IS DISTINCT FROM r->>'effective_frozen_seconds'
     OR before_replay IS DISTINCT FROM after_replay THEN
    RAISE EXCEPTION 'CA09 v3 receipt replay changed its endpoint or re-credited a row';
  END IF;
  IF public.fn_active_maintenance_release_boundary() IS DISTINCT FROM endpoint
     OR NOT public.fn_platform_frozen() OR NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'CA09 row clear opened admission before its certified endpoint';
  END IF;
  wait_seconds:=extract(epoch FROM endpoint-clock_timestamp())+0.02;
  IF wait_seconds>30 OR wait_seconds<=0 THEN
    RAISE EXCEPTION 'CA09 release endpoint outside bounded actual-clock observation';
  END IF;
  PERFORM pg_sleep(wait_seconds);
  IF public.fn_platform_frozen() OR public.fn_entry_purchases_frozen()
     OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
    RAISE EXCEPTION 'CA09 complete release did not open at its actual certified endpoint';
  END IF;
  INSERT INTO ca09_evidence VALUES('actual_v3_thaw',jsonb_build_object(
    'calls',calls,'requested_frozen_seconds',1,'fixture_elapsed_seconds',p.frozen_seconds,
    'effective_frozen_seconds',seconds,'receipt',r,
    'wrong_owner_refused',true,'wrong_announcement_refused',true,
    'partial_installments_keep_owner',true,'exact_target_credits',true,
    'future_endpoint_keeps_admission_frozen',true,'actual_endpoint_opens_admission',true,
    'receipt_replay_without_recredit',true,'active_level_rows',42,
    'independent_break_owner_preserved',true,'registration_start_preserved',true,
    'addon_current_and_expired',true,'rebuy_prompt',true,'nonempty_bomb_pot_proved',false,'accepted_player_sit_out_proved',false,
    'accepted_player_stack_and_time_bank_preservation_proved',false,
    'separate_committed_installment_transactions_proved',false,
    'all_fourteen_deadline_families_with_nonempty_rows_proved',false,
    'deployed_runtime_five_argument_adoption_proved',false));
END;
$real_thaw$;

DO $current_reconnect_suffix$
DECLARE s jsonb; r jsonb; later jsonb;
BEGIN
  s:='{"a":{"state":"MISSING","reconnectDeadlineMs":120000,"graceDeadlineMs":130000,"reconnectGrantedAtMs":90000,"strikes":2}}';
  r:=public.fn_thaw_reconnect_states(s,100000,400000);
  ASSERT (r#>>'{a,reconnectDeadlineMs}')::numeric=420000;
  ASSERT (r#>>'{a,graceDeadlineMs}')::numeric=430000;
  later:=public.fn_thaw_reconnect_states(r,100000,500000);
  ASSERT (later#>>'{a,reconnectDeadlineMs}')::numeric=520000;
  ASSERT (later#>>'{a,graceDeadlineMs}')::numeric=530000;
  ASSERT public.fn_thaw_reconnect_states(later,100000,500000)=later;
  ASSERT (public.fn_thaw_reconnect_states(s,100000,1100000)#>>'{a,reconnectDeadlineMs}')::numeric=1120000;
  ASSERT later#>'{a,strikes}'=s#>'{a,strikes}';
  INSERT INTO ca09_evidence VALUES('current_reconnect_helper',jsonb_build_object(
    'suffix_only',true,'distinct_grace_preserved',true,'replay_idempotent',true,
    'over_fifteen_minutes_not_abandoned',true,'strikes_preserved',true));
END;
$current_reconnect_suffix$;


-- Pure reconnect semantics are exercised through the genuine installed helper.
-- The maintained assertion body is inserted by the compose-only script.
-- CA09_RECONNECT_ASSERTIONS

SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'CA09_NATIVE_EVIDENCE='||jsonb_build_object(
  'native_assertions_reached',true,
  'authority','current_five_argument_v3',
  'current_function_bodies_match_coordinator_live_equalities',true,
  'live_schema_equivalence_verified',false,
  'phase_three_complete',false,
  'evidence',(SELECT jsonb_object_agg(kind,value) FROM ca09_evidence))::text;
ROLLBACK;
