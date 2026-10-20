"""Original cash clock in the real disposable PostgreSQL Lightning settlement chain.

The existing Phase 6 harness owns the database and the physical money writers.
No production connection, synthetic production hand, reset or backdated credit.
"""
import os
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
CANDIDATE = M / '20261020171735_lightning_settlement_evaluates_the_original_cash_stay_clock.sql'


def definition(file, name, delimiter):
    source = (M / file).read_text()
    pattern = rf'CREATE OR REPLACE FUNCTION public\.{name}\(.*?AS {re.escape(delimiter)}.*?{re.escape(delimiter)};'
    match = re.search(pattern, source, re.S)
    assert match, name
    return match.group()


owners = '\n'.join([
    definition('20260828090000_the_engine_is_a_role_not_the_absence_of_a_user.sql', 'fn_caller_is_engine', '$function$'),
    definition('20260904140000_chip_continuity_slice_0_hardening.sql', 'fn_cash_stay_remaining_ms', '$$'),
    definition('20260904140000_chip_continuity_slice_0_hardening.sql', 'fn_cash_session_evaluate', '$$'),
])
candidate = CANDIDATE.read_text()
pre_block = re.search(r'DO \$pre\$.*?END \$pre\$;', candidate, re.S).group()
live_proofs = '\n'.join(
    'DO $proof$ BEGIN IF (' + line.removeprefix('-- @live-proof: ') +
    ") IS NOT TRUE THEN RAISE EXCEPTION 'cash clock live proof failed'; END IF; END $proof$;"
    for line in candidate.splitlines() if line.startswith('-- @live-proof: ')
)
setup = r"""
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
 AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql
 AS $$SELECT coalesce(nullif(current_setting('harness.clock_frozen',true),''),'false')::boolean$$;
CREATE TABLE IF NOT EXISTS public.seat_departure_requests(
 occupancy_id uuid PRIMARY KEY,user_id uuid,table_id uuid,seat_number integer,leave_mode text);
""" + owners + r"""
ALTER FUNCTION public.fn_cash_session_evaluate(uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cash_session_evaluate(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_session_evaluate(uuid,jsonb) TO service_role;
DO $$BEGIN
 IF md5(pg_get_functiondef('public.fn_cash_session_evaluate(uuid,jsonb)'::regprocedure))<>'63c48e5d33b963562295d32e6fbee380'
 THEN RAISE EXCEPTION 'cash evaluator differs from production'; END IF;
END $$;
CREATE TABLE harness.cash_clock_case(game uuid,hand_id uuid,request_id uuid,results jsonb,ids uuid[]);
CREATE FUNCTION harness.clock_hand(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g uuid; ids uuid[]; f jsonb; h uuid; spec jsonb;
BEGIN
 g:=harness.cluster(label);
 UPDATE public.tables SET is_private=true,union_id=NULL WHERE cluster_id=g;
 -- The real estate is table-scoped. The older synthetic formation fixture
 -- uses cluster scope; qualify the actual installed shape, not that shortcut.
 UPDATE public.cash_player_session SET scope_type='table',scope_id=table_id,
  stay_remaining_ms=600000,stay_running=false,stay_last_tick_at='2000-01-01Z'
 WHERE cluster_id=g;
 UPDATE public.table_seats ts SET occupancy_id=coalesce(occupancy_id,gen_random_uuid())
 FROM public.tables t WHERE t.id=ts.table_id AND t.cluster_id=g;
 SELECT array_agg(player_id ORDER BY table_id) INTO ids FROM (
  SELECT DISTINCT ON(ts.table_id) ps.player_id,ts.table_id
  FROM lightning_pool_session ps JOIN table_seats ts ON ts.id=ps.anchor_seat_id
  WHERE ps.cluster_id=g AND ps.exited_at IS NULL ORDER BY ts.table_id,ps.player_id LIMIT 2) q;
 IF cardinality(ids)<>2 THEN RAISE EXCEPTION 'two physical anchors required'; END IF;
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 spec:=jsonb_build_object(ids[1]::text,jsonb_build_object('d',1,'c',2),
                         ids[2]::text,jsonb_build_object('d',-1,'c',2));
 INSERT INTO harness.cash_clock_case VALUES(g,h,gen_random_uuid(),harness.results(h,spec),ids);
END $$;
SELECT harness.clock_hand('clock before');
DO $$DECLARE c record;r jsonb;BEGIN
 SELECT * INTO STRICT c FROM harness.cash_clock_case;
 r:=harness.settle(c.hand_id,c.request_id,c.results,0,0,'{}');
 IF r->>'ok'<>'true' THEN RAISE EXCEPTION 'before settlement refused: %',r; END IF;
 IF NOT EXISTS(SELECT FROM cash_player_session cs JOIN table_seats ts ON ts.table_id=cs.table_id AND ts.user_id=cs.player_id
  WHERE cs.cluster_id=c.game AND cs.player_id=c.ids[1] AND ts.stack>cs.baseline
   AND NOT cs.stay_running AND cs.stay_remaining_ms=600000 AND cs.stay_last_tick_at='2000-01-01Z')
 THEN RAISE EXCEPTION 'before defect not reproduced'; END IF;
END $$;
\echo 'PASS: before real Lightning settlement leaves a profitable original cash clock untouched'
""" + f'\n\\i {CANDIDATE}\n' + r"""
TRUNCATE harness.cash_clock_case;
SELECT harness.clock_hand('clock after');
DO $$DECLARE c record;r jsonb;again jsonb;tick timestamptz;original_baseline numeric;sid uuid;BEGIN
 SELECT * INTO STRICT c FROM harness.cash_clock_case;
 SELECT baseline,id INTO original_baseline,sid FROM cash_player_session WHERE cluster_id=c.game AND player_id=c.ids[1];
 BEGIN
  PERFORM set_config('harness.clock_frozen','true',true);
  r:=harness.settle(c.hand_id,c.request_id,c.results,0,0,'{}');
  RAISE EXCEPTION 'frozen platform accepted clock transition';
 EXCEPTION WHEN SQLSTATE '55006' THEN
  IF SQLERRM<>'PLATFORM_FROZEN' THEN RAISE; END IF;
 END;
 -- Corrupt only a disposable fixture's session binding. A clock failure must
 -- roll back the original physical settlement, not leave a paid hand pending.
 BEGIN
  UPDATE cash_player_session SET scope_type='cluster',scope_id=c.game WHERE id=sid;
  r:=harness.settle(c.hand_id,c.request_id,c.results,0,0,'{}');
  RAISE EXCEPTION 'wrong cash scope accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'lightning_cash_clock_anchor_unavailable' THEN RAISE; END IF;
 END;
 IF EXISTS(SELECT FROM lightning_hand WHERE hand_id=c.hand_id AND settled_at IS NOT NULL)
  OR EXISTS(SELECT FROM lightning_hand_player WHERE hand_id=c.hand_id AND stack_after IS NOT NULL)
 THEN RAISE EXCEPTION 'clock refusal left a partial settlement'; END IF;
 r:=harness.settle(c.hand_id,c.request_id,c.results,0,0,'{}');
 IF r->>'ok'<>'true' THEN RAISE EXCEPTION 'after settlement refused: %',r; END IF;
 IF NOT EXISTS(SELECT FROM cash_player_session cs WHERE cs.id=sid AND cs.baseline=original_baseline
  AND cs.stay_running AND cs.stay_remaining_ms=600000 AND cs.stay_last_tick_at>='2026-01-01Z')
 THEN RAISE EXCEPTION 'winner clock was reset, replaced or not started'; END IF;
 IF EXISTS(SELECT FROM cash_player_session WHERE cluster_id=c.game AND player_id=c.ids[2] AND stay_running)
 THEN RAISE EXCEPTION 'losing player clock started'; END IF;
 SELECT stay_last_tick_at INTO tick FROM cash_player_session WHERE id=sid;
 again:=harness.settle(c.hand_id,c.request_id,c.results,0,0,'{}');
 IF again->>'replay'<>'true' OR (SELECT stay_last_tick_at FROM cash_player_session WHERE id=sid)<>tick
 THEN RAISE EXCEPTION 'duplicate settlement evaluated the clock twice'; END IF;
 IF has_function_privilege('anon','public.fn_lightning_cash_clock_at_settlement()','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_lightning_cash_clock_at_settlement()','EXECUTE')
  OR has_function_privilege('service_role','public.fn_lightning_cash_clock_at_settlement()','EXECUTE')
 THEN RAISE EXCEPTION 'private trigger became an RPC'; END IF;
END $$;
\echo 'PASS: exact native front/feeder anchors use original cash clocks; profit starts, loss pauses, replay preserves tick and private ACL'
TRUNCATE harness.cash_clock_case;
SELECT harness.clock_hand('clock voluntary departure');
DO $$DECLARE c record;r jsonb;sid uuid;BEGIN
 SELECT * INTO STRICT c FROM harness.cash_clock_case;
 SELECT cash_player_session_id INTO sid FROM lightning_pool_session WHERE cluster_id=c.game AND player_id=c.ids[1] AND exited_at IS NULL;
 UPDATE cash_player_session SET stay_running=true,stay_remaining_ms=123456,
  stay_last_tick_at=clock_timestamp()-interval '2 seconds' WHERE id=sid;
 INSERT INTO seat_departure_requests(occupancy_id,user_id,table_id,seat_number,leave_mode)
 SELECT ts.occupancy_id,ts.user_id,ts.table_id,ts.seat_number,'voluntary'
 FROM table_seats ts JOIN lightning_pool_session ps ON ps.anchor_seat_id=ts.id
 WHERE ps.cash_player_session_id=sid;
 UPDATE table_seats ts SET is_sitting_out=true,leave_pending=true
 FROM lightning_pool_session ps WHERE ps.anchor_seat_id=ts.id AND ps.cash_player_session_id=sid;
 r:=harness.settle(c.hand_id,c.request_id,c.results,0,0,'{}');
 IF r->>'ok'<>'true' OR NOT EXISTS(SELECT FROM cash_player_session WHERE id=sid
  AND stay_running AND stay_remaining_ms>0 AND stay_remaining_ms<123456)
 THEN RAISE EXCEPTION 'voluntary held leave stopped or reset its original clock: %',r; END IF;
END $$;
\echo 'PASS: voluntary pending departure serves its retained remainder; no baseline or timer reset'
DO $$DECLARE c record;f jsonb;h uuid;r jsonb;spec jsonb;sid uuid;BEGIN
 SELECT * INTO STRICT c FROM harness.cash_clock_case;
 SELECT cash_player_session_id INTO sid FROM lightning_pool_session WHERE cluster_id=c.game AND player_id=c.ids[1] AND exited_at IS NULL;
 -- A retained original request is not authority after the pending leave was
 -- cancelled. A subsequent genuine sit-out must pause the same clock.
 UPDATE table_seats ts SET is_sitting_out=false,leave_pending=false
 FROM lightning_pool_session ps WHERE ps.anchor_seat_id=ts.id AND ps.cash_player_session_id=sid;
 f:=harness.form(c.game,c.ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 UPDATE table_seats ts SET is_sitting_out=true
 FROM lightning_pool_session ps WHERE ps.anchor_seat_id=ts.id AND ps.cash_player_session_id=sid;
 spec:=jsonb_build_object(c.ids[1]::text,jsonb_build_object('d',1,'c',2),c.ids[2]::text,jsonb_build_object('d',-1,'c',2));
 r:=harness.settle(h,gen_random_uuid(),harness.results(h,spec),0,0,'{}');
 IF r->>'ok'<>'true' OR EXISTS(SELECT FROM cash_player_session WHERE id=sid AND stay_running)
 THEN RAISE EXCEPTION 'cancelled leave overrode a genuine sit-out: %',r; END IF;
END $$;
\echo 'PASS: cancelled voluntary request cannot keep a genuine sit-out clock running'
SELECT 'cash_clock_trigger_definition_md5='||md5(pg_get_functiondef('public.fn_lightning_cash_clock_at_settlement()'::regprocedure));
""" + live_proofs + f"""
DO $reapply$ BEGIN
 BEGIN
  EXECUTE $candidate${pre_block}$candidate$;
  RAISE EXCEPTION 'cash clock migration replay accepted';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'lightning_cash_clock_already_installed' THEN RAISE; END IF;
 END;
END $reapply$;
\\echo 'PASS: exact installed live proofs and migration replay refusal'
"""

socket = os.environ.get('LIGHTNING_ZERO_PAYER_SOCKET')
if not socket:
    raise SystemExit('Run through scripts/dev/test-lightning-phase6-settlement.sh')
with tempfile.TemporaryDirectory(prefix='lightning-clock-') as work:
    path = pathlib.Path(work) / 'clock.sql'
    path.write_text(setup)
    pg = pathlib.Path(os.environ['PG_BIN'])
    result = subprocess.run([str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                             '-h', socket, '-p', os.environ['LIGHTNING_ZERO_PAYER_PORT'],
                             '-d', 'postgres', '-f', str(path)], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    print(result.stdout)
    raise SystemExit(result.returncode)
