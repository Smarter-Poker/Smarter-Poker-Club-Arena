"""Committed isolated-clone handoff with separate database sessions at reply loss."""
from pathlib import Path

ROLE="SET request.jwt.claim.role='service_role';SET request.jwt.claims='{\"role\":\"service_role\"}';"
EVENT='b7200000-0000-4000-8000-000000000004'
OLD='b7500000-0000-4000-8000-000000000004'
NEW='b7500000-0000-4000-8000-000000000099'
TRANSFER='b7600000-0000-4000-8000-000000000099'
REQUEST='b7a00000-0000-4000-8000-000000000002'

def qualify(e,db,root):
 case=e.database(db)
 source=(root/'scripts/ci/probes/f06-mixed-custody.sql').read_text()
 marker="SELECT set_config('app.smarter_data_actor','service',true);"
 if source.count(marker)<2:raise ValueError('committed mixed setup anchor changed')
 opening=source.split(marker,1)[0]
 # The owning original cancels a known unactuated synthetic hand while current.
 # The two real interrupted production hands use their separate qualified owner.
 first=opening+f"""
SELECT public.fn_f06_cancel_prepared_hand(tournament_id,generation,table_id,lifecycle,permit_id,hand_number,custody_id)
FROM smarter_private.f06_hand_permits WHERE permit_id='b7800000-0000-4000-8000-000000000005';
SET LOCAL app.smarter_data_actor='service';
UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id='{EVENT}';
DO $$ DECLARE observed jsonb;BEGIN observed:=pg_temp.mixed_prepare();
 PERFORM pg_temp.mixed_prepare(pg_temp.mixed_local(),observed->'canonical'); END $$;
COMMIT;
"""
 e.sql(case,first,label='mixed-committed-prepare-reply-lost')
 second=ROLE+f"""BEGIN;SET LOCAL app.smarter_data_actor='service';
DO $$ DECLARE found jsonb;receipt jsonb; BEGIN
 found:=public.fn_f06_find_mixed_manager_custody('{EVENT}');receipt:=found->'receipt';
 IF receipt->>'transfer_id'<>'{TRANSFER}' OR receipt->>'successor_generation'<>'{NEW}' THEN RAISE EXCEPTION 'restart lost immutable selection';END IF;
 PERFORM public.release_tournament_leases_v2('mixed-custody-original',jsonb_build_array(jsonb_build_object('tournament_id','{EVENT}','lease_generation','{OLD}')));
 IF NOT (SELECT granted FROM public.claim_tournament_lease_v2('{EVENT}','mixed-custody-successor','qualified',(receipt->>'successor_generation')::uuid,30)) THEN RAISE EXCEPTION 'actual successor claim refused'; END IF;
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM set_config('app.smarter_tournament_id','{EVENT}',true);
 PERFORM set_config('app.smarter_tournament_lease_generation','{NEW}',true);
 PERFORM public.fn_f06_admit_mixed_manager_custody('{EVENT}','{NEW}','{TRANSFER}',receipt);
END $$;COMMIT;"""
 e.sql(case,second,label='mixed-committed-successor-claim-reply-lost')
 auth=ROLE+f"BEGIN;SET LOCAL app.smarter_data_actor='tournament-manager';SET LOCAL app.smarter_tournament_id='{EVENT}';SET LOCAL app.smarter_tournament_lease_generation='{NEW}';"
 invoke=f"public.fn_move_tournament_player('{EVENT}','b7100000-0000-4000-8000-000000000009','b7300000-0000-4000-8000-000000000004','b7300000-0000-4000-8000-000000000006',1,'{REQUEST}','live_source')"
 e.sql(case,auth+f"SELECT {invoke};COMMIT;",label='mixed-committed-first-original-rpc-reply-lost')
 _,out,_=e.sql(case,auth+f"""DO $$ DECLARE r jsonb;BEGIN r:={invoke};
 IF r->'replayed' IS DISTINCT FROM 'true'::jsonb OR r->>'request_id' IS DISTINCT FROM '{REQUEST}'
 OR (SELECT count(*) FROM public.tournament_seat_move_receipts WHERE request_id='{REQUEST}')<>1
 OR (SELECT count(*) FROM smarter_private.f06_attempts WHERE request_id='{REQUEST}' AND state='winner')<>1
 OR (SELECT count(*) FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id='{TRANSFER}')<>1
 OR (SELECT count(*) FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id='{TRANSFER}')<>1
 THEN RAISE EXCEPTION 'committed reply replay changed original effect';END IF;
END $$;COMMIT;SELECT 'MIXED_COMMITTED_RESTART_PROVEN';""",label='mixed-committed-original-readback')
 if 'MIXED_COMMITTED_RESTART_PROVEN' not in out:raise RuntimeError('committed mixed restart witness absent')
 e.report['mixed_committed_restart']={'prepare_committed':True,'receipt_only_discovery':True,'actual_successor_claim':True,'admission_committed':True,'first_original_rpc_committed':True,'reply_replayed':True,'request_id':REQUEST,'same_effect':True}
 e.discard(case)

def qualify_locks(e,db,root,binary):
 import re
 source=(root/'scripts/ci/probes/f06-mixed-custody.sql').read_text()
 opening=source.split("SELECT set_config('app.smarter_data_actor','service',true);",1)[0]
 helpers='\n'.join(re.findall(r'CREATE FUNCTION pg_temp\.mixed_(?:local|prepare)\(.*?\$\$;',opening,re.S))
 if helpers.count('CREATE FUNCTION')!=2:raise ValueError('mixed locking input helpers drifted')
 setup=opening+f"SET LOCAL app.smarter_data_actor='service';UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id='{EVENT}';COMMIT;"
 for kind,lane in [('settlement',f"SELECT public.fn_ca_lock_settlement_lane_for_tournament('{EVENT}');"),('table_cap',"SELECT pg_advisory_xact_lock(hashtextextended('table_cap:b7100000-0000-4000-8000-000000000009',0));")]:
  for order in ['capture_first','lane_first']:
   case=e.database(db)
   spec='setup {\n'+setup+'\n}\n'+f'''
session "a"
setup {{ SET application_name='mixed-capture';SET statement_timeout='10s';{ROLE} SET app.smarter_data_actor='service';{helpers} }}
step "a_begin" {{ BEGIN; }}
step "a_capture" {{ SELECT pg_temp.mixed_prepare()->'receipt'; }}
step "a_rollback" {{ ROLLBACK; }}
session "b"
setup {{ SET application_name='mixed-lane';SET statement_timeout='10s'; }}
step "b_begin" {{ BEGIN; }}
step "b_lane" {{ {lane} }}
step "b_rollback" {{ ROLLBACK; }}
session "observer"
step "wait_proven" {{ DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='mixed-lane' AND a.application_name='mixed-capture' AND b.wait_event_type='Lock') THEN RAISE EXCEPTION 'MIXED_WAIT_MISSING';END IF;RAISE NOTICE 'MIXED_LOCK_WAIT_PROVEN';END $$; }}
step "final" {{ DO $$ BEGIN IF EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers) THEN RAISE EXCEPTION 'MIXED_LOCK_EFFECT';END IF;RAISE NOTICE 'MIXED_LOCK_FINAL_PROVEN';END $$; }}
'''
   # Stock isolationtester SQL-block lexer cannot carry literal JSON braces.
   spec=spec.replace("SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';","SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);")
   spec=spec.replace("SET request.jwt.claims='{\"role\":\"service_role\"}';","SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false);")
   spec=spec.replace("'{}'","(chr(123)||chr(125))")
   if order=='capture_first':
    spec+='permutation "a_begin" "a_capture" "b_begin" "b_lane" "wait_proven" "a_rollback" "b_rollback" "final"\n'
   else:
    spec=re.sub(r'step "wait_proven" \{.*?\nstep "final"', 'step "final"',spec,flags=re.S)
    spec+='permutation "b_begin" "b_lane" "a_begin" "a_capture" "a_rollback" "b_rollback" "final"\n'
   rc,out,err=e.run('mixed-lock-'+kind+'-'+order,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=spec,seconds=30,check=False)
   joined=out+err
   if rc or 'MIXED_LOCK_FINAL_PROVEN' not in joined or 'deadlock detected' in joined or 'timeout' in joined:raise RuntimeError('mixed lock result unproven: '+kind+' '+order)
   if order=='capture_first' and ('MIXED_LOCK_WAIT_PROVEN' not in joined or 'ERROR:' in joined):raise RuntimeError('mixed lock wait unproven')
   if order=='lane_first' and ('F06_RETRY_CANONICAL_LANE' not in joined or joined.count('ERROR:')!=1):raise RuntimeError('mixed inversion refusal unproven')
   e.report.setdefault('mixed_lock_orders',[]).append(kind+':'+order)
   e.discard(case)
