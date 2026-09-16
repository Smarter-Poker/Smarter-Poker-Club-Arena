-- R46 native capacity/schema guard probe. SOURCE ONLY: not yet executed.
-- Run only through an admitted protected local PostgreSQL catalog.
-- This executes installed helpers and real trigger bodies on isolated probe
-- tables. It is NOT proof of funded registration, concurrency, Manager handoff,
-- or ticket settlement; those require the separate full authority fixtures.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
DO $local_only$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'R46 requires an owned local PostgreSQL fixture';
  END IF;
  IF to_regprocedure('public.fn_ca_is_unlimited_mtt(jsonb)') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_is_unlimited(uuid)') IS NULL THEN
    RAISE EXCEPTION 'R46 migration is not installed';
  END IF;
END $local_only$;

CREATE FUNCTION pg_temp.r46_assert(p_ok boolean,p_case text) RETURNS void
LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'R46 FAIL: %',p_case; END IF;
  RAISE NOTICE 'R46 PASS: %',p_case;
END $assert$;

-- The migration must register the exact enabled money-table guards it installs.
-- A source-only name declaration cannot prove the real trigger is connected.
SELECT pg_temp.r46_assert((
  SELECT count(*)=3
  FROM (VALUES
    ('a0_tournaments_unlimited_entry_capacity','public.fn_ca_normalize_mtt_entry_capacity()'),
    ('a1_tournaments_restart_source','public.fn_ca_guard_tournament_restart_source()'),
    ('a2_tournaments_new_satellite_target','public.fn_ca_guard_new_satellite_target()')
  ) AS expected(trigger_name,function_identity)
  JOIN pg_trigger t ON t.tgrelid='public.tournaments'::regclass
    AND t.tgname=expected.trigger_name AND NOT t.tgisinternal AND t.tgenabled='O'
    AND t.tgfoid=to_regprocedure(expected.function_identity)
  JOIN public.ca_declared_money_triggers d ON d.table_name='tournaments'
    AND d.trigger_name=expected.trigger_name AND length(btrim(d.note))>0
),'all three installed MTT guards have their own money-trigger declarations');

DO $classifier$
DECLARE v_type text; v_target jsonb;
BEGIN
  FOREACH v_type IN ARRAY ARRAY[
    'mtt','xmtt','satellite','freezeout','bounty','progressive',
    'progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry',
    'mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry'
  ] LOOP
    PERFORM pg_temp.r46_assert(public.fn_ca_is_unlimited_mtt(
      jsonb_build_object('tournament_type',' '||upper(v_type)||' ',
        'variant','sng','max_players',2)),
      'explicit unlimited family overrides stale variant/cap: '||v_type);
  END LOOP;
  FOREACH v_type IN ARRAY ARRAY['sng','spin','hu_sng','heads_up'] LOOP
    PERFORM pg_temp.r46_assert(NOT public.fn_ca_is_unlimited_mtt(
      jsonb_build_object('tournament_type',v_type,'is_xmtt',true,'max_players',3)),
      'fixed format stays fixed despite cross-union flag: '||v_type);
  END LOOP;
  FOR v_target IN SELECT x FROM (VALUES
    ('{"satellite_target_id":"40000000-0000-4000-8000-000000000001"}'::jsonb),
    ('{"satelliteTargetId":"40000000-0000-4000-8000-000000000001"}'::jsonb),
    ('{"satellite_target":"40000000-0000-4000-8000-000000000001"}'::jsonb),
    ('{"satelliteTarget":{"tournamentId":"40000000-0000-4000-8000-000000000001"}}'::jsonb),
    ('{"satellite_target":{"tournament_id":"40000000-0000-4000-8000-000000000001"}}'::jsonb)
  ) targets(x) LOOP
    PERFORM pg_temp.r46_assert(public.fn_ca_is_unlimited_mtt(
      '{"tournament_type":"SNG","variant":"sng","max_players":2}'::jsonb||v_target),
      'genuine target makes linked SNG metadata a satellite: '||v_target::text);
  END LOOP;
  FOR v_target IN SELECT x FROM (VALUES
    ('{}'::jsonb),('{"satelliteTarget":{}}'::jsonb),
    ('{"satellite_target_id":null,"satelliteTargetId":""}'::jsonb),
    ('{"satelliteTarget":{"tournamentId":""}}'::jsonb),
    ('{"satellite_target":{"tournament_id":false}}'::jsonb)
  ) targets(x) LOOP
    PERFORM pg_temp.r46_assert(NOT public.fn_ca_is_unlimited_mtt(
      '{"tournament_type":"SNG","variant":"sng"}'::jsonb||v_target),
      'missing target does not unlock a fixed game: '||v_target::text);
  END LOOP;
  PERFORM pg_temp.r46_assert(NOT public.fn_ca_is_unlimited_mtt(NULL),'SQL null is unknown');
  PERFORM pg_temp.r46_assert(NOT public.fn_ca_is_unlimited_mtt('[]'),'array is unknown');
  PERFORM pg_temp.r46_assert(NOT public.fn_ca_is_unlimited_mtt('{"max_players":2}'),'numeric cap alone is not format evidence');
  PERFORM pg_temp.r46_assert(public.fn_ca_is_unlimited_mtt('{"variant":"mystery_bounty"}'),'known variant resolves an absent type');
END $classifier$;

-- Restore the pre-migration numeric values only in fixture seeding. Production
-- functions and financial guards are never replaced.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournaments(
 id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,
 started_at,current_level,late_reg_levels,rebuy_levels,late_reg_mins,
 prize_pool_finalized,payout_math_version,payout_unit_cents
) VALUES
 ('46460000-0000-4000-8000-000000000001','R46 legacy numeric MTT','MTT','freezeout',2,3,9,
  0,0,10000,3,'RUNNING',now()-interval '1 minute',now()-interval '1 minute',0,8,0,0,false,1,1),
 ('46460000-0000-4000-8000-000000000002','R46 legacy heads-up satellite','SATELLITE','sng',2,3,9,
  0,0,10000,3,'RUNNING',now()-interval '1 minute',now()-interval '1 minute',0,8,0,0,false,1,1),
 ('46460000-0000-4000-8000-000000000003','R46 NULL MTT','MTT','freezeout',NULL,3,6,
  0,0,10000,3,'RUNNING',now()-interval '1 minute',now()-interval '1 minute',0,8,0,0,false,1,1),
 ('46460000-0000-4000-8000-000000000004','R46 fixed SNG','SNG','sng',3,3,3,
  0,0,10000,3,'REGISTERING',now()+interval '1 hour',NULL,0,0,0,0,false,1,1),
 ('46460000-0000-4000-8000-000000000005','R46 fixed Spin','SPIN','spin',3,3,3,
  0,0,10000,3,'REGISTERING',now()+interval '1 hour',NULL,0,0,0,0,false,1,1);
INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status)
SELECT t.id,('46460100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'R46 seeded entrant '||n,10000,'playing'
FROM public.tournaments t CROSS JOIN generate_series(1,3) n
WHERE t.id IN (
 '46460000-0000-4000-8000-000000000001','46460000-0000-4000-8000-000000000002',
 '46460000-0000-4000-8000-000000000003','46460000-0000-4000-8000-000000000004',
 '46460000-0000-4000-8000-000000000005');
SET LOCAL session_replication_role=origin;

CREATE TEMP TABLE r46_entry_probe(tournament_id uuid NOT NULL);
CREATE TRIGGER r46_actual_capacity_trigger BEFORE INSERT ON r46_entry_probe
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_tournament_capacity();
DO $admission$
DECLARE v_id uuid; v_refused boolean;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[
    '46460000-0000-4000-8000-000000000001'::uuid,
    '46460000-0000-4000-8000-000000000002'::uuid,
    '46460000-0000-4000-8000-000000000003'::uuid
  ] LOOP
    PERFORM pg_temp.r46_assert(NOT public.fn_tournament_entry_cap_reached(v_id),
      'central cap helper admits MTT past stale cap: '||v_id);
    PERFORM pg_temp.r46_assert(public.fn_tournament_late_registration_open(v_id),
      'late registration remains open past stale cap: '||v_id);
    INSERT INTO r46_entry_probe VALUES(v_id);
  END LOOP;
  FOREACH v_id IN ARRAY ARRAY[
    '46460000-0000-4000-8000-000000000004'::uuid,
    '46460000-0000-4000-8000-000000000005'::uuid
  ] LOOP
    PERFORM pg_temp.r46_assert(public.fn_tournament_entry_cap_reached(v_id),
      'central cap helper refuses full fixed game: '||v_id);
    v_refused:=false;
    BEGIN
      INSERT INTO r46_entry_probe VALUES(v_id);
    EXCEPTION WHEN check_violation THEN v_refused:=true;
    END;
    PERFORM pg_temp.r46_assert(v_refused,'actual capacity trigger refuses full fixed game: '||v_id);
  END LOOP;
  PERFORM pg_temp.r46_assert(public.fn_ca_tournament_seat_cap(
    '46460000-0000-4000-8000-000000000002')=9,
    'legacy satellite uses physical table_size, not old two-entry cap');
  PERFORM pg_temp.r46_assert(public.fn_ca_tournament_seat_cap(
    '46460000-0000-4000-8000-000000000003')=6,'NULL MTT preserves six physical seats');
  PERFORM pg_temp.r46_assert(public.fn_ca_tournament_seat_cap(
    '46460000-0000-4000-8000-000000000005')=3,'Spin retains three physical seats');
END $admission$;

CREATE TEMP TABLE r46_waitlist_probe(tournament_id uuid NOT NULL);
CREATE TRIGGER r46_actual_waitlist_trigger BEFORE INSERT OR UPDATE ON r46_waitlist_probe
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_fixed_tournament_waitlist_only();
DO $waitlist$
DECLARE v_refused boolean:=false;
BEGIN
  BEGIN
    INSERT INTO r46_waitlist_probe VALUES('46460000-0000-4000-8000-000000000002');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused:=true;
  END;
  PERFORM pg_temp.r46_assert(v_refused,'legacy satellite cannot enter a capacity waitlist');
  INSERT INTO r46_waitlist_probe VALUES('46460000-0000-4000-8000-000000000004');
  DELETE FROM r46_waitlist_probe;
  PERFORM pg_temp.r46_assert(NOT EXISTS(SELECT 1 FROM r46_waitlist_probe),
    'fixed queue admission and owner departure remain available');
END $waitlist$;

-- Same real normalization/creation trigger bodies and CHECK expressions, with
-- unrelated launch/financial triggers intentionally outside this guard probe.
CREATE TEMP TABLE r46_config_probe(LIKE public.tournaments INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
CREATE TRIGGER a0_normalize BEFORE INSERT OR UPDATE ON r46_config_probe
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_normalize_mtt_entry_capacity();
CREATE TRIGGER a1_creation BEFORE INSERT ON r46_config_probe
FOR EACH ROW EXECUTE FUNCTION public.fn_tournaments_creation_guard();
DO $configuration$
DECLARE v_cap integer; v_min integer; v_refused boolean;
BEGIN
  INSERT INTO r46_config_probe(id,name,tournament_type,variant,max_players,buy_in_amount,buy_in_fee,
    starting_chips,start_time,payout_structure,payout_math_version,payout_unit_cents)
  VALUES('46460200-0000-4000-8000-000000000001','R46 unlimited creator','MTT','freezeout',2,0,0,
    10000,now()+interval '1 hour','[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]',2,1)
  RETURNING max_players,min_players INTO v_cap,v_min;
  PERFORM pg_temp.r46_assert(v_cap IS NULL,'numeric creator cap becomes NULL and v2 prize CHECK still accepts');
  PERFORM pg_temp.r46_assert(v_min>=3,'unlimited MTT creation keeps the Manager launch minimum');
  INSERT INTO r46_config_probe(id,name,tournament_type,variant,max_players,buy_in_amount,buy_in_fee,
    starting_chips,start_time)
  VALUES('46460200-0000-4000-8000-000000000002','R46 fixed creator','SNG','sng',3,0,0,
    10000,now()+interval '1 hour');
  v_refused:=false;
  BEGIN
    UPDATE r46_config_probe SET max_players=NULL
     WHERE id='46460200-0000-4000-8000-000000000002';
  EXCEPTION WHEN check_violation THEN v_refused:=true;
  END;
  PERFORM pg_temp.r46_assert(v_refused,'fixed UPDATE NULL cannot disable its entry capacity');
END $configuration$;
ROLLBACK;
SELECT 'R46_UNLIMITED_ENTRY_CAP_NATIVE_PASS' AS result;
