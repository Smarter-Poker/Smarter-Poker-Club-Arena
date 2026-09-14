#!/usr/bin/env python3
"""Real funded satellite target cancellation in retained PG17, rollback only.

Default mode reproduces current cancellation's ticket routing. --cash-candidate
applies only the prepared narrow writer/verifier candidate before the same probe.
No production connection, migration reservation, or deployment occurs here.
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

ARCHIVE = "473bd2d41b88ad352819c77031ddc4dad209917b"
ARCHIVED_FILES = {
 "scripts/dev/fixtures/satellite-award-funding/current-closeout-source.json":
 "93df680a7937aa52c41fc8c619c434d2cf50f0481b6f4b39ac91ff572b221d5e",
 "scripts/dev/fixtures/satellite-award-funding/installed.sql":
 "ba3a1fd990b13689acafc94ead4b998ea9c7f0eab73bbcc730111593abea8777",
}
BASELINE = "full_stage1|postgres|true|15|12|0|3|false"
STAGE_B_RESOLVER = "scripts/ci/stage_b_migration_source.py"


def module(path, name):
    spec = importlib.util.spec_from_file_location(name,path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def exact_function(source,name,expected=None):
    matches=list(re.finditer(r"CREATE (?:OR REPLACE )?FUNCTION public\."+re.escape(name)
        +r"\(.*?\bAS\s+(\$\w*\$)(.*?)\1\s*;?",source,re.S|re.I))
    if len(matches)!=1:
        raise ValueError("function source not unique: "+name)
    m=matches[0]
    if expected and hashlib.md5(m[2].encode()).hexdigest()!=expected:
        raise ValueError("function source identity differs: "+name)
    return m[0].rstrip().rstrip(";")+";",m[2]


def archived(root,path):
    text=subprocess.check_output(["git","show",ARCHIVE+":"+path],cwd=root,text=True)
    if digest(text)!=ARCHIVED_FILES[path]:
        raise ValueError("reviewed archive source differs: "+path)
    return text


def grants(identity,service=False,authenticated=False):
    result="REVOKE ALL ON FUNCTION public."+identity+" FROM PUBLIC,anon,authenticated,service_role;\n"
    roles=(["authenticated"] if authenticated else [])+(["service_role"] if service else [])
    return result+("GRANT EXECUTE ON FUNCTION public."+identity+" TO "+",".join(roles)+";\n" if roles else "")


def runtime_sql(root,candidate=False):
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","cancel_shared")
    migrations=root/"supabase/migrations"
    runtime=""
    # Current request-bound entry and the exact host/union wallet authority.
    request=(migrations/"20260909210701_tournament_registration_retains_original_operation_receipt.sql").read_text()
    runtime+=whole.without_transaction(request)+"\n"
    resolver=(migrations/"20260910020626_the_host_club_is_in_its_own_union.sql").read_text()
    resolver=resolver[resolver.index("DO $mig$"):resolver.index("  v_check :=")]
    runtime+=resolver+"""
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_tournament_club_for_user(uuid,uuid,uuid)'::regprocedure)
    IS DISTINCT FROM 'f80eff4c311820670f1b71d15c29452d'
 THEN RAISE EXCEPTION 'current wallet resolver differs'; END IF;
END $mig$;
"""
    for file,name,identity in [
      ("20260910023919_the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with.sql",
       "atomic_deduct_wallet_and_log","uuid,numeric,text,text,uuid,uuid"),
      ("20260910012633_tournament_entry_receipts_use_the_charged_club_wallet.sql",
       "log_wallet_transaction","uuid,text,numeric,text,text,text,uuid,uuid,uuid")]:
        definition,body=exact_function((migrations/file).read_text(),name)
        if name=="log_wallet_transaction":
            # Compose only the deployed logger body, with the established ACL.
            deployed=(migrations/"20260910190537_late_entry_uses_canonical_capacity_and_charged_wallet_receip.sql").read_text()
            replacements=re.findall(r"\$replacement_1\$(.*?)\$replacement_1\$",deployed,re.S)
            if len(replacements)!=1 or hashlib.md5(replacements[0].encode()).hexdigest()!="d1dd7af2ba51d15355f05d10057ec04a":
                raise ValueError("deployed charged-wallet logger source differs")
            definition=definition.replace(body,replacements[0],1)
        runtime+=definition+"\n"
        if name=="log_wallet_transaction":
            runtime+=grants(name+"("+identity+")",service=True)
    # Exact archived current satellite inputs, followed by the complete already
    # shipped source-gated correction. No synthetic payment helper is installed.
    items=json.loads(archived(root,"scripts/dev/fixtures/satellite-award-funding/current-closeout-source.json"))
    for item in items:
        definition,body=exact_function(item["definition"],item["signature"].split("(")[0],item["body_md5"])
        runtime+=definition+"\n"+grants(item["signature"],service=True)
    installed=archived(root,"scripts/dev/fixtures/satellite-award-funding/installed.sql")
    for name,identity,expected in [
      ("fn_ca_escrow_on_seat_payout","()","a9150743200c8e366964a7867e8c23f9"),
      ("fn_ca_escrow_on_seat_transfer_leg","()","227d11db5fe0b4ad403b2f45d098a166"),
      ("fn_satellite_target_player_provenance_is_immutable","()","cbe5f2c1f5947a8b1d2f85de5c1abe0d"),
      ("fn_satellite_target_rake_is_immutable","()","640f0819d80f769ce4f224413fd359b5"),
      ("fn_satellite_transfer_ledger_is_immutable","()","6f0c873ffaa7ed73f0936fb681da1a66"),
      ("fn_tournament_late_registration_open","(uuid)","ba1c6218246bddd37dc68f746df9e5ef")]:
        definition,_=exact_function(installed,name,expected)
        runtime+=definition+"\n"+grants(name+identity,service=True)
    satellite=(migrations/"20260910171924_satellite_seats_count_once_and_keep_the_funded_prize.sql").read_text()
    runtime+=whole.without_transaction(satellite)+"\n"
    # Restore the newer shared rolling settlement lane after authenticating
    # the archived satellite migration's exact historical input.
    current_lane=json.loads((root/"docs/audits/2026-09-10-native-current-settlement-lane.json").read_text())
    definition,_=exact_function(current_lane["definition"],"fn_ca_lock_settlement_lane_for_tournament",
        "3acb4c1d763181905cf5b64287f8f28f")
    runtime+=definition+"\n"+grants("fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)",service=True)
    # Build the current exact cash refund helper using the same five reviewed
    # source substitutions as the approved satellite cash policy.
    m2=(migrations/"20260909165629_satellite_settlement_has_one_atomic_authority.sql").read_text()
    definition,body=exact_function(m2,"fn_settle_tournament_refund_exact","c1ae92c6e99b1b7be109a91d951de1cd")
    current=body
    patch=(migrations/"20260909222303_satellite_unregister_returns_its_funded_cash.sql").read_text().split("DO $patch$")[1]
    replacements=list(re.finditer(r"v_before := (\$replace_\d+\$)(.*?)\1;\s*v_after := \1(.*?)\1;",patch,re.S))
    if len(replacements)!=5:
        raise ValueError("cash refund policy fragments differ")
    for change in replacements:
        if current.count(change[2])!=1:
            raise ValueError("cash refund policy preimage differs")
        current=current.replace(change[2],change[3],1)
    if hashlib.md5(current.encode()).hexdigest()!="0024ca5acfc4e4e12b51a4609349e98d":
        raise ValueError("cash refund helper postimage differs")
    runtime+=definition.replace(body,current,1)+"\n"
    runtime+=grants("fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)")
    definition,_=exact_function(m2,"fn_ca_tournament_refund_plan","27cedb21bac278709f43f037a31403a0")
    runtime+=definition+"\n"+grants("fn_ca_tournament_refund_plan(uuid,uuid)")
    definition,_=exact_function((migrations/"20260909232326_the_exact_refund_authority_is_a_money_path_r3_recognises.sql").read_text(),
        "fn_ca_money_path_log")
    runtime+=definition+"\n"
    # The funded verifier is real M3, not the synthetic replay reader in the
    # archived guard-only test. Current cancellation changes only its old lane.
    m3=(migrations/"20260909014444_tournament_cancellation_commits_one_stored_receipt.sql").read_text()
    definition,body=exact_function(m3,"atomic_cancel_tournament","6aae8b91e135ac1eac7e6a768b574c13")
    current,count=re.subn(r"PERFORM\s+pg_advisory_xact_lock\(\s*hashtextextended\(\s*'ca:tournament-terminal-settlement:v1'\s*,\s*0\s*\)\s*\)\s*;",
        "PERFORM public.fn_ca_lock_settlement_lane_global();",body)
    if count!=1 or hashlib.md5(current.encode()).hexdigest()!="8c2641c634de919487c7bbb7eb8c5c22":
        raise ValueError("current cancellation lane composition differs")
    runtime+=definition.replace(body,current,1)+"\n"+grants("atomic_cancel_tournament(uuid,uuid)",service=True)
    runtime+=whole.without_transaction((migrations/"20260910171843_started_tournaments_resume_or_settle_instead_of_cancelling.sql").read_text())+"\n"
    definition,_=exact_function(m3,"fn_ca_tournament_cancellation_receipt","1e4c6d2f87ac2068455dbff2ace3fb2e")
    runtime+=definition+"\n"+grants("fn_ca_tournament_cancellation_receipt(uuid,uuid)")
    if candidate:
        runtime+=whole.without_transaction((root/"scripts/deploy/phase-three-cancellation-origin-cash.sql").read_text())+"\n"
    runtime+="""SELECT 'SATELLITE_CANCEL_COMPOSITION='||jsonb_agg(jsonb_build_object(
 'identity',oid::regprocedure::text,'body_md5',md5(prosrc),'acl',proacl,'owner',pg_get_userbyid(proowner),'config',proconfig)
 ORDER BY oid::regprocedure::text)::text FROM pg_proc WHERE oid IN (
 'public.atomic_cancel_tournament(uuid,uuid)'::regprocedure,
 'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)'::regprocedure,
 'public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)'::regprocedure,
 'public.fn_ca_tournament_refund_plan(uuid,uuid)'::regprocedure,
 'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure,
 'public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure,
 'public.fn_ca_escrow_on_rake_record()'::regprocedure,
 'public.fn_ca_tournament_escrow(uuid)'::regprocedure,
 'public.fn_ca_lock_settlement_lane_global()'::regprocedure);
"""
    return runtime


def compose(root,candidate=False):
    final=module(root/"scripts/ci/rehearse-final-deal-current-terminal.py","cancel_final")
    satellite=module(root/"scripts/ci/rehearse-satellite-full-terminal.py","cancel_satellite")
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","cancel_adapter")
    original=final.runtime_sql
    def runtime(selected_root):
        adapter=whole.without_transaction((selected_root/"scripts/deploy/phase-three-current-satellite-terminal.sql").read_text())
        return original(selected_root)+"\n"+runtime_sql(selected_root,candidate)+"\n"+satellite.satellite_authority(selected_root)+"\n"+adapter
    final.runtime_sql=runtime
    try:
        sql=final.compose(root,"paid",root/"scripts/ci/probes/satellite-cancel-current-native.sql")
    finally:
        final.runtime_sql=original
    if len(re.findall(r"^BEGIN;$",sql,re.M))!=1 or len(re.findall(r"^ROLLBACK;$",sql,re.M))!=1 or re.search(r"^COMMIT;$",sql,re.M):
        raise ValueError("funded cancellation proof must have one rollback-only transaction")
    return sql


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--evidence",type=Path,required=True)
    parser.add_argument("--cash-candidate",action="store_true")
    parser.add_argument("--emit-only",type=Path)
    args=parser.parse_args()
    root=args.root.resolve()
    if "/.agent-trees/" not in str(root):
        raise SystemExit("requires owned repository worktree")
    stage_b=module(root/STAGE_B_RESOLVER,"cancel_stage_b_source").resolve(root)
    source_files=[Path(__file__),root/STAGE_B_RESOLVER,stage_b,
      root/"scripts/ci/probes/satellite-cancel-current-native.sql",
      root/"scripts/ci/rehearse-satellite-full-terminal.py",root/"scripts/ci/rehearse-existing-ticket-current.py",
      root/"scripts/ci/rehearse-final-deal-current-terminal.py",root/"scripts/ci/rehearse-whole-phase-three-cutover.py",
      root/"scripts/deploy/phase-three-current-satellite-terminal.sql",
      root/"scripts/deploy/phase-three-strict-tournament-cutover.sql",root/"scripts/deploy/phase-three-final-deal-terminal-v2.sql",
      root/"supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql",
      root/"supabase/migrations/20260910190537_late_entry_uses_canonical_capacity_and_charged_wallet_receip.sql"]
    if args.cash_candidate:source_files.append(root/"scripts/deploy/phase-three-cancellation-origin-cash.sql")
    hashes={str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in source_files}
    sql=compose(root,args.cash_candidate)
    if args.emit_only:
        args.emit_only.write_text(sql)
        print(json.dumps({"prepared":True,"executed":False,"sql":str(args.emit_only),"sha256":digest(sql)}))
        return
    shared=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","cancel_snapshot")
    baseline=shared.read_sql("""
SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='d3000000-0000-4000-8000-000000000001')::text
""")
    if baseline!=BASELINE:
        raise SystemExit("exclusive retained baseline differs: "+baseline)
    satellite=module(root/"scripts/ci/rehearse-satellite-full-terminal.py","cancel_wrapper_provenance")
    before=shared.snapshot()
    output=Path(tempfile.mkdtemp(prefix="codex-satellite-cancel-"))
    path=output/"probe.sql";path.write_text(sql)
    run=subprocess.run([shared.PSQL,"-X","-h",shared.SOCKET,"-p","55473","-U","postgres","-d","full_stage1",
        "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log=run.stdout+run.stderr;(output/"probe.log").write_text(log)
    after=shared.snapshot()
    values=[s[len("SATELLITE_CANCEL_COMPOSITION="):] for s in run.stdout.splitlines() if s.startswith("SATELLITE_CANCEL_COMPOSITION=")]
    stable=all(hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=run.returncode==0 and before==after and "SATELLITE_CANCEL_CURRENT_NATIVE_PASS" in run.stdout and stable
    evidence={"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"passed":passed,
        "cash_candidate":args.cash_candidate,"production_mutations":False,"phase_complete":False,
        "baseline":baseline,"exit_code":run.returncode,"rollback_exact":before==after,
        "source_inputs_stable":stable,"source_sha256":hashes,"source_full_rpc":"fn_settle_satellite_tournament",
        "assertion_groups":len(re.findall("AUDIT_TEST_PASS:",log)),"source_archive":ARCHIVE,
        "runtime_composition":json.loads(values[0]) if len(values)==1 else None,
        "public_wrapper_archive":{"commit":satellite.R3_ARCHIVE,"path":satellite.R3_FILE,"sha256":satellite.R3_SHA256,"body_md5":"486d0e6729de8d518d7faf0c253b65d3"},
        "changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k)!=after.get(k)],
        "before":before,"after":after,"sql_sha256":digest(sql),"output_directory":str(output),
        "failure_tail":[] if passed else log.splitlines()[-32:],
        "limits":["Opening final hand and seats are synthetic; actual request registration and full satellite source terminal supply target funds and its immutable entitlement.",
          "Live-proved R3 public wrapper and current M2 core are locally composed; existing-ticket redemption, unregister, browser and engine adoption remain separate gates."]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ["passed","cash_candidate","exit_code","rollback_exact","changed_after_rollback","assertion_groups","output_directory","failure_tail"]}),flush=True)
    if not passed:
        raise SystemExit(1)


if __name__=="__main__":
    main()
