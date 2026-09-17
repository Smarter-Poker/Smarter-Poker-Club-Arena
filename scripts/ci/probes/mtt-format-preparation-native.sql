-- Run only in the existing composed, disposable PostgreSQL17 MTT fixture.
-- Backfill, creators and all operations under test keep real origin triggers.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' OR EXISTS(SELECT 1 FROM public.tournaments) THEN
  RAISE EXCEPTION 'MTT format probe requires a fresh private MTT fixture';
 END IF;
END $local$;
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FORMAT FAIL: %',label; END IF;
 RAISE NOTICE 'FORMAT PASS: %',label;
END $$;
-- Only synthetic identity input is loaded with replica semantics.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46463000-0000-4000-8000-000000000001');
INSERT INTO public.users(id,username) VALUES('46463000-0000-4000-8000-000000000001','format_fixture');
INSERT INTO public.profiles(id) VALUES('46463000-0000-4000-8000-000000000001');
INSERT INTO public.clubs(id,club_id,name,asset,owner_id)
VALUES('46463000-0000-4000-8000-000000000002',994630,'Format fixture','chips','46463000-0000-4000-8000-000000000001');
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',false);
CREATE TEMP TABLE format_fixture_config AS
SELECT jsonb_build_object('club_id','46463000-0000-4000-8000-000000000002',
 'name','Legacy shape','game_type','NLH','variant','sng','tournament_type','SNG',
 'buy_in_amount',19,'buy_in_fee',1,'guaranteed_prize',0,'starting_chips',300,
 'max_players',2,'min_players',2,'table_size',2,'current_players',0,'status','REGISTERING',
 'blind_structure',jsonb_build_array(jsonb_build_object('level',1,'smallBlind',5,'bigBlind',10,'durationMinutes',3)),
 'payout_structure',jsonb_build_array(jsonb_build_object('place',1,'percentage',100)),
 'start_time',now()+interval '1 hour','late_reg_levels',0,'late_reg_mins',0) config;
-- Real MTT creation, with its source-captured initial contract.
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,
 starting_chips,min_players,max_players,table_size,status,start_time,guaranteed_prize,
 blind_structure,payout_structure,description)
SELECT '46463000-0000-4000-8000-000000000010','46463000-0000-4000-8000-000000000002',
 'Proven MTT','MTT','freezeout','NLH',180,20,10000,3,100,9,'REGISTERING',now()+interval '5 hours',0,
 jsonb_agg(jsonb_build_object('level',n,'smallBlind',25*n,'bigBlind',50*n,'ante',0,'durationMinutes',4) ORDER BY n)::text,
 '[{"place":1,"percentage":100}]',repeat('Registered tournament terms. ',128) FROM generate_series(1,64)n;
SELECT public.fn_create_seat_first_game_atomic('46463000-0000-4000-8000-000000000011',
 config||'{"name":"Proven HU satellite","tournament_type":"SATELLITE","satellite_target_id":"46463000-0000-4000-8000-000000000010","satellite_seats":1}'::jsonb)
FROM format_fixture_config;
SELECT public.fn_create_seat_first_game_atomic('46463000-0000-4000-8000-000000000012',config)
FROM format_fixture_config;
SELECT public.fn_create_seat_first_game_atomic('46463000-0000-4000-8000-000000000013',
 config||'{"name":"Proven Spin","tournament_type":"SPIN","variant":"spin","buy_in_amount":20,"buy_in_fee":0,"max_players":3,"min_players":3,"table_size":3}'::jsonb)
FROM format_fixture_config;

-- Match the observed installation cohort's 1,118 proven active parents.
-- These 1,114 additional ordinary MTTs use the same valid persisted terms as
-- the original MTT above. Real origin creation/history guards capture every
-- row; the four malformed active controls below are additional, not counted.
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,
 starting_chips,min_players,max_players,table_size,status,start_time,guaranteed_prize,
 blind_structure,payout_structure,description)
SELECT ('46463100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,t.club_id,
 'Proven cardinality MTT '||n,t.tournament_type,t.variant,t.game_type,t.buy_in_amount,t.buy_in_fee,
 t.starting_chips,t.min_players,t.max_players,t.table_size,t.status,t.start_time,t.guaranteed_prize,
 t.blind_structure,t.payout_structure,t.description
FROM public.tournaments t CROSS JOIN generate_series(1,1114)n
WHERE t.id='46463000-0000-4000-8000-000000000010';

-- Structural registered-player history, not a paid registration claim. The
-- roster input is synthetic; no business call or guard is replaced. The actual
-- metadata migration operates on these public parents with every origin
-- trigger and the real lifecycle guard enabled, as postgres without a JWT.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,registered_at)
SELECT t.id,'46463000-0000-4000-8000-000000000001','format fixture',t.starting_chips,'registered',t.created_at+interval '1 second'
FROM public.tournaments t;
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','',false);
SELECT set_config('request.jwt.claims','{}',false);
-- Exercise the exact installed trigger on temporary row-shaped relations. This
-- isolates its refusal contract from earlier unrelated triggers; the actual
-- public-table migration below separately keeps every origin trigger enabled.
CREATE TEMP TABLE tournaments AS SELECT * FROM public.tournaments
WHERE id='46463000-0000-4000-8000-000000000010';
CREATE TRIGGER actual_lifecycle BEFORE UPDATE ON pg_temp.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_lifecycle();
CREATE TEMP TABLE tables AS SELECT * FROM public.tables LIMIT 1;
CREATE TRIGGER actual_lifecycle BEFORE UPDATE ON pg_temp.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_lifecycle();
CREATE FUNCTION pg_temp.check_lifecycle_guard() RETURNS jsonb LANGUAGE plpgsql AS $proof$
DECLARE k text; keys text[]:=ARRAY[
 'name','start_time','max_players','buy_in_amount','buy_in_fee','guaranteed_prize','late_reg_mins',
 'starting_chips','blind_structure','payout_structure','game_type','variant','tournament_type','is_rebuy',
 'rebuy_cost','rebuy_chips','rebuy_levels','add_on_available','addon_cost','addon_chips','is_bounty',
 'bounty_amount','is_pko','is_mystery_bounty','mystery_bounty_min','mystery_bounty_max','description',
 'short_description','min_players','late_reg_levels','is_reentry','max_rebuys','max_reentries','addon_levels',
 'addon_break_minutes','is_private','is_vip_only','ban_chat','all_in_or_fold','label_as_new','hide_club_name',
 'is_pinned','action_time_seconds','table_size','accelerated_mtt','big_blind_ante','authorized_to_register',
 'early_bird_enabled','early_bird_chips','bubble_protection','final_table_deal_enabled','restart_every_minutes',
 'synchronized_breaks','is_multi_day','total_days','is_xmtt','union_id','satellite_target_id','satellite_seats',
 'spin_type','mystery_bounty_profile','mystery_bounty_activation','mystery_bounty_activation_value',
 'mystery_bounty_pool_percent','mystery_bounty_top_percent','settings'];
 original jsonb; patched jsonb; value jsonb; category "char"; typ text; refused boolean; checked integer:=0;
BEGIN
 IF current_setting('session_replication_role')<>'origin' OR COALESCE(auth.role(),'')<>'' THEN
  RAISE EXCEPTION 'lifecycle proof must start as ordinary postgres with no JWT';
 END IF;
 SELECT to_jsonb(t) INTO STRICT original FROM pg_temp.tournaments t;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=(original->>'id')::uuid) THEN
  RAISE EXCEPTION 'lifecycle proof needs a registered parent';
 END IF;
 FOREACH k IN ARRAY keys LOOP
  IF NOT original ? k THEN
   IF k<>'settings' THEN RAISE EXCEPTION 'unexpected missing protected column: %',k;END IF;
   CONTINUE;
  END IF;
  IF original->k IS DISTINCT FROM 'null'::jsonb THEN value:='null';
  ELSE
   SELECT t.typcategory,t.typname INTO category,typ FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
   WHERE a.attrelid='pg_temp.tournaments'::regclass AND a.attname=k;
   value:=CASE WHEN category='B' THEN 'true'::jsonb WHEN category='N' THEN '1'::jsonb
    WHEN category='D' THEN to_jsonb('2027-01-01T00:00:00Z'::text)
    WHEN category='A' THEN '[]'::jsonb WHEN typ='uuid' THEN to_jsonb('46463000-0000-4000-8000-000000000002'::text)
    WHEN typ IN ('json','jsonb') THEN '{"guard_probe":true}'::jsonb ELSE to_jsonb('guard probe'::text) END;
  END IF;
  patched:=jsonb_set(original,ARRAY[k],value);refused:=false;
  BEGIN
   EXECUTE format('UPDATE pg_temp.tournaments SET %I=(SELECT r.%I FROM jsonb_populate_record(NULL::pg_temp.tournaments,$1)r)',k,k) USING patched;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>'This tournament cannot be modified after a player has registered' THEN RAISE;END IF;
   refused:=true;
  END;
  IF NOT refused OR (SELECT to_jsonb(t) FROM pg_temp.tournaments t) IS DISTINCT FROM original THEN
   RAISE EXCEPTION 'protected tournament key not preserved: %',k;
  END IF;
  checked:=checked+1;
 END LOOP;
 refused:=false;
 BEGIN UPDATE pg_temp.tournaments SET status='CANCELLED';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'This tournament cannot be cancelled after a player has registered' THEN RAISE;END IF;refused:=true;END;
 IF NOT refused THEN RAISE EXCEPTION 'registered cancellation unexpectedly allowed';END IF;
 -- Engine exemption remains exactly where it was; the tested metadata apply
 -- itself never uses it. Temp rows do not cause financial or lifecycle effects.
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE pg_temp.tournaments SET name='engine permitted';
 UPDATE pg_temp.tournaments SET name=original->>'name';
 PERFORM set_config('request.jwt.claim.role','',true);
 PERFORM set_config('request.jwt.claims','{}',true);
 refused:=false;
 BEGIN UPDATE pg_temp.tables SET is_deleted=true;
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM<>'Table lifecycle changes must use fn_close_managed_game' THEN RAISE;END IF;refused:=true;END;
 IF NOT refused THEN RAISE EXCEPTION 'unmanaged table deletion unexpectedly allowed';END IF;
 PERFORM set_config('app.managed_game_lifecycle','on',true);
 UPDATE pg_temp.tables SET is_deleted=true;
 UPDATE pg_temp.tables SET is_deleted=false;
 PERFORM set_config('app.managed_game_lifecycle','',true);
 IF (SELECT to_jsonb(t) FROM pg_temp.tournaments t) IS DISTINCT FROM original THEN
  RAISE EXCEPTION 'lifecycle proof changed parent';END IF;
 RETURN jsonb_build_object('protected_keys',checked,'registered_cancel_refused',true,
  'engine_edit_preserved',true,'unmanaged_table_delete_refused',true,'managed_table_delete_preserved',true);
END $proof$;
CREATE TEMP TABLE lifecycle_before AS SELECT pg_temp.check_lifecycle_guard() result;

-- Exercise the real trigger and durable event owner on isolated row-shaped
-- relations. Public business rows and original backing tables are not edited.
CREATE SCHEMA r46_emitter_probe;
CREATE TABLE r46_emitter_probe.tournaments AS SELECT * FROM public.tournaments
WHERE id='46463000-0000-4000-8000-000000000010';
CREATE TABLE r46_emitter_probe.tables AS SELECT * FROM public.tables LIMIT 1;
UPDATE r46_emitter_probe.tables SET tournament_id=NULL;
CREATE TRIGGER actual_emitter AFTER INSERT OR UPDATE OR DELETE ON r46_emitter_probe.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_managed_game_row_event();
CREATE TRIGGER actual_emitter AFTER INSERT OR UPDATE OR DELETE ON r46_emitter_probe.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_managed_game_row_event();
CREATE FUNCTION pg_temp.check_row_emitter() RETURNS jsonb LANGUAGE plpgsql AS $proof$
DECLARE kind text; k text; watched text[]; original jsonb; patched jsonb; value jsonb;
 category "char"; typ text; before_seq bigint; expected integer; actual integer;
 checked integer:=0; insert_delete integer:=0; quiet integer:=0; suppressed integer:=0;
 row_id uuid; club_id uuid; op text; event_row public.game_management_events%ROWTYPE;
BEGIN
 IF current_setting('session_replication_role')<>'origin' OR current_user<>'postgres'
    OR COALESCE(auth.role(),'')<>'' THEN RAISE EXCEPTION 'emitter proof needs ordinary postgres origin';END IF;
 FOREACH kind IN ARRAY ARRAY['tournaments','tables'] LOOP
  EXECUTE format('SELECT to_jsonb(t) FROM r46_emitter_probe.%I t',kind) INTO STRICT original;
  row_id:=(original->>'id')::uuid;club_id:=(original->>'club_id')::uuid;
  watched:=CASE kind WHEN 'tables' THEN ARRAY[
   'club_id','union_id','tournament_id','is_deleted','name','status','game_variant',
   'current_players','max_players','small_blind','big_blind','min_buy_in','max_buy_in','created_at']
   ELSE ARRAY['club_id','union_id','name','status','game_type','variant','current_players',
   'max_players','start_time','created_at','buy_in_amount','guaranteed_prize','prize_pool'] END;
  FOREACH k IN ARRAY watched LOOP
   IF NOT original ? k THEN RAISE EXCEPTION 'missing actual watched field: %.%',kind,k;END IF;
   IF original->k IS DISTINCT FROM 'null'::jsonb THEN value:='null';
   ELSE
    SELECT t.typcategory,t.typname INTO category,typ FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
     WHERE a.attrelid=format('r46_emitter_probe.%I',kind)::regclass AND a.attname=k;
    value:=CASE WHEN category='B' THEN 'true'::jsonb WHEN category='N' THEN '1'::jsonb
     WHEN category='D' THEN to_jsonb('2027-01-01T00:00:00Z'::text)
     WHEN typ='uuid' THEN to_jsonb('46463000-0000-4000-8000-000000000010'::text)
     ELSE to_jsonb('emitter proof'::text) END;
   END IF;
   patched:=jsonb_set(original,ARRAY[k],value);
   expected:=CASE WHEN kind='tables' AND k='tournament_id' THEN 0 ELSE 1 END;
   BEGIN
    SELECT COALESCE(max(sequence),0) INTO before_seq FROM public.game_management_events;
    EXECUTE format('UPDATE r46_emitter_probe.%I SET %I=(SELECT r.%I FROM jsonb_populate_record(NULL::r46_emitter_probe.%I,$1)r)',kind,k,k,kind) USING patched;
    SELECT count(*) INTO actual FROM public.game_management_events WHERE sequence>before_seq;
    IF actual<>expected THEN RAISE EXCEPTION 'watched event count %.%: % not %',kind,k,actual,expected;END IF;
    IF expected=1 THEN
     SELECT * INTO STRICT event_row FROM public.game_management_events WHERE sequence>before_seq;
     IF event_row.event_type<>'game_changed' OR event_row.entity_id IS DISTINCT FROM row_id
       OR event_row.entity_type IS DISTINCT FROM (CASE kind WHEN 'tables' THEN 'table' ELSE 'tournament' END)
       OR event_row.club_id IS DISTINCT FROM club_id OR event_row.scope_kind<>'club'
       OR event_row.scope_id IS DISTINCT FROM club_id OR event_row.actor_id IS NOT NULL
       OR event_row.payload IS DISTINCT FROM '{"operation":"update"}'::jsonb THEN
      RAISE EXCEPTION 'watched event payload changed %.%',kind,k;
     END IF;
    END IF;
    checked:=checked+1;
    RAISE EXCEPTION 'rollback isolated event case' USING ERRCODE='ZX001';
   EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
  END LOOP;
  -- No-op and real unwatched changes stay quiet. Explicit SQL NULL in a
  -- watched field still compares equal on the following unwatched update.
  FOREACH op IN ARRAY ARRAY['noop','unwatched','null-watched','missing-watched'] LOOP
   BEGIN
    IF op='null-watched' THEN EXECUTE format('UPDATE r46_emitter_probe.%I SET name=NULL',kind);END IF;
    IF op='missing-watched' THEN EXECUTE format('ALTER TABLE r46_emitter_probe.%I DROP COLUMN name',kind);END IF;
    SELECT COALESCE(max(sequence),0) INTO before_seq FROM public.game_management_events;
    IF op='noop' THEN EXECUTE format('UPDATE r46_emitter_probe.%I SET updated_at=updated_at',kind);
    ELSE EXECUTE format('UPDATE r46_emitter_probe.%I SET updated_at=clock_timestamp()',kind);END IF;
    IF EXISTS(SELECT 1 FROM public.game_management_events WHERE sequence>before_seq) THEN
     RAISE EXCEPTION 'quiet event changed %.%',kind,op;END IF;
    quiet:=quiet+1;
    RAISE EXCEPTION 'rollback isolated event case' USING ERRCODE='ZX001';
   EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
  END LOOP;
  FOREACH op IN ARRAY ARRAY['insert','delete'] LOOP
   BEGIN
    SELECT COALESCE(max(sequence),0) INTO before_seq FROM public.game_management_events;
    IF op='insert' THEN EXECUTE format('INSERT INTO r46_emitter_probe.%I SELECT * FROM r46_emitter_probe.%I',kind,kind);
    ELSE EXECUTE format('DELETE FROM r46_emitter_probe.%I',kind);END IF;
    SELECT count(*) INTO actual FROM public.game_management_events WHERE sequence>before_seq;
    IF actual<>1 THEN RAISE EXCEPTION 'operation event count %.%: %',kind,op,actual;END IF;
    SELECT * INTO STRICT event_row FROM public.game_management_events WHERE sequence>before_seq;
    IF event_row.event_type<>'game_changed' OR event_row.entity_id IS DISTINCT FROM row_id
       OR event_row.entity_type IS DISTINCT FROM (CASE kind WHEN 'tables' THEN 'table' ELSE 'tournament' END)
       OR event_row.club_id IS DISTINCT FROM club_id OR event_row.scope_id IS DISTINCT FROM club_id
       OR event_row.payload IS DISTINCT FROM jsonb_build_object('operation',op) THEN
     RAISE EXCEPTION 'operation event payload changed %.%',kind,op;END IF;
    insert_delete:=insert_delete+1;
    RAISE EXCEPTION 'rollback isolated event case' USING ERRCODE='ZX001';
   EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
  END LOOP;
 END LOOP;
 -- All three operation branches suppress a physical tournament backing table.
 FOREACH op IN ARRAY ARRAY['insert','update','delete'] LOOP
  BEGIN
   UPDATE r46_emitter_probe.tables SET tournament_id='46463000-0000-4000-8000-000000000010';
   SELECT COALESCE(max(sequence),0) INTO before_seq FROM public.game_management_events;
   IF op='insert' THEN INSERT INTO r46_emitter_probe.tables SELECT * FROM r46_emitter_probe.tables;
   ELSIF op='update' THEN UPDATE r46_emitter_probe.tables SET name='backing table proof';
   ELSE DELETE FROM r46_emitter_probe.tables;END IF;
   IF EXISTS(SELECT 1 FROM public.game_management_events WHERE sequence>before_seq) THEN
    RAISE EXCEPTION 'backing table operation unexpectedly emitted: %',op;END IF;
   suppressed:=suppressed+1;
   RAISE EXCEPTION 'rollback isolated event case' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 END LOOP;
 RETURN jsonb_build_object('watched_fields',checked,'quiet_cases',quiet,
  'insert_delete',insert_delete,'backing_suppressed',suppressed);
END $proof$;
CREATE TEMP TABLE row_emitter_before AS SELECT pg_temp.check_row_emitter() result;

-- Explicit malformed historical inputs: no production authority is replaced.
-- Missing capture, numeric-two MTT, conflict between old/current shape, and
-- terminal parents must remain unresolved instead of gaining an exemption.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,game_type,buy_in_amount,buy_in_fee,max_players,min_players,table_size,status,created_at,start_time)
SELECT ('46463000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '46463000-0000-4000-8000-000000000002','Unproven historical '||n,'MTT','freezeout','NLH',19,1,
 CASE WHEN n=21 THEN 2 ELSE 100 END,2,9,CASE WHEN n=23 THEN 'COMPLETED' ELSE 'REGISTERING' END,now(),now()+interval '1 hour'
FROM generate_series(20,24)n;
INSERT INTO public.managed_game_contract_versions(game_kind,game_id,club_id,version,contract,contract_hash,published_at,change_reason)
SELECT 'tournament',t.id,t.club_id,1,d.doc,public.fn_managed_game_contract_hash(d.doc),t.created_at,'created'
FROM public.tournaments t CROSS JOIN LATERAL
 (SELECT public.fn_managed_game_contract_document('tournament',to_jsonb(t)) doc)d
WHERE t.id IN ('46463000-0000-4000-8000-000000000021','46463000-0000-4000-8000-000000000022','46463000-0000-4000-8000-000000000023','46463000-0000-4000-8000-000000000024');
INSERT INTO public.managed_game_contract_versions(game_kind,game_id,club_id,version,contract,contract_hash,published_at,change_reason)
SELECT 'tournament',t.id,t.club_id,2,d.doc,public.fn_managed_game_contract_hash(d.doc),t.created_at,'system_revision'
FROM public.tournaments t CROSS JOIN LATERAL
 (SELECT public.fn_managed_game_contract_document('tournament',to_jsonb(t))||'{"max_players":99}'::jsonb doc)d
WHERE t.id='46463000-0000-4000-8000-000000000022';
SET LOCAL session_replication_role=origin;
-- Negative control: a fixture-only normalizer would mutate business metadata.
-- Real financial/creation/terminal triggers remain present and enabled.
CREATE FUNCTION public.r46_format_probe_normalizer() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.id='46463000-0000-4000-8000-000000000024' AND to_jsonb(NEW)->>'format_contract' IS NOT NULL THEN
  NEW.short_description:='unexpected normalizer write';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER r46_format_probe_normalizer BEFORE UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.r46_format_probe_normalizer();
CREATE TEMP TABLE format_before AS SELECT id,to_jsonb(t) document FROM public.tournaments t;
CREATE TEMP TABLE format_tables_before AS SELECT id,to_jsonb(t) document FROM public.tables t;
CREATE TEMP TABLE format_receipts_before AS SELECT tournament_id,to_jsonb(r) document FROM public.tournament_launch_receipts r;
CREATE TEMP TABLE format_contracts_before AS SELECT id,to_jsonb(v) document FROM public.managed_game_contract_versions v;
CREATE TEMP TABLE format_business_before AS SELECT jsonb_build_object(
 'players',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM public.tournament_players w),
 'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.wallets w),
 'ledger',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.chip_ledger w),
 'payouts',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.tournament_payouts w),
 'management_events',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.sequence) FROM public.game_management_events w)
) document;
CREATE TEMP TABLE format_migration_clock AS SELECT clock_timestamp() started_at;
COMMIT;
\ir ../../../supabase/migrations/20260917060000_mtt_persisted_format_preparation.sql
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.tournaments WHERE format_contract IS NOT NULL),
 'short schema preparation never updates historical parents');
DO $legacy_continuation$
BEGIN
 BEGIN
  UPDATE public.tournaments SET current_level=1
   WHERE id='46463000-0000-4000-8000-000000000010';
  RAISE EXCEPTION 'rollback continuation proof' USING ERRCODE='P0499';
 EXCEPTION WHEN SQLSTATE 'P0499' THEN NULL; END;
 PERFORM pg_temp.assert_true((SELECT format_contract IS NULL FROM public.tournaments
   WHERE id='46463000-0000-4000-8000-000000000010'),'old engine ordinary writes tolerate unqualified history');
END $legacy_continuation$;
-- QUALIFY_FIRST_FORMAT
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.tournaments WHERE format_contract IS NOT NULL),
 'first finite metadata transaction commits independently');
-- REPLAY_FIRST_FORMAT
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.tournaments WHERE format_contract IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM format_before b JOIN public.tournaments t USING(id)
   WHERE b.document IS DISTINCT FROM to_jsonb(t)-'format_contract'),
 'explicit replay preserves metadata and every business field');
DO $interrupted$
BEGIN
 BEGIN
  UPDATE public.tournaments SET format_contract='sng-v1'
   WHERE id='46463000-0000-4000-8000-000000000012';
  RAISE EXCEPTION 'interrupt metadata transaction' USING ERRCODE='P0499';
 EXCEPTION WHEN SQLSTATE 'P0499' THEN NULL; END;
 PERFORM pg_temp.assert_true((SELECT format_contract IS NULL FROM public.tournaments
   WHERE id='46463000-0000-4000-8000-000000000012'),'interrupted metadata assignment rolls back without undoing completed batch');
END $interrupted$;
-- QUALIFY_REMAINING_FORMATS
SELECT jsonb_build_object('measurement','format_preparation_1118_parents',
 'elapsed_ms',extract(epoch FROM clock_timestamp()-started_at)*1000)
FROM format_migration_clock;
BEGIN;
SET LOCAL statement_timeout='30s';
SELECT pg_temp.assert_true(current_setting('session_replication_role')='origin'
 AND current_user='postgres' AND COALESCE(auth.role(),'')=''
 AND pg_temp.check_lifecycle_guard()=(SELECT result FROM lifecycle_before)
 AND (SELECT result->>'protected_keys'='65' FROM lifecycle_before)
 AND pg_temp.check_row_emitter()=(SELECT result FROM row_emitter_before)
 AND (SELECT result='{"watched_fields":27,"quiet_cases":8,"insert_delete":4,"backing_suppressed":3}'::jsonb FROM row_emitter_before),
 'ordinary postgres origin apply preserves protected fields, lifecycle refusals and exact durable row events');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM format_before b FULL JOIN public.tournaments t USING(id)
 WHERE b.document IS DISTINCT FROM to_jsonb(t)-'format_contract'),'all existing tournament fields unchanged');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM format_tables_before b FULL JOIN public.tables t USING(id)
 WHERE b.document IS DISTINCT FROM to_jsonb(t)),'physical tables unchanged');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM format_contracts_before b FULL JOIN public.managed_game_contract_versions v USING(id)
 WHERE b.document IS DISTINCT FROM to_jsonb(v)),'immutable creation history unchanged');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM format_receipts_before b FULL JOIN public.tournament_launch_receipts r USING(tournament_id)
 WHERE b.document IS DISTINCT FROM to_jsonb(r)),'launch receipts unchanged');
SELECT pg_temp.assert_true((SELECT document FROM format_business_before)=jsonb_build_object(
 'players',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM public.tournament_players w),
 'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.wallets w),
 'ledger',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.chip_ledger w),
 'payouts',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.tournament_payouts w),
 'management_events',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.sequence) FROM public.game_management_events w)),'no roster wallet ledger payout or management-event effect');
SELECT pg_temp.assert_true(public.fn_ca_tournament_recorded_format('46463000-0000-4000-8000-000000000010')='mtt-v1'
 AND (SELECT count(*)=1118 FROM public.tournaments WHERE format_contract IS NOT NULL)
 AND (SELECT count(*)=1118 FROM public.tournament_players)
 AND (SELECT min(octet_length(blind_structure))>5000 AND min(octet_length(description))>3000 FROM public.tournaments
      WHERE id BETWEEN '46463100-0000-4000-8000-000000000001' AND '46463100-0000-4000-8000-000000001114')
 AND (SELECT count(*)=1114 AND bool_and(t.format_contract='mtt-v1'
      AND v.change_reason='created' AND v.published_at=t.created_at
      AND v.contract_hash=public.fn_managed_game_contract_hash(v.contract)
      AND public.fn_ca_tournament_format_identity(v.contract)=public.fn_ca_tournament_format_identity(to_jsonb(t)))
   FROM public.tournaments t JOIN public.managed_game_contract_versions v
     ON v.game_kind='tournament' AND v.game_id=t.id AND v.version=1
   WHERE t.id BETWEEN '46463100-0000-4000-8000-000000000001' AND '46463100-0000-4000-8000-000000001114'),
 'proven MTT recorded with 1118 exact origin-created parents');
SELECT pg_temp.assert_true(public.fn_ca_tournament_recorded_format('46463000-0000-4000-8000-000000000011')='seat-first-satellite-v1','proven HU satellite recorded');
SELECT pg_temp.assert_true(public.fn_ca_tournament_recorded_format('46463000-0000-4000-8000-000000000012')='sng-v1','proven SNG recorded');
SELECT pg_temp.assert_true(public.fn_ca_tournament_recorded_format('46463000-0000-4000-8000-000000000013')='spin-v1','proven Spin recorded');
SELECT pg_temp.assert_true((SELECT bool_and(format_contract IS NULL) FROM public.tournaments WHERE id IN
 ('46463000-0000-4000-8000-000000000020','46463000-0000-4000-8000-000000000021',
  '46463000-0000-4000-8000-000000000022','46463000-0000-4000-8000-000000000023',
  '46463000-0000-4000-8000-000000000024')),
 'missing capture numeric-two conflict terminal and side-effecting metadata remain unqualified');
SELECT pg_temp.assert_true(public.fn_ca_lock_mtt_admission_contract()='legacy-capacity-v1','legacy ABI retained');

DO $negative$
DECLARE refused boolean; statement text;
BEGIN
 FOREACH statement IN ARRAY ARRAY[
  $s$UPDATE public.tournaments SET format_contract='mtt-v2' WHERE id='46463000-0000-4000-8000-000000000011'$s$,
  $s$UPDATE public.tournaments SET format_contract=NULL WHERE id='46463000-0000-4000-8000-000000000011'$s$,
  $s$UPDATE public.tournaments SET format_contract='mtt-v1' WHERE id='46463000-0000-4000-8000-000000000020'$s$,
  $s$UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2'$s$,
  $s$DELETE FROM public.ca_mtt_admission_contract$s$,
  $s$TRUNCATE public.ca_mtt_admission_contract$s$
 ] LOOP
  refused:=false;
  BEGIN EXECUTE statement; EXCEPTION WHEN object_not_in_prerequisite_state THEN refused:=true; END;
  PERFORM pg_temp.assert_true(refused,'immutable authority refuses: '||statement);
 END LOOP;
 refused:=false;
 BEGIN PERFORM public.fn_ca_tournament_recorded_format('46463000-0000-4000-8000-000000000020');
 EXCEPTION WHEN object_not_in_prerequisite_state THEN refused:=true; END;
 PERFORM pg_temp.assert_true(refused,'unproven reader fails closed');
END $negative$;
DO $roles$
DECLARE who text;
BEGIN
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  PERFORM pg_temp.assert_true(NOT has_table_privilege(who,'public.ca_mtt_admission_contract','INSERT,UPDATE,DELETE,TRUNCATE'),
   who||' has no ABI write grant');
  PERFORM pg_temp.assert_true(NOT has_function_privilege(who,'public.fn_ca_lock_mtt_admission_contract()','EXECUTE'),
   who||' cannot directly lock private ABI');
 END LOOP;
END $roles$;
-- A real post-preparation creator still creates the same HU shape and fee.
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.fn_create_seat_first_game_atomic('46463000-0000-4000-8000-000000000030',
 config||'{"name":"New legacy HU","tournament_type":"SATELLITE","satellite_target_id":"46463000-0000-4000-8000-000000000010","satellite_seats":1}'::jsonb)
FROM format_fixture_config;
SELECT pg_temp.assert_true((SELECT format_contract='seat-first-satellite-v1' AND max_players=2 AND min_players=2
 AND table_size=2 AND buy_in_amount=19 AND buy_in_fee=1 FROM public.tournaments
 WHERE id='46463000-0000-4000-8000-000000000030'),'legacy creator assigns format without changing contracted shape');

DO $new_input$
DECLARE refused boolean;
BEGIN
 refused:=false;
 BEGIN
  INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,game_type,max_players,min_players,table_size,
    buy_in_amount,buy_in_fee,starting_chips,status,start_time,blind_structure,payout_structure,format_contract)
  SELECT '46463000-0000-4000-8000-000000000031',club_id,'Spoofed marker',tournament_type,variant,game_type,
   max_players,min_players,table_size,buy_in_amount,buy_in_fee,starting_chips,status,start_time,blind_structure,payout_structure,'mtt-v2'
  FROM public.tournaments WHERE id='46463000-0000-4000-8000-000000000012';
 EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM<>'TOURNAMENT_FORMAT_IS_DATABASE_ASSIGNED' THEN RAISE; END IF;
  refused:=true;
 END;
 PERFORM pg_temp.assert_true(refused,'caller cannot select marker');
 refused:=false;
 BEGIN
  UPDATE public.tournaments SET max_players=NULL WHERE id='46463000-0000-4000-8000-000000000010';
 EXCEPTION WHEN check_violation OR object_not_in_prerequisite_state THEN refused:=true;
 END;
 PERFORM pg_temp.assert_true(refused,'preparation does not admit NULL capacity');
END $new_input$;
SELECT pg_temp.assert_true((SELECT count(*)=1 AND min(abi)='legacy-capacity-v1' FROM public.ca_mtt_admission_contract),
 'no activation or duplicate singleton');
ROLLBACK;
SELECT 'MTT_FORMAT_PREPARATION_NATIVE_PASS';
