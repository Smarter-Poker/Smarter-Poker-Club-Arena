#!/usr/bin/env python3
"""Current full R3 satellite cash and minted-ticket delivery, native rollback only.

Retained native schema predates ticket-aware M2. Restore its exact missing direct-ticket foundation,
latest tracked M2 receipt/core and the live-proved R3 public wrapper within one transaction.
No production metadata equivalence is inferred from this local composition.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

BASELINE="full_stage1|postgres|true|15|12|0|3|false"
R3_ARCHIVE="a37145be930ab332fbd50c0ee17546af51cefbca"
R3_FILE="supabase/migrations/20260909211115_complete_known_satellite_adoptions_after_freeze.sql"
R3_SHA256="e64c147b2ca53b89b1845a3d16acd29bd679d849b872c69f1164d3672c90bad1"

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value

def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()

def compose(root,delivery):
    if delivery not in ('cash','ticket'):
        raise ValueError('native delivery must be cash or ticket')
    full=module(root/"scripts/ci/rehearse-satellite-full-terminal.py","sat_delivery_source")
    sql=full.compose(root,True)
    anchor="UPDATE public.tournaments SET satellite_target_id="
    if sql.count(anchor)!=1:
        raise ValueError('satellite opening target anchor differs')
    setup="SELECT set_config('app.native_satellite_delivery','"+delivery+"',true);\n"
    if delivery=='cash':
        # A three-player target preserves the real heads-up rake constraint.
        # Its two extra starting wallets are opening fixture balances only;
        # both target charges and their180/20 funding are actual registration.
        setup+="UPDATE public.tournaments SET max_players=3 WHERE id='d3000000-0000-4000-8000-000000000002';\n"
        for i in (3,4):
            user='d1000000-0000-4000-8000-'+str(i).zfill(12)
            session='d4000000-0000-4000-8000-'+str(i+2).zfill(12)
            setup+="INSERT INTO auth.users(id) VALUES('"+user+"');\n"
            setup+="INSERT INTO public.users(id,username) VALUES('"+user+"','full_target_cash_"+str(i)+"');\n"
            setup+="INSERT INTO public.profiles(id,username,display_name) VALUES('"+user+"','full_target_cash_"+str(i)+"','Full target cash entrant "+str(i)+"');\n"
            setup+="INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES('d2000000-0000-4000-8000-000000000002','"+user+"','player','active',200);\n"
            setup+="INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES('"+session+"','"+user+"',now(),now());\n"
    else:
        # Only opening occupancy is synthetic; these occupied chairs contain
        # zero chips. The source remains the sole100-chip funding authority.
        for i in range(1,4):
            table='d8000000-0000-4000-8000-'+str(i).zfill(12)
            seat='d9000000-0000-4000-8000-'+str(i).zfill(12)
            game='da000000-0000-4000-8000-'+str(i).zfill(12)
            setup+="INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot,state) VALUES('"+game+"','d2000000-0000-4000-8000-000000000002','Other occupied zero-liability game','classic','nlh',"+str(i)+","+str(i*2)+",9,public.fn_cash_template_defaults('classic','nlh'),'live');\n"
            setup+="INSERT INTO public.tables(id,name,status,lifecycle,current_players,game_type,club_id,cluster_id,role,main_index,game_variant,small_blind,big_blind) VALUES('"+table+"','Other occupied zero-stack game','running','live',1,'cash','d2000000-0000-4000-8000-000000000002','"+game+"','main',1,'nlh',"+str(i)+","+str(i*2)+");\n"
            setup+="INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,is_away,club_id) VALUES('"+seat+"','"+table+"',1,'d1000000-0000-4000-8000-000000000002',0,'active',NULL,false,false,false,'d2000000-0000-4000-8000-000000000002');\n"
    sql=sql.replace(anchor,setup+anchor,1)
    if delivery=='cash':
        registrations=""
        for i in (3,4):
            user='d1000000-0000-4000-8000-'+str(i).zfill(12)
            session='d4000000-0000-4000-8000-'+str(i+2).zfill(12)
            request='d4000000-0000-4000-8000-'+str(i+4).zfill(12)
            registrations+="SELECT set_config('request.jwt.claims',jsonb_build_object('sub','"+user+"','role','authenticated','session_id','"+session+"')::text,true),set_config('request.jwt.claim.sub','"+user+"',true),set_config('request.jwt.claim.role','authenticated',true);\nSET LOCAL ROLE authenticated;\n"
            registrations+="INSERT INTO satellite_full_probe_results VALUES('extra_target_entry_"+str(i)+"',public.fn_register_for_tournament_request('d3000000-0000-4000-8000-000000000002','"+request+"'));\nRESET ROLE;\n"
        marker='-- Establish only the already-played final hand scene.'
        if sql.count(marker)!=1:raise ValueError('extra real target registration anchor differs')
        sql=sql.replace(marker,registrations+marker,1)
    start=sql.index('CREATE FUNCTION pg_temp.assert_satellite_full_money_closed()')
    end=sql.index('END $money$;',start)+len('END $money$;')
    assertions=(root/'scripts/ci/probes/satellite-full-delivery-assertions.sql').read_text()
    sql=sql[:start]+assertions+sql[end:]
    anchor="CREATE TEMP TABLE satellite_full_authority_events"
    if sql.count(anchor)!=1:
        raise ValueError('satellite classification assertion anchor differs')
    expected=("((SELECT max_players=3 AND current_players=3 FROM public.tournaments WHERE id='d3000000-0000-4000-8000-000000000002') AND (SELECT count(*)=2 FROM satellite_full_probe_results WHERE name IN ('extra_target_entry_3','extra_target_entry_4') AND value->>'ok'='true' AND (value->>'cost')::numeric=100) AND (SELECT count(*)=2 FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id IN ('d1000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000004') AND chip_balance=100) AND (SELECT prize_balance=270 AND fee_balance=30 FROM public.tournament_escrow WHERE tournament_id='d3000000-0000-4000-8000-000000000002'))"
      if delivery=='cash' else "(public.fn_concurrent_game_load('d1000000-0000-4000-8000-000000000002',NULL,NULL,'d3000000-0000-4000-8000-000000000002')=4 AND (SELECT count(*)=3 AND sum(seat.stack)=0 FROM public.table_seats seat JOIN public.tables t ON t.id=seat.table_id JOIN public.cash_games g ON g.id=t.cluster_id WHERE seat.user_id='d1000000-0000-4000-8000-000000000002' AND seat.left_at IS NULL AND t.club_id='d2000000-0000-4000-8000-000000000002' AND g.club_id=t.club_id AND g.enabled AND g.state='live' AND t.role='main' AND t.main_index=1 AND t.status='running' AND t.lifecycle='live' AND t.small_blind=g.sb AND t.big_blind=g.bb))")
    sql=sql.replace(anchor,"SELECT pg_temp.satellite_full_assert("+expected+",'actual target capacity or canonical four-game load selects the intended delivery');\n"+anchor,1)
    anchor="'tournament_seat_exit_authorizations','club_wallets','union_wallets'] LOOP"
    if sql.count(anchor)!=1:
        raise ValueError('satellite financial fingerprint anchor differs')
    sql=sql.replace(anchor,"'tournament_seat_exit_authorizations','club_wallets','union_wallets',\n 'chip_transactions','tournament_ticket_admission_authorizations'] LOOP",1)
    sql=sql.replace('all 28 financial and seat relations','all 30 financial and seat relations')
    if delivery=='ticket':
        sql=sql.replace("'chip_transactions','tournament_ticket_admission_authorizations'] LOOP","'chip_transactions','tournament_ticket_admission_authorizations','cash_games'] LOOP",1)
        sql=sql.replace('all 30 financial and seat relations','all 31 financial and seat relations')
    old="AND (first_receipt->>'seat_count')::integer=1,"
    if sql.count(old)!=1:
        raise ValueError('satellite delivered count assertion differs')
    counts=("AND (first_receipt->>'cash_ticket_count')::integer=1 AND (first_receipt->>'entry_ticket_count')::integer=0"
      if delivery=='cash' else "AND (first_receipt->>'cash_ticket_count')::integer=0 AND (first_receipt->>'entry_ticket_count')::integer=1")
    sql=sql.replace(old,"AND (first_receipt->>'seat_count')::integer=0 "+counts+",",1)
    sql=sql.replace("'rpc','fn_settle_satellite_tournament','first_receipt'","'rpc','fn_settle_satellite_tournament','delivery',current_setting('app.native_satellite_delivery'),'first_receipt'",1)
    if len(re.findall(r'^BEGIN;$',sql,re.M))!=1 or len(re.findall(r'^ROLLBACK;$',sql,re.M))!=1 or re.search(r'^COMMIT;$',sql,re.M):
        raise ValueError('native delivery case must retain exactly one rollback transaction')
    return sql

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",type=Path,required=True);p.add_argument("--evidence",type=Path,required=True)
    p.add_argument("--emit-only",type=Path)
    p.add_argument("--delivery",choices=["cash","ticket"],required=True)
    args=p.parse_args();root=args.root.resolve()
    if "/.agent-trees/" not in str(root):raise SystemExit("requires owned repository worktree")
    source_files=[Path(__file__),root/"scripts/ci/probes/satellite-full-terminal-native.sql",
      root/"scripts/ci/rehearse-satellite-full-terminal.py",root/"scripts/ci/probes/satellite-full-delivery-assertions.sql",
      root/"scripts/ci/rehearse-satellite-cancel-current.py",root/"scripts/ci/rehearse-existing-ticket-current.py",
      root/"scripts/ci/rehearse-final-deal-current-terminal.py",
      root/"scripts/ci/rehearse-whole-phase-three-cutover.py",root/"scripts/deploy/phase-three-strict-tournament-cutover.sql",
      root/"scripts/deploy/phase-three-final-deal-terminal-v2.sql",
      root/"supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql",
      root/"supabase/migrations/20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql",
      root/"supabase/migrations/20260910064305_a_union_ticket_is_issued_at_the_club_the_winner_plays_from.sql"]
    hashes={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in source_files}
    path=root/"scripts/deploy/phase-three-current-satellite-terminal.sql"
    hashes[str(path.relative_to(root))]=hashlib.sha256(path.read_bytes()).hexdigest()
    sql=compose(root,args.delivery)
    if args.emit_only:
        args.emit_only.write_text(sql);print(json.dumps({"prepared":True,"executed":False,"sql_sha256":digest(sql)}));return
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","sat_full_snapshot")
    baseline=whole.read_sql("""SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='d3000000-0000-4000-8000-000000000001')::text""")
    if baseline!=BASELINE:raise SystemExit("exclusive retained baseline differs: "+baseline)
    before=whole.snapshot();output=Path(tempfile.mkdtemp(prefix="codex-satellite-"+args.delivery+"-"))
    path=output/"probe.sql";path.write_text(sql)
    run=subprocess.run([whole.PSQL,"-X","-h",whole.SOCKET,"-p","55473","-U","postgres","-d","full_stage1",
      "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log=run.stdout+run.stderr;(output/"probe.log").write_text(log);after=whole.snapshot()
    ev=[x.split("=",1)[1] for x in run.stdout.splitlines() if x.startswith("SATELLITE_FULL_NATIVE_EVIDENCE=")]
    manifests=[x.split("=",1)[1] for x in run.stdout.splitlines() if x.startswith("SATELLITE_FULL_COMPOSITION=")]
    stable=all(hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=run.returncode==0 and before==after and len(ev)==len(manifests)==1 and stable
    evidence={"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"passed":passed,
      "production_mutations":False,"phase_complete":False,"current_satellite_adapter":True,"delivery":args.delivery,"baseline":baseline,"exit_code":run.returncode,
      "rollback_exact":before==after,"source_inputs_stable":stable,"source_sha256":hashes,"sql_sha256":digest(sql),
      "assertion_groups":len(re.findall(r"NOTICE:\s+PASS ",log)),
      "runtime_composition":json.loads(manifests[0]) if len(manifests)==1 else None,
      "public_wrapper_archive":{"commit":R3_ARCHIVE,"path":R3_FILE,"sha256":R3_SHA256,"body_md5":"486d0e6729de8d518d7faf0c253b65d3"},
      "terminal_evidence":json.loads(ev[0]) if len(ev)==1 else None,"before":before,"after":after,
      "changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k)!=after.get(k)],
      "output_directory":str(output),"failure_tail":[] if passed else log.splitlines()[-35:],
      "limits":["Opening final hand and three optional zero-stack occupied cash chairs are synthetic; actual source100 and target100 request funding, classified cash/ticket delivery, journals and terminal closure run installed authorities.",
       "The exact M2 direct-ticket columns, checks and foreign key are restored from tracked declarations. Ticket mode executes existing current83bf direct issuance; this native observation adds no new production issuance policy and does not certify production metadata equivalence.",
       "The tracked current M2 core is composed beneath the archived R3 public wrapper whose486d body and private83bf body were both independently matched on production; native metadata remains locally composed.",
       "Unused versioned-deal fixture supplies shared native runtime dependencies; no final-deal lifecycle is exercised here.",
       "Production cutover, engine adoption, browser acceptance and publication remain separate gates."]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ["passed","exit_code","rollback_exact","source_inputs_stable","assertion_groups","changed_after_rollback","output_directory","failure_tail"]}),flush=True)
    if not passed:raise SystemExit(1)

if __name__=="__main__":main()
