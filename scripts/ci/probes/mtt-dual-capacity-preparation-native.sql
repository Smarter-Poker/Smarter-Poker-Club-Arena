-- Paired-ABI guard qualification, not funded registration/payment proof.
-- All authorities are real captured bodies; only structural historical input
-- and the not-yet-activatable future ABI row are initialized with replica mode.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN RAISE EXCEPTION 'owned PG17 fixture required'; END IF;
END $local$;
CREATE FUNCTION pg_temp.dual_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'DUAL CAP FAIL: %',label; END IF;
 RAISE NOTICE 'DUAL CAP PASS: %',label;
END $$;
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,format_contract)
VALUES
 ('46464000-0000-4000-8000-000000000001','Legacy MTT cap','MTT','freezeout',3,3,9,0,0,10000,3,'REGISTERING',now()+interval '1 hour','mtt-v1'),
 ('46464000-0000-4000-8000-000000000002','Legacy HU satellite','SATELLITE','sng',2,2,2,0,0,300,2,'REGISTERING',now()+interval '1 hour','seat-first-satellite-v1'),
 ('46464000-0000-4000-8000-000000000003','Fixed SNG','SNG','sng',3,3,3,0,0,300,3,'REGISTERING',now()+interval '1 hour','sng-v1'),
 ('46464000-0000-4000-8000-000000000004','Fixed Spin','SPIN','spin',3,3,3,0,0,300,3,'REGISTERING',now()+interval '1 hour','spin-v1'),
 ('46464000-0000-4000-8000-000000000005','Unqualified old row','MTT','freezeout',3,3,9,0,0,10000,3,'REGISTERING',now()+interval '1 hour',NULL);
UPDATE public.tournaments SET status='RUNNING',started_at=now(),late_reg_levels=10,current_level=1
 WHERE id::text LIKE '46464000-%';
INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status)
SELECT t.id,('46464001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'fixture entrant',10000,'registered'
FROM public.tournaments t CROSS JOIN generate_series(1,3)n
WHERE t.id::text LIKE '46464000-%' AND n<=t.max_players;
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
CREATE TEMP TABLE dual_parent_before AS SELECT to_jsonb(t) original FROM public.tournaments t WHERE t.id::text LIKE '46464000-%';
CREATE TEMP TABLE dual_entry_probe(tournament_id uuid NOT NULL);
CREATE TRIGGER actual_capacity BEFORE INSERT ON dual_entry_probe
FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_tournament_capacity();
DO $legacy$
DECLARE id uuid; refused boolean; snapshot jsonb;
BEGIN
 FOR id IN SELECT t.id FROM public.tournaments t WHERE t.id::text LIKE '46464000-%' LOOP
  PERFORM pg_temp.dual_assert(public.fn_tournament_entry_cap_reached(id),'legacy numeric cap retained: '||id);
  refused:=false;
  BEGIN INSERT INTO dual_entry_probe VALUES(id); EXCEPTION WHEN check_violation THEN refused:=true; END;
  PERFORM pg_temp.dual_assert(refused,'legacy trigger still refuses full event: '||id);
 END LOOP;
 snapshot:=public.fn_ca_tournament_admission_snapshot(ARRAY[
  '46464000-0000-4000-8000-000000000001'::uuid,'46464000-0000-4000-8000-000000000002'::uuid]);
 PERFORM pg_temp.dual_assert(snapshot->>'admission_abi'='legacy-capacity-v1'
  AND snapshot#>>'{entries,0,effective_max_players}'='3'
  AND snapshot#>>'{entries,1,effective_max_players}'='2','snapshot preserves MTT and HU caps before activation');
 PERFORM pg_temp.dual_assert(NOT public.fn_tournament_late_registration_open('46464000-0000-4000-8000-000000000001'),'outer late-window cap still refuses full legacy MTT');
 refused:=false;
 BEGIN UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2' WHERE singleton;
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'MTT_ADMISSION_ACTIVATION_NOT_PREPARED' THEN RAISE; END IF;refused:=true; END;
 PERFORM pg_temp.dual_assert(refused,'this preparation still refuses real activation');
 refused:=false;
 BEGIN PERFORM public.fn_ca_tournament_admission_snapshot(ARRAY['46464000-0000-4000-8000-000000000005'::uuid]);
 EXCEPTION WHEN object_not_in_prerequisite_state THEN refused:=true;END;
 PERFORM pg_temp.dual_assert(refused,'unknown historical format cannot become snapshot authority');
 refused:=false;
 BEGIN PERFORM public.fn_ca_tournament_admission_snapshot(ARRAY['46464000-0000-4000-8000-000000000001'::uuid,'46464000-0000-4000-8000-000000000001'::uuid]);
 EXCEPTION WHEN invalid_parameter_value THEN refused:=true;END;
 PERFORM pg_temp.dual_assert(refused,'duplicate snapshot identity refused');
 PERFORM pg_temp.dual_assert(NOT has_function_privilege('authenticated','public.fn_ca_tournament_admission_snapshot(uuid[])','EXECUTE')
  AND NOT has_function_privilege('service_role','public.fn_ca_lock_mtt_admission_contract()','EXECUTE'),'snapshot browser and private-lock grants remain closed');
END $legacy$;
-- Future state initialization only; this is not proof that activation is ready.
SET LOCAL session_replication_role=replica;
UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2' WHERE singleton;
SET LOCAL session_replication_role=origin;
DO $future$
DECLARE id uuid; refused boolean; snapshot jsonb;
BEGIN
 PERFORM pg_temp.dual_assert(NOT public.fn_tournament_entry_cap_reached('46464000-0000-4000-8000-000000000001'),'recorded MTT ignores its stale cap in future ABI');
 PERFORM pg_temp.dual_assert(public.fn_tournament_late_registration_open('46464000-0000-4000-8000-000000000001'),'outer late-window admits recorded MTT beyond stale cap in future ABI');
 PERFORM pg_temp.dual_assert(NOT public.fn_tournament_late_registration_open('46464000-0000-4000-8000-000000000002'),'outer late-window retains accepted HU field cap');
 INSERT INTO dual_entry_probe VALUES('46464000-0000-4000-8000-000000000001');
 FOR id IN SELECT t.id FROM public.tournaments t WHERE t.id IN (
  '46464000-0000-4000-8000-000000000002','46464000-0000-4000-8000-000000000003','46464000-0000-4000-8000-000000000004') LOOP
  PERFORM pg_temp.dual_assert(public.fn_tournament_entry_cap_reached(id),'accepted fixed format keeps cap after activation: '||id);
  refused:=false;
  BEGIN INSERT INTO dual_entry_probe VALUES(id); EXCEPTION WHEN check_violation THEN refused:=true;END;
  PERFORM pg_temp.dual_assert(refused,'actual trigger protects accepted fixed format after activation: '||id);
 END LOOP;
 snapshot:=public.fn_ca_tournament_admission_snapshot(ARRAY[
  '46464000-0000-4000-8000-000000000001'::uuid,'46464000-0000-4000-8000-000000000002'::uuid]);
 PERFORM pg_temp.dual_assert(snapshot->>'admission_abi'='unlimited-mtt-v2'
  AND snapshot#>'{entries,0,effective_max_players}'='null'::jsonb
  AND snapshot#>>'{entries,1,effective_max_players}'='2','snapshot switches only MTT effective capacity');
 refused:=false;
 BEGIN PERFORM public.fn_tournament_entry_cap_reached('46464000-0000-4000-8000-000000000005');
 EXCEPTION WHEN object_not_in_prerequisite_state THEN refused:=true;END;
 PERFORM pg_temp.dual_assert(refused,'future admission refuses unknown format');
 PERFORM pg_temp.dual_assert(NOT EXISTS(SELECT 1 FROM dual_parent_before b
  FULL JOIN (SELECT to_jsonb(t) original FROM public.tournaments t WHERE t.id::text LIKE '46464000-%') a USING(original)
  WHERE b.original IS NULL OR a.original IS NULL),'all accepted parent terms remain byte-identical');
END $future$;
ROLLBACK;
SELECT 'MTT_DUAL_CAPACITY_PREPARATION_NATIVE_PASS' AS result;
