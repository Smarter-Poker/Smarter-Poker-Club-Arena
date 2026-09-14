#!/usr/bin/env python3
"""Existing issued ticket -> actual redemption -> current cash cancellation.

The exact existing-ticket fixture/runtime is reused without new historical money.
Only isolated native PG17 is supported; all writes are rolled back and all public
relations plus the shared full catalog snapshot must remain byte-identical.
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

PROBE="scripts/ci/probes/existing-ticket-cancellation-native.sql"
BASELINE="full_stage1|postgres|true|15|12|0|3|false"

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value

def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()

def compose(root):
    ticket=module(root/"scripts/ci/rehearse-existing-ticket-current.py","ticket_cancel_source")
    cancel=module(root/"scripts/ci/rehearse-satellite-cancel-current.py","ticket_cancel_authority")
    sql=ticket.compose(root)
    if len(re.findall(r"^BEGIN;$",sql,re.M))!=1 or len(re.findall(r"^ROLLBACK;$",sql,re.M))!=1:
        raise ValueError("existing-ticket rollback boundary differs")
    # Install reviewed current cancellation first, then retain the exact proved
    # ticket runtime/fixture and all six original redemption checks unchanged.
    sql=sql.replace("BEGIN;\n","BEGIN;\n"+cancel.runtime_sql(root,True)+"\n",1)
    relations=",".join("'"+n+"'" for n in ticket.TABLES)
    fingerprint="""CREATE FUNCTION pg_temp.ticket_cancel_state() RETURNS text
LANGUAGE plpgsql AS $fingerprint$
DECLARE n text; a jsonb; j jsonb:='{}'::jsonb;
BEGIN
 FOREACH n IN ARRAY ARRAY["""+relations+"""] LOOP
  IF to_regclass(n) IS NULL THEN a:='null'::jsonb;
  ELSE EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),''[]''::jsonb) FROM %s x',n) INTO a;
  END IF;
  j:=j||jsonb_build_object(n,a);
 END LOOP;
 RETURN md5(j::text);
END $fingerprint$;
"""
    probe=(root/PROBE).read_text()
    if probe.count("-- @TICKET_CANCEL_FINGERPRINT@")!=1:
        raise ValueError("ticket cancellation fingerprint marker differs")
    probe=probe.replace("-- @TICKET_CANCEL_FINGERPRINT@",fingerprint,1)
    sql=sql.replace("\nROLLBACK;", "\n"+probe+"\nROLLBACK;",1)
    if len(re.findall(r"^BEGIN;$",sql,re.M))!=1 or len(re.findall(r"^ROLLBACK;$",sql,re.M))!=1 or re.search(r"^COMMIT;$",sql,re.M):
        raise ValueError("ticket cancellation requires one outer rollback and no commit")
    return sql

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",type=Path,required=True);p.add_argument("--evidence",type=Path,required=True)
    p.add_argument("--emit-only",type=Path)
    args=p.parse_args();root=args.root.resolve()
    if "/.agent-trees/" not in str(root):raise SystemExit("requires owned repository worktree")
    ticket=module(root/"scripts/ci/rehearse-existing-ticket-current.py","ticket_cancel_inputs")
    cancel=module(root/"scripts/ci/rehearse-satellite-cancel-current.py","ticket_cancel_archives")
    inputs={root/v[0] for v in ticket.SOURCES.values()}
    inputs.update({Path(__file__),root/PROBE,root/ticket.PROBE,
      root/"scripts/ci/rehearse-existing-ticket-current.py",root/"scripts/ci/rehearse-satellite-cancel-current.py",
      root/"scripts/ci/rehearse-whole-phase-three-cutover.py",
      root/"scripts/deploy/phase-three-cancellation-origin-cash.sql",
      root/"docs/audits/2026-09-10-native-current-settlement-lane.json"})
    runtime_source=(root/"scripts/ci/rehearse-satellite-cancel-current.py").read_text()
    inputs.update(root/"supabase/migrations"/n for n in re.findall(r'"(202609\d+_[a-z0-9_]+\.sql)"',runtime_source))
    hashes={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(inputs)}
    sql=compose(root)
    if args.emit_only:
        args.emit_only.write_text(sql);print(json.dumps({"prepared":True,"executed":False,"sql_sha256":digest(sql)}));return
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","ticket_cancel_snapshot")
    baseline=whole.read_sql("""SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='e4100000-0000-4000-8000-000000000003')::text""")
    if baseline!=BASELINE:raise SystemExit("exclusive retained baseline differs: "+baseline)
    before=whole.snapshot();output=Path(tempfile.mkdtemp(prefix="codex-existing-ticket-cancel-"))
    path=output/"probe.sql";path.write_text(sql)
    run=subprocess.run([whole.PSQL,"-X","-h",whole.SOCKET,"-p","55473","-U","postgres","-d","full_stage1",
      "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log=run.stdout+run.stderr;(output/"probe.log").write_text(log);after=whole.snapshot()
    values=[s.split("=",1)[1] for s in run.stdout.splitlines() if s.startswith("EXISTING_TICKET_CANCELLATION_NATIVE_EVIDENCE=")]
    stable=all(hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=run.returncode==0 and before==after and len(values)==1 and stable
    evidence={"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"passed":passed,
      "production_mutations":False,"phase_complete":False,"baseline":baseline,"exit_code":run.returncode,
      "rollback_exact":before==after,"source_inputs_stable":stable,"source_sha256":hashes,"sql_sha256":digest(sql),
      "assertion_groups":len(re.findall("AUDIT_TEST_PASS:",log)),
      "archived_cancel_dependencies":{"commit":cancel.ARCHIVE,"files":cancel.ARCHIVED_FILES},
      "terminal_evidence":json.loads(values[0]) if len(values)==1 else None,
      "before":before,"after":after,"changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k)!=after.get(k)],
      "output_directory":str(output),"failure_tail":[] if passed else log.splitlines()[-45:],
      "limits":["The exact existing historical200 ticket issue fixture is reused; its original source funding/issuance execution is not certified.",
       "Actual authenticated redemption and current cash cancellation, fee reversal, late-fault rollback and replay run real authorities.",
       "Historically returned tickets share tournament_ticket entitlement kind but their distinct admission provenance is a separate lifecycle case.",
       "Production cutover, whole Stage B manager requests, engine and browser acceptance remain separate gates."]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ["passed","exit_code","rollback_exact","source_inputs_stable","assertion_groups","changed_after_rollback","output_directory","failure_tail"]}),flush=True)
    if not passed:raise SystemExit(1)

if __name__=="__main__":main()
