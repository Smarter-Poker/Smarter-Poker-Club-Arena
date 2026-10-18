"""Required native follow-up: a busted pool anchor cannot inflate eligibility.

Runs inside the disposable Phase 6 database after its settlement regression.
Creates no production connection and never changes the threshold constants.
"""
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / 'supabase/migrations/20261018231909_lightning_population_requires_a_funded_live_anchor.sql'
SCALAR = 'public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'
REPORT = 'public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'
socket = os.environ['LIGHTNING_ZERO_PAYER_SOCKET']
port = os.environ['LIGHTNING_ZERO_PAYER_PORT']
pg = pathlib.Path(os.environ['PG_BIN'])
sql = f"""
SET SESSION AUTHORIZATION postgres;
ALTER FUNCTION {SCALAR} OWNER TO postgres;
ALTER FUNCTION {REPORT} OWNER TO postgres;
CREATE TABLE harness.funded_population_case(game uuid);
DO $baseline$
DECLARE g uuid; f jsonb; h uuid; ids uuid[]; spec jsonb:='{{}}';r jsonb;hp record; total numeric;
BEGIN
 IF md5(pg_get_functiondef('{SCALAR}'::regprocedure))<>'40758904adab24fc2d37c6885d0b1cb6' OR md5(pg_get_functiondef('{REPORT}'::regprocedure))<>'42d6a3fde2a0a075acdc1c557b433aa4' THEN RAISE EXCEPTION 'wrong funded population preimages'; END IF;
 g:=harness.cluster('funded population native');
 INSERT INTO harness.funded_population_case VALUES(g);
 ids:=(harness.at(g,true,true))[1:3]||(harness.at(g,true,false))[1:3];
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 SELECT sum(stack_before) INTO total FROM lightning_hand_player WHERE hand_id=h;
 FOR hp IN SELECT * FROM lightning_hand_player WHERE hand_id=h LOOP
   spec:=spec||jsonb_build_object(hp.player_id::text,jsonb_build_object('d',CASE WHEN hp.player_id=ids[6] THEN total-hp.stack_before ELSE -hp.stack_before END,'c',hp.stack_before));
 END LOOP;
 r:=harness.settle(h,gen_random_uuid(),harness.results(h,spec),0,0,jsonb_build_object('pot_size',total));
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'all-in fixture did not settle: %',r; END IF;
 IF (SELECT count(*) FROM lightning_pool_session s JOIN table_seats t ON t.id=s.anchor_seat_id WHERE s.cluster_id=g AND s.exited_at IS NULL AND t.stack=0)<>5 OR public.fn_cash_cluster_live_eligible(g)<>18 THEN RAISE EXCEPTION 'baseline did not reproduce busted-pool inflation'; END IF;
 SELECT array_agg(player_id) INTO ids FROM (SELECT s.player_id FROM lightning_pool_session s JOIN table_seats t ON t.id=s.anchor_seat_id WHERE s.cluster_id=g AND s.exited_at IS NULL AND t.stack>0 ORDER BY s.player_id LIMIT 2) q;
 f:=harness.form(g,ids);
 PERFORM public.fn_lightning_instance_abandon((f->>'instance_id')::uuid,'qualification_void');
 IF (public.fn_cash_cluster_population(g)->'counted'->>'lightning_in_hand')::integer<>2 THEN RAISE EXCEPTION 'baseline did not reproduce abandoned in-hand inflation'; END IF;
END $baseline$;
\\echo 'PASS: native baseline counts five busted pool players and an abandoned hand incorrectly'
\\i {CANDIDATE}
DO $after$
DECLARE g uuid; p jsonb; st jsonb; f jsonb; h uuid; ids uuid[]; spec jsonb:='{{}}';hp record; total numeric;
BEGIN
 SELECT game INTO STRICT g FROM harness.funded_population_case;
 p:=public.fn_cash_cluster_population(g);
 IF public.fn_cash_cluster_live_eligible(g)<>13 OR (p->>'live_eligible')::integer<>13 OR (p->'counted'->>'lightning_eligible')::integer<>13 OR (p->'counted'->>'lightning_idle')::integer<>13 OR (p->'counted'->>'seated_and_pooled')::integer<>13 OR (p->'counted'->>'lightning_in_hand')::integer<>0 OR (p->'counted'->>'seated_total')::integer<>18 OR (p->'excluded'->>'busted')::integer<>5 THEN RAISE EXCEPTION 'funded population/report mismatch: %',p; END IF;
 p:=public.fn_cash_cluster_population(g,clock_timestamp(),3);
 IF (p->>'live_eligible')::integer<>10 OR (p->'counted'->>'disconnected')::integer<>3 THEN RAISE EXCEPTION 'disconnect subtraction changed: %',p; END IF;
 st:=public.fn_cash_cluster_lightning_state(g);
 IF (st->'thresholds'->>'on')::integer<>18 OR (st->'thresholds'->>'off')::integer<>12 OR (st->'verdict'->>'would_turn_off')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'thresholds or hysteresis changed: %',st; END IF;
 SELECT array_agg(player_id) INTO ids FROM (SELECT s.player_id FROM lightning_pool_session s JOIN table_seats t ON t.id=s.anchor_seat_id WHERE s.cluster_id=g AND s.exited_at IS NULL AND t.stack>0 ORDER BY s.player_id LIMIT 3) q;
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 IF (public.fn_cash_cluster_population(g)->'counted'->>'lightning_in_hand')::integer<>3 THEN RAISE EXCEPTION 'a real live hand disappeared from population'; END IF;
 SELECT sum(stack_before) INTO total FROM lightning_hand_player WHERE hand_id=h;
 FOR hp IN SELECT * FROM lightning_hand_player WHERE hand_id=h LOOP
   spec:=spec||jsonb_build_object(hp.player_id::text,jsonb_build_object('d',CASE WHEN hp.player_id=ids[3] THEN total-hp.stack_before ELSE -hp.stack_before END,'c',hp.stack_before));
 END LOOP;
 p:=harness.settle(h,gen_random_uuid(),harness.results(h,spec),0,0,jsonb_build_object('pot_size',total));
 IF p->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'second all-in did not settle: %',p; END IF;
 st:=public.fn_cash_cluster_lightning_state(g);
 IF public.fn_cash_cluster_live_eligible(g)<>11 OR (st->'verdict'->>'would_turn_off')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'correct funded population did not reach normal OFF threshold: %',st; END IF;
 IF md5(pg_get_functiondef('{SCALAR}'::regprocedure))<>'fd042fee12ec1e87f8380de382d5203d' OR md5(pg_get_functiondef('{REPORT}'::regprocedure))<>'72b9f512aff4bb327d29ece2fd57dcf9' THEN RAISE EXCEPTION 'wrong funded population postimages'; END IF;
END $after$;
\\echo 'PASS: funded anchors, unchanged board count, no abandoned hand, actual live hand, disconnect arithmetic and 18/12 hysteresis'
"""
with tempfile.TemporaryDirectory(prefix='lp-funded-') as work:
    fixture = pathlib.Path(work) / 'funded.sql'
    fixture.write_text(sql)
    result = subprocess.run([str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                             '-h', socket, '-p', port, '-d', 'postgres', '-f', str(fixture)],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    print(result.stdout)
    if result.returncode or 'PASS: funded anchors' not in result.stdout:
        raise SystemExit(result.returncode or 1)
