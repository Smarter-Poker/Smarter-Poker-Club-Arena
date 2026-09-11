-- CA09 candidate only. NOT EXECUTED; current native/live equivalence unverified.
-- Run only on the coordinator's disposable full_stage1 database, after review.
-- Never run against production. Existing functions are invoked, never replaced.
-- Historical pins come from docs/audits/2026-09-10-phase3-clock-deadline-evidence.json.
-- The complete current ownership-aware implementation is not tracked here.
-- A refusal or missing prerequisite is a proof gap, not permission to bypass it.
\set ON_ERROR_STOP on
BEGIN;
-- CA09_COMPOSITION_GUARD_BEGIN
DO $uncomposed$ BEGIN RAISE EXCEPTION 'CA09 template must be composed before execution'; END; $uncomposed$;
-- CA09_COMPOSITION_GUARD_END
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '60s';

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
    ('public.fn_credit_maintenance_thaw_targets(timestamptz,numeric)', 'c12308b00489adce1376ba1c1e4ea9d5')
  ) v(identity, body_md5) LOOP
    SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=to_regprocedure(e.identity);
    IF actual IS DISTINCT FROM e.body_md5 THEN
      RAISE EXCEPTION 'CA09 historical native pin absent/mismatched: %', e.identity;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc
      WHERE oid=to_regprocedure('public.fn_thaw_reconnect_states(jsonb,numeric,numeric)')
        AND md5(prosrc)='__CA09_RECONNECT_SOURCE_MD5__'
        AND provolatile='i' AND NOT prosecdef) THEN
    RAISE EXCEPTION 'CA09 requires the exact tracked reconnect thaw helper';
  END IF;
END;
$native_guard$;

CREATE TEMP TABLE ca09_parameters ON COMMIT DROP AS
SELECT date_trunc('second',clock_timestamp()) - interval '300 seconds' AS freeze_start,
       300::numeric AS frozen_seconds,
       'ca090000-0000-0000-0000-000000000001'::uuid AS ownership_token;
CREATE TEMP TABLE ca09_evidence(kind text PRIMARY KEY, value jsonb) ON COMMIT DROP;

-- Synthetic fixture setup follows atomic-tournament-hand-boundary.sql's
-- copy-from-known-baseline pattern. Trigger suppression ends BEFORE every
-- tested authority call. No financial receipt/ledger is seeded as success.
SET LOCAL session_replication_role = replica;
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

INSERT INTO public.tables
  (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,bomb_pot_next_due_at)
SELECT 'ca090200-0000-0000-0000-000000000001','CA09 synthetic table',
       'ca090100-0000-0000-0000-000000000001','running','live',1,'tournament',
       '20000000-0000-0000-0000-000000000001',freeze_start+interval '30 seconds'
FROM ca09_parameters;

INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,
  to_jsonb(tp) || jsonb_build_object(
    'id','ca090300-0000-0000-0000-000000000001',
    'tournament_id','ca090100-0000-0000-0000-000000000001',
    'user_id','10000000-0000-0000-0000-000000000001',
    'chips',10,'status','playing','position',NULL,'prize',0,
    'eliminated_at',NULL,'elimination_sequence',NULL,
    'rebuy_prompt_until',p.freeze_start+interval '20 seconds',
    'table_id','ca090200-0000-0000-0000-000000000001','seat_number',1
  ))).*
FROM public.tournament_players tp CROSS JOIN ca09_parameters p
WHERE tp.tournament_id='30000000-0000-0000-0000-000000000001'
  AND tp.user_id='10000000-0000-0000-0000-000000000001';

INSERT INTO public.table_seats
  (id,table_id,seat_number,user_id,stack,status,left_at,joined_at,
   leave_pending,is_sitting_out,is_away,club_id,sit_out_at,
   time_bank_uses_remaining,time_bank_remaining)
SELECT 'ca090400-0000-0000-0000-000000000001',
       'ca090200-0000-0000-0000-000000000001',1,
       '10000000-0000-0000-0000-000000000001',10,'active',NULL,
       freeze_start-interval '1 hour',false,true,false,
       '20000000-0000-0000-0000-000000000001',freeze_start-interval '10 seconds',4,30
FROM ca09_parameters;

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
SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE ca09_tournaments_before ON COMMIT DROP AS
SELECT id,level_started_at,addon_period_ends_at,on_break,break_started_at,break_ends_at,started_at
FROM public.tournaments WHERE id::text LIKE 'ca090100-%';
CREATE TEMP TABLE ca09_seat_before ON COMMIT DROP AS
SELECT sit_out_at,stack,time_bank_remaining,time_bank_uses_remaining
FROM public.table_seats WHERE id='ca090400-0000-0000-0000-000000000001';

DO $real_thaw$
DECLARE p record; r jsonb; calls integer:=0; replay jsonb; before_replay jsonb; after_replay jsonb;
BEGIN
  SELECT * INTO STRICT p FROM ca09_parameters;
  IF (SELECT count(*) FROM ca09_tournaments_before)<>45
     OR (SELECT count(*) FROM ca09_seat_before)<>1 THEN
    RAISE EXCEPTION 'CA09 synthetic fixture incomplete';
  END IF;
  LOOP
    calls:=calls+1;
    -- Uses the same three-argument authority documented in the 09-10 audit.
    -- Does not bypass the ownership-aware wrapper or call private cores.
    r:=public.fn_thaw_platform(p.freeze_start,p.frozen_seconds,'CA09 isolated proof');
    IF r->>'ok' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'CA09 actual thaw refused: %',r->>'reason';
    END IF;
    EXIT WHEN r->>'complete'='true';
    IF calls>=12 THEN RAISE EXCEPTION 'CA09 actual thaw incomplete after 12 calls'; END IF;
  END LOOP;
  IF NOT (r->'shifted' ?& ARRAY[
      'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
      'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
      'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
      'cluster_break_eligible_since','cluster_move_expires_at',
      'reconnect_presence','reconnect_snapshots']) THEN
    RAISE EXCEPTION 'CA09 completion lacks required deadline checkpoint keys';
  END IF;
  INSERT INTO ca09_evidence VALUES('actual_thaw',jsonb_build_object('calls',calls,'receipt',r));

  IF EXISTS(SELECT 1 FROM ca09_tournaments_before b JOIN public.tournaments t USING(id)
      WHERE b.id::text BETWEEN 'ca090100-0000-0000-0000-000000000001'
                          AND 'ca090100-0000-0000-0000-000000000042'
        AND t.level_started_at IS DISTINCT FROM b.level_started_at+interval '300 seconds') THEN
    RAISE EXCEPTION 'CA09 active level did not receive exactly all 300 frozen seconds';
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
        IS DISTINCT FROM p.freeze_start+interval '420 seconds'
     OR (SELECT addon_period_ends_at FROM public.tournaments
      WHERE id='ca090100-0000-0000-0000-000000000002')
        IS DISTINCT FROM p.freeze_start-interval '1 second' THEN
    RAISE EXCEPTION 'CA09 add-on window lost time or resurrected expired allowance';
  END IF;
  IF (SELECT rebuy_prompt_until FROM public.tournament_players
      WHERE id='ca090300-0000-0000-0000-000000000001')
        IS DISTINCT FROM p.freeze_start+interval '320 seconds' THEN
    RAISE EXCEPTION 'CA09 rebuy window lost frozen seconds';
  END IF;
  IF (SELECT bomb_pot_next_due_at FROM public.tables
      WHERE id='ca090200-0000-0000-0000-000000000001')
        IS DISTINCT FROM p.freeze_start+interval '330 seconds' THEN
    RAISE EXCEPTION 'CA09 bomb-pot clock lost frozen seconds';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.table_seats s CROSS JOIN ca09_seat_before b
      WHERE s.id='ca090400-0000-0000-0000-000000000001'
        AND s.sit_out_at=b.sit_out_at+interval '300 seconds'
        AND (s.stack,s.time_bank_remaining,s.time_bank_uses_remaining)
          IS NOT DISTINCT FROM (b.stack,b.time_bank_remaining,b.time_bank_uses_remaining)) THEN
    RAISE EXCEPTION 'CA09 sit-out shift or independent stack/time-bank preservation failed';
  END IF;

  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO before_replay
    FROM public.tournaments t WHERE id::text LIKE 'ca090100-%';
  replay:=public.fn_thaw_platform(p.freeze_start,p.frozen_seconds,'CA09 isolated proof');
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO after_replay
    FROM public.tournaments t WHERE id::text LIKE 'ca090100-%';
  IF replay->>'ok' IS DISTINCT FROM 'true' OR replay->>'complete' IS DISTINCT FROM 'true'
     OR before_replay IS DISTINCT FROM after_replay THEN
    RAISE EXCEPTION 'CA09 exact replay re-credited or changed tournament state';
  END IF;
  IF (SELECT count(*) FROM public.engine_maintenance_thaws
      WHERE freeze_started_at=p.freeze_start)<>1 THEN
    RAISE EXCEPTION 'CA09 thaw must own one real checkpoint row';
  END IF;
  INSERT INTO ca09_evidence VALUES('clock_assertions',jsonb_build_object(
    'active_level_rows',42,'frozen_seconds',300,'independent_break_owner_preserved',true,
    'registration_start_preserved',true,'addon_current_and_expired',true,
    'rebuy_prompt',true,'bomb_pot',true,'sit_out',true,'stack_and_time_bank_preserved',true,
    'identical_replay_did_not_recredit',true,
    'separate_committed_installment_transactions_proved',false,
    'all_fourteen_deadline_families_with_nonempty_rows_proved',false));
END;
$real_thaw$;

-- Pure reconnect semantics are exercised through the genuine installed helper.
-- The maintained assertion body is inserted by the compose-only script.
-- CA09_RECONNECT_ASSERTIONS

SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'CA09_NATIVE_EVIDENCE='||jsonb_build_object(
  'native_assertions_reached',true,
  'historical_pin_date','2026-09-10',
  'fresh_live_equivalence_verified',false,
  'phase_three_complete',false,
  'evidence',(SELECT jsonb_object_agg(kind,value) FROM ca09_evidence))::text;
ROLLBACK;
