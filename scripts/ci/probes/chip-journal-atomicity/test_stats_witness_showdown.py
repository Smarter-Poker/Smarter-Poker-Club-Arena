"""Compare the narrowed audit with the actual pre-change production SQL reader."""
from pathlib import Path
import json
import uuid


def verify_stats_witness_showdown(run):
 root = Path(__file__).resolve().parents[4]
 migration = (root/'supabase/migrations/20260908204006_stats_witness_checks_showdown_without_money_reconstruction.sql').read_text()
 reference = (root/'scripts/ci/probes/stats-witness-showdown/baseline-facts-range.sql').read_text()
 section = migration.split('  -- 2b.')[1].split('  -- 2c.')[0]
 ctes = section[section.index('  WITH h AS MATERIALIZED'):section.index('  SELECT count(*)::int INTO v_showdown_disagree')]
 ctes = ctes.replace('public.', 'stats_witness_probe.').replace('v_from', "'2026-09-08 12:00:00+00'::timestamptz").replace('v_to', "'2026-09-08 12:10:00+00'::timestamptz")
 users = [str(uuid.UUID(int=0xabcdef00+i)) for i in range(6)]
 seats = [{'userId': u, 'seat': i+1} for i,u in enumerate(users)]
 cases = [
  ('heads up, no folds', seats[:2], []),
  ('heads up fold', seats[:2], [{'userId':users[0], 'action':'fold'}]),
  ('multiway one fold', seats, [{'userId':users[0], 'action':'fold'}]),
  ('walk', seats, [{'userId':u, 'action':'fold'} for u in users[1:]]),
  ('duplicate folds', seats, [{'userId':users[0], 'action':'fold'}]*3),
  ('uppercase action', seats, [{'userId':users[0], 'action':'FOLD'}]),
  ('unknown actor', seats, [{'userId':str(uuid.UUID(int=999)), 'action':'fold'}]),
  ('unknown action', seats, [{'userId':users[0], 'action':'folded'}]),
  ('missing actor', seats, [{'action':'fold'}]),
  ('empty seats', [], []),
  ('null player id', seats[:1]+[{'seat':2}], []),
  ('malformed player id counted as non-folder', seats[:1]+[{'seat':2,'userId':'not-a-uuid'}], []),
  ('duplicate identical seat', seats[:2]+seats[:1], []),
  ('one player in two seat rows', seats[:2]+[{'userId':users[0],'seat':3}], []),
  ('null seat', [{'userId':users[0], 'seat':None},seats[1]], []),
  ('uppercase raw id with lowercase fold', [{'userId':users[0].upper(),'seat':1},seats[1]], [{'userId':users[0],'action':'fold'}]),
  ('uppercase action id', seats[:2], [{'userId':users[0].upper(),'action':'fold'}]),
  ('all fold', seats[:2], [{'userId':u,'action':'fold'} for u in users[:2]]),
 ]
 # Varied legal betting histories ensure unused money/position computations do
 # not change the multiset of showdown facts. Same rows feed both real SQLs.
 for mask in range(64):
  acts=[{'userId':u,'action':'fold' if mask & (1<<i) else 'check','stage':'river','amount':0} for i,u in enumerate(users)]
  cases.append((f'fold subset {mask}',seats,acts))
 values=[]
 for i,(label,players,actions) in enumerate(cases):
  p=json.dumps(players);a=json.dumps(actions)
  values.append(f"('{uuid.UUID(int=i+10000)}','2026-09-08 12:05:00+00',$json${p}$json$::jsonb,$json${a}$json$::jsonb)")
 setup="""
BEGIN;
CREATE SCHEMA stats_witness_probe;
CREATE TABLE stats_witness_probe.hand_history (
 id uuid PRIMARY KEY, tournament_id uuid, game_variant text DEFAULT 'nlh',
 big_blind numeric DEFAULT 2, small_blind numeric DEFAULT 1, pot_size numeric DEFAULT 3,
 button_seat integer DEFAULT 1, created_at timestamptz NOT NULL,
 started_at timestamptz DEFAULT '2026-09-08 12:04:00+00',
 ended_at timestamptz DEFAULT '2026-09-08 12:05:00+00',
 players jsonb, actions jsonb, winners jsonb DEFAULT '[]', showdown jsonb DEFAULT '[]'
);
"""
 ref=reference.replace('public.', 'stats_witness_probe.').replace("SET search_path TO 'public'", "SET search_path TO 'stats_witness_probe'")
 old="SELECT hand_id,user_id,showdown FROM stats_witness_probe.ca_hand_player_facts_range('2026-09-08 12:00:00+00','2026-09-08 12:10:00+00',NULL)"
 new=ctes+'SELECT f.hand_id,f.user_id,f.showdown FROM facts f'
 sql=setup+ref.rstrip().rstrip(';')+';\nINSERT INTO stats_witness_probe.hand_history(id,created_at,players,actions) VALUES '+','.join(values)+';\n'
 sql+='CREATE TEMP TABLE old_showdown AS '+old+';\nCREATE TEMP TABLE new_showdown AS '+new+';\n'
 sql+="""
DO $verify$
BEGIN
 IF EXISTS ((TABLE old_showdown EXCEPT ALL TABLE new_showdown)
            UNION ALL (TABLE new_showdown EXCEPT ALL TABLE old_showdown)) THEN
  RAISE EXCEPTION 'Narrow audit changed showdown facts';
 END IF;
 IF (SELECT count(*) FROM new_showdown WHERE hand_id='00000000-0000-0000-0000-000000002710' AND showdown)<>2 THEN
  RAISE EXCEPTION 'Heads-up showdown witness disappeared';
 END IF;
 IF EXISTS (SELECT 1 FROM new_showdown WHERE hand_id='00000000-0000-0000-0000-000000002711' AND showdown) THEN
  RAISE EXCEPTION 'Heads-up fold became a showdown';
 END IF;
END $verify$;
"""
 sql += """
ALTER TABLE stats_witness_probe.hand_history ADD COLUMN has_human boolean DEFAULT false;
CREATE TABLE stats_witness_probe.ca_hand_player_stat(hand_id uuid);
CREATE TABLE stats_witness_probe.ca_hand_player_idx(hand_id uuid,user_id uuid);
CREATE TABLE stats_witness_probe.ca_hand_facts(hand_id uuid,user_id uuid,was_all_in boolean,went_to_showdown boolean,all_in_street text,played_at timestamptz,all_in_equity numeric);
CREATE TABLE stats_witness_probe.profiles(id uuid,is_horse boolean);
CREATE TABLE stats_witness_probe.ca_hand_player_idx_state(id boolean,idx_ceil timestamptz);
CREATE TABLE stats_witness_probe.ca_hand_player_stat_repair_state(id boolean,done boolean);
CREATE TABLE stats_witness_probe.ca_stats_witness_audit_log(
 id bigserial PRIMARY KEY,ran_at timestamptz NOT NULL DEFAULT now(),
 window_from timestamptz NOT NULL,window_to timestamptz NOT NULL,
 hands integer NOT NULL,player_hands integer NOT NULL,hands_with_posts integer NOT NULL,
 button_disagree integer NOT NULL,showdown_disagree integer NOT NULL,
 hands_without_stat integer NOT NULL,human_player_hands integer NOT NULL,
 human_without_facts integer NOT NULL,idx_lag_seconds numeric,repair_done boolean,
 duration_ms integer NOT NULL,player_hands_without_idx integer,
 allin_showdown_7d integer,allin_showdown_without_equity_7d integer);
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
"""
 # Exercise the complete deployable function and grants, not only its CTE.
 function_sql=migration.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]
 function_sql=function_sql.replace('public.', 'stats_witness_probe.').replace('SET search_path = public', 'SET search_path = stats_witness_probe')
 sql+=function_sql
 sql+="""
UPDATE stats_witness_probe.hand_history SET created_at=now()-interval '5 minutes';
DO $audit$ DECLARE result jsonb; BEGIN
 result:=stats_witness_probe.ca_stats_witness_audit(10,90);
 IF (result->>'showdown_disagree')::integer<>(SELECT count(*) FROM new_showdown WHERE showdown) THEN
  RAISE EXCEPTION 'Full audit lost showdown disagreements';
 END IF;
 IF (SELECT count(*) FROM stats_witness_probe.ca_stats_witness_audit_log)<>1 THEN
  RAISE EXCEPTION 'Audit did not persist exactly one result';
 END IF;
 IF has_function_privilege('anon','stats_witness_probe.ca_stats_witness_audit(integer,integer)','EXECUTE')
 OR has_function_privilege('authenticated','stats_witness_probe.ca_stats_witness_audit(integer,integer)','EXECUTE')
 OR NOT has_function_privilege('service_role','stats_witness_probe.ca_stats_witness_audit(integer,integer)','EXECUTE') THEN
  RAISE EXCEPTION 'Audit execution grants changed';
 END IF;
END $audit$;
ROLLBACK;
"""
 run(sql)
 print(f'TOTAL stats showdown: {len(cases)} real SQL equivalence cases; 2 independent showdown checks; complete audit and execution grants',flush=True)

if __name__=='__main__':
 import subprocess
 def run(sql):
  result=subprocess.run(['psql','-X','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True)
  if result.returncode:raise RuntimeError(result.stderr)
  return result.stdout
 verify_stats_witness_showdown(run)
