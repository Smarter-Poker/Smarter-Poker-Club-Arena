#!/usr/bin/env python3
"""Prove v3 thaw across committed connections in an owned disposable PG17 clone."""
import argparse, hashlib, json, subprocess, sys, time
from pathlib import Path
from datetime import datetime, timezone
PG = "/opt/homebrew/opt/postgresql@17/bin"
INPUTS = [
 "scripts/ci/rehearse-phase-three-committed-clock.py",
 "scripts/ci/prepare-phase-three-current-thaw-native.py",
 "scripts/ci/probes/phase-three-current-clock-thaw-native.sql",
 "scripts/ci/fixtures/phase-three-current-thaw-authority.sql",
 "scripts/ci/fixtures/phase-three-current-thaw-authority.json",
 "scripts/ci/probes/phase-three-paid-seat-clock-setup.sql",
 "supabase/tests/reconnect_allowance_maintenance.sql",
]
def quote(v):
 return "'" + str(v).replace("'", "''") + "'"
def main():
 ap=argparse.ArgumentParser(description=__doc__)
 ap.add_argument("--root",type=Path,required=True)
 ap.add_argument("--fixture-root",type=Path,required=True)
 ap.add_argument("--output-dir",type=Path,required=True)
 args=ap.parse_args()
 root=args.root.resolve(); fixture=args.fixture_root.resolve(); out=args.output_dir.resolve()
 if not str(fixture).startswith(("/tmp/codex-chip-drift-committed-clock-","/private/tmp/codex-chip-drift-committed-clock-")):
  raise SystemExit("Only an explicitly owned disposable clone is accepted")
 identity=json.loads((fixture/"identity.json").read_text())
 if identity.get("owner")!="codex-chip-drift-final" or identity.get("purpose")!="isolated committed-transaction clock acceptance":
  raise SystemExit("Owned clone identity does not match")
 if not str(out).startswith(("/tmp/","/private/tmp/")) or out.exists():
  raise SystemExit("Output must be a new disposable directory")
 out.mkdir()
 fingerprints=lambda:{n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in INPUTS}
 before=fingerprints()
 result={"status":"FAIL","checked_at":datetime.now(timezone.utc).isoformat(),
         "fixture":str(fixture),"production_connected":False,"committed_disposable_clone":True,
         "original_fixture_connected":False,"phase_three_complete":False,
         "all_fourteen_nonempty_families_proved":False,"postgrest_transport_proved":False}
 started=False; events=[]
 def sql(query):
  p=subprocess.run([PG+"/psql","-X","-h",str(fixture/"socket"),"-p","55473",
   "-U","postgres","-d","full_stage1","-At","-v","ON_ERROR_STOP=1","-c",query],
   capture_output=True,text=True,timeout=45)
  if p.returncode: raise RuntimeError(p.stderr[-2500:])
  lines=[l for l in p.stdout.splitlines() if l.startswith("{")]
  if len(lines)!=1: raise RuntimeError("Expected exactly one JSON observation: "+p.stdout[-500:])
  return json.loads(lines[0])
 try:
  subprocess.run([PG+"/pg_ctl","-D",str(fixture/"data"),"-l",str(fixture/"server.log"),
   "-o","-k "+str(fixture/"socket")+" -p 55473 -c listen_addresses=''","-w","start"],
   check=True,capture_output=True,text=True,timeout=30)
  started=True
  baseline=sql("select jsonb_build_object('database',current_database(),'unix',inet_server_addr() is null,'port',current_setting('port'),'users',(select count(*) from auth.users),'tournaments',(select count(*) from public.tournaments),'others',(select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()));")
  assert baseline=={"database":"full_stage1","unix":True,"port":"55473","users":15,"tournaments":12,"others":0},baseline
  result["baseline"]=baseline
  composed=out/"composed.sql"
  subprocess.run([sys.executable,str(root/INPUTS[1]),"--root",str(root),"--output",str(composed),"--frozen-seconds","1200"],check=True,capture_output=True,text=True)
  source=composed.read_text()
  marker="INSERT INTO public.engine_maintenance_break"
  assert source.count(marker)==1
  source=source.replace(marker,(root/INPUTS[5]).read_text()+"\n"+marker)
  setup=source.split("DO $real_thaw$",1)[0]
  setup=setup.replace("CREATE TEMP TABLE ca09_","CREATE TABLE public.ca09_").replace(" ON COMMIT DROP","")
  # The native schema guard enables RLS on new public tables. This receipt
  # collector is test-only; give only the two exercised roles access while
  # leaving every application table policy and financial guard untouched.
  fixture_table="CREATE TABLE public.ca09_paid_seat(table_id uuid, receipt jsonb);"
  assert setup.count(fixture_table)==1
  setup=setup.replace(fixture_table,fixture_table+"\nCREATE POLICY ca09_test_receipt_roles ON public.ca09_paid_seat FOR ALL TO service_role,authenticated USING (true) WITH CHECK (true);")
  setup+="\nSET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;\n"
  assert "session_replication_role" not in setup and "DISABLE TRIGGER" not in setup.upper()
  setup_path=out/"committed-setup.sql";setup_path.write_text(setup)
  result["setup_sha256"]=hashlib.sha256(setup.encode()).hexdigest()
  p=subprocess.run([PG+"/psql","-X","-h",str(fixture/"socket"),"-p","55473","-U","postgres",
   "-d","full_stage1","-At","-v","ON_ERROR_STOP=1","-f",str(setup_path)],capture_output=True,text=True,timeout=60)
  (out/"setup.stdout.log").write_text(p.stdout);(out/"setup.stderr.log").write_text(p.stderr)
  if p.returncode: raise RuntimeError(p.stderr[-2500:])
  params=sql("select to_jsonb(p) from public.ca09_parameters p;")
  fs=params["freeze_start"]; owner=params["ownership_token"]
  def thaw(token=owner):
   call="public.fn_thaw_platform("+quote(fs)+"::timestamptz-interval '120 seconds',"+quote(fs)+"::timestamptz,1,"+quote(token)+"::uuid,'CA09 committed connection proof')"
   return sql("SET ROLE service_role; select jsonb_build_object('txid',txid_current(),'result',"+call+");")
  def observe():
   return sql("select jsonb_build_object('txid',txid_current(),'owner_present',exists(select 1 from public.engine_maintenance_break where id=true),'platform_frozen',public.fn_platform_frozen(),'entry_frozen',public.fn_entry_purchases_frozen(),'release_boundary',public.fn_active_maintenance_release_boundary(),'target_count',(select count(*) from public.engine_maintenance_thaw_targets));")
  denied=thaw("ca090000-0000-0000-0000-000000000099")
  assert denied["result"].get("reason")=="maintenance_ownership_changed",denied
  assert observe()["target_count"]==0
  for n in range(12):
   event=thaw();events.append(event); r=event["result"]
   assert r.get("ok") is True,r
   observation=observe();event["separate_connection_observation"]=observation
   if r.get("complete") is True:
    assert r.get("released") is True and not observation["owner_present"],event
    break
   assert observation["owner_present"] and observation["platform_frozen"] and observation["entry_frozen"],event
   assert r.get("released") is False,r
  else: raise AssertionError("Thaw did not complete in bounded installments")
  assert len(events)>=3,events
  seconds=r["effective_frozen_seconds"]; endpoint=r["credited_through_at"]
  assert float(seconds)>=1200
  assert observation["platform_frozen"] and observation["entry_frozen"] and observation["release_boundary"] is not None
  credit="make_interval(secs=>"+str(float(seconds))+")"
  checks=sql("select jsonb_build_object('active_levels_exact',(select count(*)=42 from public.ca09_tournaments_before b join public.tournaments t using(id) where b.id::text between 'ca090100-0000-0000-0000-000000000001' and 'ca090100-0000-0000-0000-000000000042' and t.level_started_at=b.level_started_at+"+credit+"),'accepted_paid_seat_exact',(select count(*)=1 and bool_and(to_jsonb(s)-'sit_out_at'=b.unchanged_fields and s.sit_out_at=b.sit_out_at+"+credit+") from public.ca09_paid_seat_before b join public.table_seats s using(id)),'target_credits_exact',not exists(select 1 from public.engine_maintenance_thaw_targets where credited_seconds is distinct from "+str(float(seconds))+"));")
  assert all(checks.values()),checks
  snapshot_query="select jsonb_build_object('levels',(select jsonb_agg(jsonb_build_array(id,level_started_at,addon_period_ends_at) order by id) from public.tournaments where id::text like 'ca090100-%'),'seat',(select jsonb_agg(to_jsonb(s) order by id) from public.table_seats s where table_id=(select table_id from public.ca09_paid_seat)),'targets',(select jsonb_agg(to_jsonb(t) order by step,target_id) from public.engine_maintenance_thaw_targets t));"
  before_replay=sql(snapshot_query)
  replay=thaw()
  assert replay["result"].get("reason")=="release_receipt_recovered",replay
  assert replay["result"]["effective_frozen_seconds"]==seconds and replay["result"]["credited_through_at"]==endpoint,replay
  assert before_replay==sql(snapshot_query),"Committed response replay recredited a deadline"
  wait=sql("select jsonb_build_object('seconds',extract(epoch from "+quote(endpoint)+"::timestamptz-clock_timestamp()));")["seconds"]
  assert 0<float(wait)<30,wait
  time.sleep(float(wait)+0.05)
  final=observe()
  assert not final["owner_present"] and not final["platform_frozen"] and not final["entry_frozen"] and final["release_boundary"] is None,final
  ids=[e["txid"] for e in events]+[e["separate_connection_observation"]["txid"] for e in events]+[replay["txid"],final["txid"]]
  assert len(ids)==len(set(ids)),ids
  after=fingerprints();assert before==after,"Proof source changed during execution"
  result.update(status="PASS",calls=len(events),events=events,effective_frozen_seconds=seconds,
   release_endpoint=endpoint,checks=checks,source_inputs=before,source_inputs_stable=True,
   wrong_owner_refused_before_targets=True,separate_committed_installments_proved=True,
   independent_connection_admission_observations=True,committed_response_replay_without_recredit=True,
   certified_future_endpoint_kept_admission_closed=True,certified_endpoint_opened_admission=True,
   transaction_ids=ids,unique_transaction_count=len(ids),original_fixture_preserved=True)
 except Exception as e:
  result["error"]=str(e);result["events"]=events
 finally:
  if started:
   p=subprocess.run([PG+"/pg_ctl","-D",str(fixture/"data"),"-m","fast","-w","stop"],capture_output=True,text=True,timeout=30)
   result["owned_clone_stopped"]=p.returncode==0
  (out/"result.json").write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
 print(json.dumps({k:result.get(k) for k in ["status","error","calls","effective_frozen_seconds","unique_transaction_count","owned_clone_stopped"]}))
 raise SystemExit(0 if result["status"]=="PASS" and result.get("owned_clone_stopped") else 1)
if __name__=="__main__":main()
