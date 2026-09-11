#!/usr/bin/env python3
"""Current funded Spin launch/recovery/winner completion, native rollback only.

Composes the already-proved current final-deal runtime and current entry/refund
runtime. The old Spin terminal composer is not imported or executed. All native
writes occur in one BEGIN/ROLLBACK and require the idle owned retained database.
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

BASELINE = "full_stage1|postgres|true|15|12|0|3|false"
SPIN_FILE = "supabase/migrations/20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql"
SPIN_SHA = "0634d1da3856c1db483ea99fb9713838a5c7c5158e1d2f3ee6daf58f335dcf7f"
PROBE = "scripts/ci/probes/spin-full-current-terminal-native.sql"
STAGE_B_RESOLVER = "scripts/ci/stage_b_migration_source.py"


def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def current_entry_prerequisites(root,parser):
    installed=(root/"scripts/dev/fixtures/registration-funding/installed.sql").read_text()
    if digest(installed)!="5e78455fcb7b3a4eba04dff7b5ccfa74c3a813d1ed13c81d78ec990b85826b9a":
        raise ValueError("current public registration capture changed")
    registration,body=parser.exact_function(installed,"fn_register_for_tournament","233acf6219e11af17d2c44b4b4460bc0")
    # Isolate one real installed function. Never import the capture's fixture auth or schema stubs.
    a=body.index("  IF public.fn_caller_session_is_live()")
    b=body.index("  v_gate:=",a)
    previous=body[:a]+body[b:]
    previous_md5=hashlib.md5(previous.encode()).hexdigest()
    if previous_md5!="b998ddca4652275f41bea226c0d18ca8":
        raise ValueError("retained registration wrapper source differs")
    source=(root/"supabase/migrations/20260909183657_seat_first_unregistration_uses_actual_start_truth.sql").read_text()
    if digest(source)!="2bd44741a966cd0f453e7f8cc3df13ca5e6269b27b36642c48add4151817703e":
        raise ValueError("current pre-draw Spin contract source changed")
    guard,_=parser.exact_function(source,"fn_spin_tournament_contract_is_draw","2c1ed86b9dac95ba2d6662e300f4c12e")
    sql="""
DO $spin_current_entry_preimages$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_register_for_tournament(uuid,boolean)'::regprocedure
  AND md5(prosrc) IN ('@OLD_PUBLIC@','233acf6219e11af17d2c44b4b4460bc0') AND prosecdef AND proowner='postgres'::regrole)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_spin_tournament_contract_is_draw()'::regprocedure
  AND md5(prosrc) IN ('78639fa4aff27cdffbf55b38a26460d4','2c1ed86b9dac95ba2d6662e300f4c12e') AND prosecdef AND proowner='postgres'::regrole)
 THEN RAISE EXCEPTION 'retained Spin entry prerequisites differ'; END IF;
END $spin_current_entry_preimages$;
""".replace("@OLD_PUBLIC@",previous_md5)
    sql+=registration+"\n"+guard+"\n"
    sql+="""
DO $spin_current_entry_postimages$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_register_for_tournament(uuid,boolean)'::regprocedure
  AND md5(prosrc)='233acf6219e11af17d2c44b4b4460bc0'
  AND md5(pg_get_functiondef(oid))='0f3b104a1bf9431d70053c656fedc081')
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_spin_tournament_contract_is_draw()'::regprocedure
  AND md5(prosrc)='2c1ed86b9dac95ba2d6662e300f4c12e'
  AND md5(pg_get_functiondef(oid))='747fc99476b082256141d42003a6c478')
 THEN RAISE EXCEPTION 'live-matched Spin entry prerequisite postimages differ'; END IF;
END $spin_current_entry_postimages$;
"""
    return sql


def compose(root):
    final=module(root/"scripts/ci/rehearse-final-deal-current-terminal.py","spin_full_final")
    entry=module(root/"scripts/ci/rehearse-satellite-cancel-current.py","spin_full_entry")
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","spin_full_shared")
    spin=(root/SPIN_FILE).read_text()
    if digest(spin)!=SPIN_SHA:
        raise ValueError("exact current Spin34412 source differs")
    original=final.runtime_sql
    def runtime(selected_root):
        result=original(selected_root)+"\n"+entry.runtime_sql(selected_root,True)
        result+="\n"+whole.request_dependencies(selected_root)+"\n"+current_entry_prerequisites(selected_root,entry)+"\n"+whole.without_transaction(spin)
        result+="""
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='8s';
DO $current_seat_first_pins$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_create_seat_first_game_atomic(uuid,jsonb)','92cbf5680d78bdbaa4309412b3d19dfd','b40dd95b7a87019070a8abf0fcc4fff3'),
  ('public.fn_take_seat_and_buy_in(uuid,integer)','a965493d4837187d433b3cdd40c5da81','f797562b85484b760d8c4f46d5b234fb'),
  ('public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)','14d555291b857c15912d4028828f3d5b','1f6a9e611514f186bd9aeeab3cd78bed'),
  ('public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)','b22f559c1e388ed3564b8cad6fd801d6','b5edb7220bf27dd671baa750f2fc6c04')
 ) expected(identity,definition_md5,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p
  WHERE p.oid=to_regprocedure(expected.identity) AND md5(pg_get_functiondef(p.oid))=expected.definition_md5
   AND md5(p.prosrc)=expected.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef))
 THEN RAISE EXCEPTION 'FAIL live/native-matched seat-first creator and entry chain differ'; END IF;
END $current_seat_first_pins$;
DO $current_launch_pins$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)','2ae3184bbea06198a00b8409cf808083'),
  ('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)','5f6597231e323454438ab66aa7defcb3'),
  ('public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)','dce5d1ac72e862f3c30c9a9a73f56d18'),
  ('public.fn_prove_played_spin_launch_recovery(uuid)','b7bc1bb46141fb6bd415b3658e622a3b'),
  ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)','d1b5100c2b9f92bec5fd1680b0b4f230')
 ) expected(identity,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p
  WHERE p.oid=to_regprocedure(expected.identity) AND md5(p.prosrc)=expected.body_md5
   AND p.proowner='postgres'::regrole AND p.prosecdef))
 THEN RAISE EXCEPTION 'FAIL current live-matched Spin launch dependencies differ'; END IF;
END $current_launch_pins$;
SELECT 'SPIN_FULL_COMPOSITION='||jsonb_agg(jsonb_build_object(
 'identity',oid::regprocedure::text,'body_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(oid)),
 'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig,'security_definer',prosecdef)
 ORDER BY oid::regprocedure::text)::text FROM pg_proc WHERE oid IN (
 'public.fn_register_for_tournament(uuid,boolean)'::regprocedure,
 'public.fn_spin_tournament_contract_is_draw()'::regprocedure,
 'public.fn_create_seat_first_game_atomic(uuid,jsonb)'::regprocedure,
 'public.fn_take_seat_and_buy_in(uuid,integer)'::regprocedure,
 'public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)'::regprocedure,
 'public.fn_take_seat_and_buy_in_before_terminal_seat_gate(uuid,integer)'::regprocedure,
 'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure,
 'public.fn_spin_book_entry(uuid)'::regprocedure,
 'public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure,
 'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure,
 'public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid)'::regprocedure,
 'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)'::regprocedure,
 'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure,
 'public.fn_prove_played_spin_launch_recovery(uuid)'::regprocedure,
 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure,
 'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure,
 'public.fn_claim_tournament_finish(uuid,uuid,text)'::regprocedure,
 'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)'::regprocedure,
 'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure,
 'public.atomic_cancel_tournament(uuid,uuid)'::regprocedure,
 'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)'::regprocedure);
"""
        return result
    final.runtime_sql=runtime
    try:
        sql=final.compose(root,"paid",root/PROBE)
    finally:
        final.runtime_sql=original
    if len(re.findall(r"^BEGIN;$",sql,re.M))!=1 or len(re.findall(r"^ROLLBACK;$",sql,re.M))!=1 or re.search(r"^COMMIT;$",sql,re.M):
        raise ValueError("Spin proof must be exactly one rollback transaction")
    for forbidden in ["INSERT INTO public.tournaments", "INSERT INTO public.tables", "INSERT INTO public.table_seats",
                      "INSERT INTO public.spin_draw_receipts", "INSERT INTO public.tournament_launch_receipts",
                      "INSERT INTO public.tournament_escrow", "INSERT INTO public.wallet_transactions",
                      "INSERT INTO public.chip_ledger", "INSERT INTO public.tournament_refund_entitlements"]:
        if forbidden in (root/PROBE).read_text():
            raise ValueError("Spin fixture cannot seed money or receipts: "+forbidden)
    return sql


def source_hashes(root):
    stage_b = module(root / STAGE_B_RESOLVER, "spin_stage_b_source").resolve(root)
    files = ('scripts/ci/rehearse-spin-full-current-terminal.py', STAGE_B_RESOLVER,
      str(stage_b.relative_to(root)), 'scripts/ci/probes/spin-full-current-terminal-native.sql', 'scripts/ci/rehearse-final-deal-current-terminal.py', 'scripts/ci/rehearse-satellite-cancel-current.py', 'scripts/ci/rehearse-whole-phase-three-cutover.py', 'scripts/ci/rehearse-stage-b-cash-payers.py', 'scripts/dev/build-versioned-final-deal-probe.py', 'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql', 'scripts/deploy/phase-three-strict-tournament-cutover.sql', 'scripts/deploy/phase-three-final-deal-terminal-v2.sql', 'scripts/deploy/phase-three-cancellation-origin-cash.sql', 'scripts/deploy/2026-09-10-restore-rake-attribution-retries.sql', 'docs/audits/2026-09-10-native-current-settlement-lane.json', 'docs/audits/2026-09-10-native-current-money-authorities.json', 'docs/audits/2026-09-10-native-current-seat-authority.json', 'supabase/migrations/20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql', 'supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql', 'supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql', 'supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql', 'supabase/migrations/20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql', 'supabase/migrations/20260909210701_tournament_registration_retains_original_operation_receipt.sql', 'supabase/migrations/20260910020626_the_host_club_is_in_its_own_union.sql', 'supabase/migrations/20260910023919_the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with.sql', 'supabase/migrations/20260910012633_tournament_entry_receipts_use_the_charged_club_wallet.sql', 'supabase/migrations/20260910190537_late_entry_uses_canonical_capacity_and_charged_wallet_receip.sql', 'supabase/migrations/20260910171924_satellite_seats_count_once_and_keep_the_funded_prize.sql', 'supabase/migrations/20260909222303_satellite_unregister_returns_its_funded_cash.sql', 'supabase/migrations/20260909232326_the_exact_refund_authority_is_a_money_path_r3_recognises.sql', 'supabase/migrations/20260909014444_tournament_cancellation_commits_one_stored_receipt.sql', 'supabase/migrations/20260910171843_started_tournaments_resume_or_settle_instead_of_cancelling.sql')
    files += (
      "scripts/dev/fixtures/registration-funding/installed.sql",
      "supabase/migrations/20260909183657_seat_first_unregistration_uses_actual_start_truth.sql",
      "supabase/migrations/20260908043250_seat_first_board_creation_is_one_transaction.sql",
      "scripts/dev/fixtures/heads-up-funding/captured-functions.json",
      "supabase/migrations/20260910063559_a_busy_manager_keeps_its_lease.sql",
      "supabase/migrations/20260908043200_tournament_manager_requests_carry_lease_authority.sql",
      "supabase/migrations/20260908042900_tournament_leases_have_fencing_generations.sql",
      "supabase/migrations/20260908221010_lease_heartbeats_skip_busy_generations.sql",
    )
    return {f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--evidence",type=Path,required=True)
    p.add_argument("--native-socket",type=Path,help="owned local fixture socket")
    p.add_argument("--emit-only",type=Path)
    args=p.parse_args();root=args.root.resolve()
    if "/.agent-trees/" not in str(root):
        raise SystemExit("requires owned repository worktree")
    hashes=source_hashes(root);sql=compose(root)
    if args.emit_only:
        args.emit_only.write_text(sql)
        print(json.dumps({"prepared":True,"executed":False,"sql_sha256":digest(sql),
          "probe_sha256":hashes[PROBE],"source_sha256":SPIN_SHA}))
        return
    whole=module(root/"scripts/ci/rehearse-whole-phase-three-cutover.py","spin_full_snapshot")
    if args.native_socket:
        whole.SOCKET=str(args.native_socket.resolve())
    baseline=whole.read_sql("""SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text||'|'||
 (SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)||'|'||
 (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||
 (SELECT count(*) FROM public.tournament_seat_move_receipts)||'|'||
 EXISTS(SELECT 1 FROM public.tournaments WHERE id='92010000-0000-0000-0000-000000000001')::text""")
    if baseline!=BASELINE:
        raise SystemExit("exclusive retained native baseline differs: "+baseline)
    before=whole.snapshot();output=Path(tempfile.mkdtemp(prefix="codex-spin-full-current-"))
    path=output/"probe.sql";path.write_text(sql)
    run=subprocess.run([whole.PSQL,"-X","-h",whole.SOCKET,"-p","55473","-U","postgres","-d","full_stage1",
       "-At","-v","ON_ERROR_STOP=1","-f",str(path)],capture_output=True,text=True)
    log=run.stdout+run.stderr;(output/"probe.log").write_text(log);after=whole.snapshot()
    ev=[x.split("=",1)[1] for x in run.stdout.splitlines() if x.startswith("SPIN_FULL_NATIVE_EVIDENCE=")]
    manifests=[x.split("=",1)[1] for x in run.stdout.splitlines() if x.startswith("SPIN_FULL_COMPOSITION=")]
    stable=all((root/f).exists() and hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in hashes.items())
    passed=run.returncode==0 and before==after and len(ev)==len(manifests)==1 and stable
    evidence={"recorded_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"passed":passed,
       "production_mutations":False,"phase_complete":False,"native_socket":whole.SOCKET,"baseline":baseline,"exit_code":run.returncode,
       "rollback_exact":before==after,"source_inputs_stable":stable,"source_sha256":hashes,"sql_sha256":digest(sql),
       "assertion_groups":len(re.findall(r"NOTICE:\s+PASS ",log)),
       "runtime_composition":json.loads(manifests[0]) if len(manifests)==1 else None,
       "terminal_evidence":json.loads(ev[0]) if len(ev)==1 else None,"before":before,"after":after,
       "changed_after_rollback":[k for k in sorted(set(before)|set(after)) if before.get(k)!=after.get(k)],
       "output_directory":str(output),"failure_tail":[] if passed else log.splitlines()[-55:],
       "limits":["Opening member wallets, reserve capital and accepted dealt-hand scenes are synthetic; actual creator, take-seat purchase, lease, launch, draw and terminal authorities create all boards, paid seats, funds and receipts.",
        "Current cancellation source623100 and reader0b6ab are locally composed; a played/committed Spin must refuse cancellation without any replacement ticket or refund.",
        "The unused versioned-deal fixture supplies shared runtime prerequisites and does not fund this Spin.",
        "All seven terminal guards are enabled; whole Stage B manager-envelope integration, production activation, engine adoption and browser acceptance remain separate gates."]}
    args.evidence.write_text(json.dumps(evidence,indent=2)+"\n")
    print(json.dumps({k:evidence[k] for k in ["passed","exit_code","rollback_exact","source_inputs_stable","assertion_groups","changed_after_rollback","output_directory","failure_tail"]}),flush=True)
    if not passed:
        raise SystemExit(1)


if __name__=="__main__":
    main()
