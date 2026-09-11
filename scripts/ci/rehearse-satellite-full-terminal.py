#!/usr/bin/env python3
"""Full current TypeScript satellite receipt path, isolated native rollback only.

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

def satellite_authority(root):
    cancel=module(root/"scripts/ci/rehearse-satellite-cancel-current.py","sat_full_helpers")
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","sat_full_parse")
    m2=(root/"supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql").read_text()
    ticket=module(root/"scripts/ci/rehearse-existing-ticket-current.py","sat_full_foundation")
    if digest(m2)!=ticket.SOURCES["m4"][1]:
        raise ValueError("M2 direct-ticket foundation source differs")
    runtime=ticket.schema_foundation(m2)+"""
DO $retained_satellite_core$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)'::regprocedure)
     IS DISTINCT FROM '97d454729c5c9ef595c6083d9f0d8b72'
 OR EXISTS(SELECT 1 FROM public.tournament_satellite_settlements)
 OR EXISTS(SELECT 1 FROM public.tournament_satellite_awards)
 OR to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'retained satellite shape differs'; END IF;
END $retained_satellite_core$;
ALTER FUNCTION public.fn_settle_satellite_tournament_pre_seat_guard(uuid,uuid)
 RENAME TO fn_settle_satellite_tournament_pre_money_path_gate;
"""
    core,body=cancel.exact_function(m2,"fn_settle_satellite_tournament","5aaba653f098bd0d459c126176f182ce")
    updated,count=re.subn(r"PERFORM\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;",
      "PERFORM public.fn_ca_lock_settlement_lane_global();",body)
    if count!=1 or hashlib.md5(updated.encode()).hexdigest()!="1f2840c863f42e0fcee4e73aeb28cb88":
        raise ValueError("M2 rolling core source differs")
    union=(root/"supabase/migrations/20260910064305_a_union_ticket_is_issued_at_the_club_the_winner_plays_from.sql").read_text()
    old=whole.replacement(union,"v_gate_anchor text :=","v_gate_new    text :=")
    new=whole.replacement(union,"v_gate_new    text :=","v_audit_anchor text :=")
    if updated.count(old)!=1:
        raise ValueError("current union source anchor differs")
    updated=updated.replace(old,new,1)
    core=core.replace(body,updated,1).replace("FUNCTION public.fn_settle_satellite_tournament(",
      "FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(",1)
    runtime+=core+"\n"+cancel.grants("fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)")
    for name,expected in [("fn_ca_satellite_settlement_receipt","381b3e0691a2b9303693653f5110d568"),
                          ("fn_resolve_satellite_settlement_outcome","e5434ef58ff3a1f5ae7eef8ace6ad12d")]:
        definition,body=cancel.exact_function(m2,name,expected)
        if name=="fn_resolve_satellite_settlement_outcome":
            new,count=re.subn(r"PERFORM\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;",
              "PERFORM public.fn_ca_lock_settlement_lane_global();",body)
            if count!=1 or hashlib.md5(new.encode()).hexdigest()!="c332627d5d8c7c9ac951392c95c53551":
                raise ValueError("current outcome lane differs")
            definition=definition.replace(body,new,1)
        runtime+=definition+"\n"+cancel.grants(name+"(uuid,uuid)",service=name.startswith("fn_resolve"))
    r3=subprocess.check_output(["git","show",R3_ARCHIVE+":"+R3_FILE],cwd=root,text=True)
    if digest(r3)!=R3_SHA256:
        raise ValueError("reviewed actual R3 public-wrapper archive differs")
    wrapper,_=cancel.exact_function(r3,"fn_settle_satellite_tournament","486d0e6729de8d518d7faf0c253b65d3")
    runtime+=wrapper+"\n"+cancel.grants("fn_settle_satellite_tournament(uuid,uuid)",service=True)
    runtime+="""
SELECT 'SATELLITE_FULL_COMPOSITION='||jsonb_agg(jsonb_build_object(
 'identity',oid::regprocedure::text,'body_md5',md5(prosrc),'owner',pg_get_userbyid(proowner),
 'acl',proacl,'config',proconfig,'security_definer',prosecdef) ORDER BY oid::regprocedure::text)::text
 FROM pg_proc WHERE oid IN (
 'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure,
 'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure,
 'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure,
 'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)'::regprocedure,
 'public.fn_ca_capture_satellite_seat_entitlement()'::regprocedure,
 'public.fn_ca_lock_settlement_lane_global()'::regprocedure);
"""
    return runtime

def compose(root,candidate=False):
    cancel=module(root/"scripts/ci/rehearse-satellite-cancel-current.py","sat_full_entry")
    final=module(root/"scripts/ci/rehearse-final-deal-current-terminal.py","sat_full_final")
    entry_runtime=cancel.runtime_sql(root,False)
    original=final.runtime_sql
    def runtime(selected_root):
        result=original(selected_root)+"\n"+entry_runtime+"\n"+satellite_authority(selected_root)
        if candidate:
            whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","sat_full_adapter")
            adapter=whole.without_transaction((root/"scripts/deploy/phase-three-current-satellite-terminal.sql").read_text())
            result+="\n"+adapter+"\n"+adapter
        return result
    final.runtime_sql=runtime
    try:
        sql=final.compose(root,"paid",root/"scripts/ci/probes/satellite-full-terminal-native.sql")
    finally:
        final.runtime_sql=original
    if len(re.findall(r"^BEGIN;$",sql,re.M))!=1 or len(re.findall(r"^ROLLBACK;$",sql,re.M))!=1 or re.search(r"^COMMIT;$",sql,re.M):
        raise ValueError("native full satellite proof must be one rollback transaction")
    return sql

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",type=Path,required=True);p.add_argument("--evidence",type=Path,required=True)
    p.add_argument("--emit-only",type=Path)
    p.add_argument("--candidate",action="store_true")
    args=p.parse_args();root=args.root.resolve()
    if "/.agent-trees/" not in str(root):raise SystemExit("requires owned repository worktree")
    source_files=[Path(__file__),root/"scripts/ci/probes/satellite-full-terminal-native.sql",
      root/"scripts/ci/rehearse-satellite-cancel-current.py",root/"scripts/ci/rehearse-existing-ticket-current.py",
      root/"scripts/ci/rehearse-final-deal-current-terminal.py",
      root/"scripts/ci/rehearse-whole-phase-three-cutover.py",root/"scripts/deploy/phase-three-strict-tournament-cutover.sql",
      root/"scripts/deploy/phase-three-final-deal-terminal-v2.sql",
      root/"supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql",
      root/"supabase/migrations/20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql",
      root/"supabase/migrations/20260910064305_a_union_ticket_is_issued_at_the_club_the_winner_plays_from.sql"]
    hashes={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in source_files}
    if args.candidate:
        path=root/"scripts/deploy/phase-three-current-satellite-terminal.sql"
        hashes[str(path.relative_to(root))]=hashlib.sha256(path.read_bytes()).hexdigest()
    sql=compose(root,args.candidate)
    if args.emit_only:
        args.emit_only.write_text(sql);print(json.dumps({"prepared":True,"executed":False,"sql_sha256":digest(sql)}));return
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","sat_full_snapshot")
    baseline=whole.read_sql("""SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='d3000000-0000-4000-8000-000000000001')::text""")
    if baseline!=BASELINE:raise SystemExit("exclusive retained baseline differs: "+baseline)
    before=whole.snapshot();output=Path(tempfile.mkdtemp(prefix="codex-satellite-full-"))
    path=output/"probe.sql";path.write_text(sql)
    run=subprocess.run([whole.PSQL,"-X","-h",whole.SOCKET,"-p","55473","-U","postgres","-d","full_stage1",
      "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log=run.stdout+run.stderr;(output/"probe.log").write_text(log);after=whole.snapshot()
    ev=[x.split("=",1)[1] for x in run.stdout.splitlines() if x.startswith("SATELLITE_FULL_NATIVE_EVIDENCE=")]
    manifests=[x.split("=",1)[1] for x in run.stdout.splitlines() if x.startswith("SATELLITE_FULL_COMPOSITION=")]
    stable=all(hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=run.returncode==0 and before==after and len(ev)==len(manifests)==1 and stable
    evidence={"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"passed":passed,
      "production_mutations":False,"phase_complete":False,"current_satellite_adapter":args.candidate,"baseline":baseline,"exit_code":run.returncode,
      "rollback_exact":before==after,"source_inputs_stable":stable,"source_sha256":hashes,"sql_sha256":digest(sql),
      "assertion_groups":len(re.findall(r"NOTICE:\s+PASS ",log)),
      "runtime_composition":json.loads(manifests[0]) if len(manifests)==1 else None,
      "public_wrapper_archive":{"commit":R3_ARCHIVE,"path":R3_FILE,"sha256":R3_SHA256,"body_md5":"486d0e6729de8d518d7faf0c253b65d3"},
      "terminal_evidence":json.loads(ev[0]) if len(ev)==1 else None,"before":before,"after":after,
      "changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k)!=after.get(k)],
      "output_directory":str(output),"failure_tail":[] if passed else log.splitlines()[-35:],
      "limits":["Opening final hand and seat scene is synthetic; actual request funding, full source settlement, target transfer and terminal closure run installed authorities.",
       "The exact M2 direct-ticket columns, checks and foreign key are restored from tracked declarations. This case issues no ticket and does not certify production metadata equivalence.",
       "The tracked current M2 core is composed beneath the archived R3 public wrapper whose486d body and private83bf body were both independently matched on production; native metadata remains locally composed.",
       "Unused versioned-deal fixture supplies shared native runtime dependencies; no final-deal lifecycle is exercised here.",
       "Production cutover, engine adoption, browser acceptance and publication remain separate gates."]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ["passed","exit_code","rollback_exact","source_inputs_stable","assertion_groups","changed_after_rollback","output_directory","failure_tail"]}),flush=True)
    if not passed:raise SystemExit(1)

if __name__=="__main__":main()
