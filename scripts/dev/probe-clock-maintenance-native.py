#!/usr/bin/env python3
"""Actual captured five-argument maintenance composition on one owned local DB.
No activation API. Clock head/earlier local coverage are explicit local fixtures.
"""
from pathlib import Path
import hashlib,json,subprocess
repo=Path(__file__).resolve().parents[2];d=repo/'docs/audits/2026-09-10-k01-production-clock'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp/codex-satellite-cohort-pg17/socket','-p','55387','-d','clock_maintenance_composition_sep10']
def q(sql):
 r=subprocess.run(psql,input=sql,text=True,capture_output=True,timeout=60)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
seed=(repo.parent/'codex-satellite-swarm-sep10/docs/audits/2026-09-10-satellite-qualification-proof/native-seed.sql').read_text().split('COMMIT;\n',1)[1]
seed=seed.split("SELECT public.fn_close_tournament_entry_window",1)[0].replace('BEGIN;','',1)
setup='\n'.join((d/x).read_text() for x in ['native-maintenance-supplement.sql','native-maintenance-ownership.sql','native-public-owners.sql','clock-duration.sql','clock-epochs.sql','clock-maintenance.sql'])
body=r"""
CREATE FUNCTION smarter_private.fn_ca_clock_test_credit_fault() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,smarter_private AS $fault$
BEGIN
 IF current_setting('clock.inject_credit_fault',true)='on'
 AND EXISTS(SELECT 1 FROM smarter_private.ca_clock_thaw_context WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id())
 AND EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads WHERE tournament_id=NEW.id) THEN
  IF NOT EXISTS(SELECT 1 FROM smarter_private.ca_clock_heads h JOIN smarter_private.ca_clock_maintenance_bindings b
   ON b.epoch_id=h.epoch_id WHERE h.tournament_id=NEW.id AND h.revision>1 AND b.credited_seconds>0) THEN
   RAISE EXCEPTION 'fault was not after epoch credit';END IF;
  RAISE EXCEPTION 'CLOCK_INJECTED_AFTER_NATIVE_CREDIT';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER zzz_clock_native_credit_fault AFTER UPDATE OF level_started_at ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION smarter_private.fn_ca_clock_test_credit_fault();
DO $proof$
DECLARE tid uuid:='e1000000-0000-4000-8000-000000000001';
 gen uuid:='e1000000-0000-4000-8000-000000000051';
 eid uuid:='c1000000-0000-4000-8000-000000000001';
 token uuid:='c1000000-0000-4000-8000-000000000077';
 a timestamptz:=clock_timestamp()-interval '40 seconds';f timestamptz:=clock_timestamp()-interval '10 seconds';ann timestamptz:=clock_timestamp()-interval '30 seconds';
 r jsonb;s jsonb;receipt public.engine_maintenance_thaws%ROWTYPE;
 original_anchor timestamptz;expected_delta numeric;actual_delta numeric;before_fault jsonb;after_fault jsonb;second_f timestamptz;second_ann timestamptz;first_anchor timestamptz;
 checks jsonb:='[]';caught boolean;precredited bigint:=0;
BEGIN
 -- Explicit LOCAL admitted-head fixture, not a public activation operation.
 a:=a+interval '__FUTURE_ANCHOR_SECONDS__ seconds';
 UPDATE public.tournaments SET level_started_at=a WHERE id=tid;
 PERFORM smarter_private.fn_ca_clock_admit_epoch(tid,eid,'c1000000-0000-4000-8000-000000000011',gen,0,a);
 IF __PRIOR_LOCAL_COVERAGE__ THEN
  -- Durable-coverage input fixture stands in for the not-yet-built local
  -- resume owner. Actual maintenance must subtract it even when invoked later.
  precredited:=smarter_private.fn_ca_clock_credit_interval(eid,f-interval '5 seconds',f+interval '5 seconds');
  UPDATE public.tournaments SET level_started_at=level_started_at+smarter_private.fn_ca_clock_interval(precredited) WHERE id=tid;
 END IF;
 SELECT level_started_at INTO original_anchor FROM public.tournaments WHERE id=tid;
 INSERT INTO smarter_private.ca_clock_heads(tournament_id,epoch_id,current_anchor) VALUES(tid,eid,original_anchor);
 IF (SELECT tgname FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND NOT tgisinternal AND (tgtype&2)=2 ORDER BY tgname LIMIT 1)<>'a00_ca_clock_parent_gate' THEN
 RAISE EXCEPTION 'parent trylock is not first';END IF;
 checks:=checks||'"parent gate precedes all captured blocking row triggers"';
 INSERT INTO public.engine_maintenance_break(id,announced_at,break_started_at,break_ends_at,phase,enforce_freeze,ownership_token)
 VALUES(true,ann,f,clock_timestamp()+interval '2 seconds','counting_down',true,token);
 r:=public.fn_thaw_platform(ann,f,10,token,'clock-native-component');
 IF r->>'reason'<>'maintenance_break_not_due' OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaws) THEN
 RAISE EXCEPTION 'early owner did work %',r;END IF;
 checks:=checks||'"actual owner refuses early thaw without checkpoint"';
 UPDATE public.engine_maintenance_break SET break_ends_at=clock_timestamp()-interval '1 second' WHERE id;
 r:=public.fn_thaw_platform(ann,f,10,'c1000000-0000-4000-8000-000000000078','clock-native-component');
 IF r->>'reason'<>'maintenance_ownership_changed' OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaws) THEN
 RAISE EXCEPTION 'wrong owner did work %',r;END IF;
 checks:=checks||'"actual ownership token refusal leaves no checkpoint"';
 caught:=false;
 BEGIN PERFORM public.fn_thaw_platform(f,10,'legacy-native-component');
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=SQLERRM='CLOCK_V3_MAINTENANCE_OWNER_REQUIRED';END;
 IF NOT caught THEN RAISE EXCEPTION 'legacy unowned route admitted';END IF;
 checks:=checks||'"three-argument thaw cannot mutate activated epoch"';
 caught:=false;
 BEGIN
  PERFORM set_config('app.freeze_bypass','on',true);
  UPDATE public.tournaments SET level_started_at=level_started_at+interval '1 second' WHERE id=tid;
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=SQLERRM='CLOCK_CANONICAL_OWNER_REQUIRED';END;
 IF NOT caught THEN RAISE EXCEPTION 'GUC forged canonical owner';END IF;
 checks:=checks||'"freeze bypass setting cannot forge clock authority"';
 SELECT jsonb_build_object('tournaments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournaments t),
 'heads',(SELECT jsonb_agg(to_jsonb(t)) FROM smarter_private.ca_clock_heads t),
 'coverage',(SELECT jsonb_agg(to_jsonb(t)) FROM smarter_private.ca_clock_epoch_coverage t),
 'thaws',(SELECT jsonb_agg(to_jsonb(t)) FROM public.engine_maintenance_thaws t),
 'targets',(SELECT jsonb_agg(to_jsonb(t)) FROM public.engine_maintenance_thaw_targets t),
 'bindings',(SELECT jsonb_agg(to_jsonb(t)) FROM smarter_private.ca_clock_maintenance_bindings t)) INTO before_fault;
 caught:=false;
 BEGIN
  PERFORM set_config('clock.inject_credit_fault','on',true);
  PERFORM public.fn_thaw_platform(ann,f,999999,token,'clock-native-fault');
 EXCEPTION WHEN SQLSTATE 'P0001' THEN caught:=SQLERRM='CLOCK_INJECTED_AFTER_NATIVE_CREDIT';END;
 IF NOT caught THEN RAISE EXCEPTION 'controlled post-credit fault not observed';END IF;
 SELECT jsonb_build_object('tournaments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournaments t),
 'heads',(SELECT jsonb_agg(to_jsonb(t)) FROM smarter_private.ca_clock_heads t),
 'coverage',(SELECT jsonb_agg(to_jsonb(t)) FROM smarter_private.ca_clock_epoch_coverage t),
 'thaws',(SELECT jsonb_agg(to_jsonb(t)) FROM public.engine_maintenance_thaws t),
 'targets',(SELECT jsonb_agg(to_jsonb(t)) FROM public.engine_maintenance_thaw_targets t),
 'bindings',(SELECT jsonb_agg(to_jsonb(t)) FROM smarter_private.ca_clock_maintenance_bindings t)) INTO after_fault;
 IF before_fault IS DISTINCT FROM after_fault OR EXISTS(SELECT 1 FROM smarter_private.ca_clock_thaw_context) THEN
 RAISE EXCEPTION 'post-credit failure did not roll back state and witness';END IF;
 checks:=checks||'"failure after actual epoch credit rolls back heads coverage native targets and ownership witness"';
 PERFORM set_config('role','service_role',true);
 r:=public.fn_thaw_platform(ann,f,999999,token,'clock-native-component');
 PERFORM set_config('role','postgres',true);
 checks:=checks||'"actual service role executes verified public owner through private postgres authority"';
 IF r->>'reason'<>'release_boundary_planned' THEN RAISE EXCEPTION 'actual broad checkpoint did not plan %',r;END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.ca_clock_thaw_context) THEN RAISE EXCEPTION 'private context leaked after checkpoint';END IF;
 checks:=checks||'"actual snapshot and broad checkpoint bind exact epoch and clean context"';
 IF __REBASE__ THEN
  SELECT * INTO receipt FROM public.engine_maintenance_thaws WHERE freeze_started_at=f;
  PERFORM pg_sleep(GREATEST(0,extract(epoch FROM (receipt.release_target_at-clock_timestamp())))+0.05);
  s:=public.fn_thaw_platform(ann,f,1,token,'clock-native-rebase');
  IF s->>'reason'<>'release_boundary_rebased' THEN RAISE EXCEPTION 'missed release did not rebase %',s;END IF;
  checks:=checks||'"actual owner rebases missed future release without repeating credited prefix"';
 END IF;
 s:=public.fn_thaw_platform(ann,f,1,token,'clock-native-component');
 IF s->>'reason'<>'thaw_complete_release_scheduled' OR NOT (s->>'complete')::boolean THEN
 RAISE EXCEPTION 'actual suffix did not complete %',s;END IF;
 SELECT * INTO receipt FROM public.engine_maintenance_thaws WHERE freeze_started_at=f;
 expected_delta:=GREATEST(0,extract(epoch FROM (receipt.release_target_at-GREATEST(a,f))))*1000000;
 IF __PRIOR_LOCAL_COVERAGE__ THEN
 expected_delta:=expected_delta-GREATEST(0,extract(epoch FROM (LEAST(f+interval '5 seconds',receipt.release_target_at)-GREATEST(a,f))))*1000000;
 END IF;
 SELECT extract(epoch FROM (level_started_at-original_anchor))*1000000 INTO actual_delta FROM public.tournaments WHERE id=tid;
 IF actual_delta<>expected_delta THEN RAISE EXCEPTION 'maintenance interval credit mismatch actual %, expected %',actual_delta,expected_delta;END IF;
 checks:=checks||'"actual suffix credits only uncovered epoch-clipped time"';
 IF NOT EXISTS(SELECT 1 FROM smarter_private.ca_clock_maintenance_bindings b JOIN public.engine_maintenance_thaw_targets x
 ON (x.freeze_started_at,x.step,x.target_id)=(b.freeze_started_at,b.step,b.tournament_id)
 WHERE b.freeze_started_at=f AND b.epoch_id=eid AND b.credited_seconds=x.credited_seconds
 AND b.credited_seconds=receipt.frozen_seconds AND b.applied_micros=actual_delta) THEN RAISE EXCEPTION 'native receipt not equal binding';END IF;
 checks:=checks||'"native cumulative receipt and epoch binding agree after suffix"';
 IF EXISTS(SELECT 1 FROM public.engine_maintenance_break) OR NOT public.fn_platform_frozen() THEN
 RAISE EXCEPTION 'future release certificate did not preserve freeze';END IF;
 checks:=checks||'"actual release certificate keeps platform frozen after break deletion"';
 r:=public.fn_thaw_platform(ann,f,10,token,'clock-native-component');
 IF r->>'reason'<>'release_receipt_recovered' OR (SELECT level_started_at FROM public.tournaments WHERE id=tid)<>original_anchor+make_interval(secs=>actual_delta/1000000) THEN
 RAISE EXCEPTION 'completed old owner replay shifted clock';END IF;
 checks:=checks||'"completed owner replay cannot repeat clock credit"';
 IF EXISTS(SELECT 1 FROM smarter_private.ca_clock_thaw_context) THEN RAISE EXCEPTION 'private context leaked';END IF;
 checks:=checks||'"private ownership context is removed on completion"';
 caught:=false;
 BEGIN PERFORM smarter_private.fn_ca_clock_admit_epoch(tid,'c1000000-0000-4000-8000-000000000002',
 'c1000000-0000-4000-8000-000000000012',gen,1,receipt.release_target_at);
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=SQLERRM='CLOCK_FROZEN';END;
 IF NOT caught THEN RAISE EXCEPTION 'future release admitted next epoch early';END IF;
 checks:=checks||'"next epoch admission respects future certified release"';
 caught:=false;
 BEGIN
  PERFORM set_config('role','service_role',true);
  PERFORM smarter_private.fn_ca_clock_base_checkpoint(f,10,'private-forgery');
 EXCEPTION WHEN insufficient_privilege THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'service called private retained worker';END IF;
 checks:=checks||'"actual service role cannot bypass wrapper through retained private worker"';
 caught:=false;
 BEGIN
  PERFORM set_config('role','authenticated',true);
  PERFORM public.fn_thaw_platform(ann,f,10,token,'authenticated-forgery');
 EXCEPTION WHEN insufficient_privilege THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'authenticated called service owner';END IF;
 checks:=checks||'"actual authenticated role cannot call service thaw owner"';
 IF __TWO_FREEZES__ THEN
  PERFORM pg_sleep(GREATEST(0,extract(epoch FROM (receipt.release_target_at-clock_timestamp())))+0.05);
  IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'certificate stayed frozen beyond actual target';END IF;
  first_anchor:=(SELECT level_started_at FROM public.tournaments WHERE id=tid);
  second_ann:=clock_timestamp()-interval '0.02 seconds';second_f:=second_ann+interval '0.005 seconds';
  INSERT INTO public.engine_maintenance_break(id,announced_at,break_started_at,break_ends_at,phase,enforce_freeze,ownership_token)
  VALUES(true,second_ann,second_f,second_f+interval '0.005 seconds','counting_down',true,token);
  r:=public.fn_thaw_platform(second_ann,second_f,1,token,'second-freeze');
  IF r->>'reason'<>'release_boundary_planned' THEN RAISE EXCEPTION 'second freeze not planned %',r;END IF;
  r:=public.fn_thaw_platform(second_ann,second_f,1,token,'second-freeze');
  IF r->>'reason'<>'thaw_complete_release_scheduled' THEN RAISE EXCEPTION 'second freeze incomplete %',r;END IF;
  SELECT * INTO receipt FROM public.engine_maintenance_thaws WHERE freeze_started_at=second_f;
  IF (SELECT level_started_at FROM public.tournaments WHERE id=tid)<>first_anchor+(receipt.release_target_at-second_f)
   OR (SELECT count(*) FROM smarter_private.ca_clock_maintenance_bindings WHERE epoch_id=eid AND step='level_started_at')<>2 THEN
   RAISE EXCEPTION 'two freezes changed epoch or credited old window twice';END IF;
  checks:=checks||'"two actual maintenance windows retain one epoch and independent cumulative receipts"';
 END IF;
 PERFORM set_config('clock.proof_results',checks::text,true);
END $proof$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT current_setting('clock.proof_results');
ROLLBACK;
"""
results=[]
for name,future,prior,rebase,two in [('ordinary_epoch',0,False,False,False),('future_level_hold',45,False,False,False),('maintenance_after_prior_local_credit',0,True,False,False),('future_release_rebase',0,False,True,False),('two_freezes_one_epoch',0,False,False,True)]:
 sql='BEGIN;\n'+setup+'\n'+seed+'\nSET LOCAL ROLE postgres;\n'+body.replace('__FUTURE_ANCHOR_SECONDS__',str(future)).replace('__PRIOR_LOCAL_COVERAGE__',str(prior).lower()).replace('__REBASE__',str(rebase).lower()).replace('__TWO_FREEZES__',str(two).lower())
 out=q(sql);checks=json.loads(out.splitlines()[-1]);results.append({'case':name,'checks':checks,'passed':len(checks)})
 print(name,len(checks),'PASS',flush=True)
source_refusals=[]
prefix=setup.split('-- Prospective maintenance composition component.',1)[0]
candidate=(d/'clock-maintenance.sql').read_text()
for name,fault in [
 ('changed_source_acl','GRANT EXECUTE ON FUNCTION public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric) TO service_role;'),
 ('changed_source_owner','ALTER FUNCTION public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric) OWNER TO "smarter.poker";'),
 ('changed_source_path','ALTER FUNCTION public.fn_snapshot_maintenance_thaw_targets(timestamptz,numeric) SET search_path=pg_catalog;'),
 ('changed_source_body',"CREATE OR REPLACE FUNCTION public.fn_snapshot_maintenance_thaw_targets(p_freeze_started timestamptz,p_initial_seconds numeric) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fault$ BEGIN RETURN '{}'::jsonb;END $fault$;")]:
 try:q('BEGIN;\n'+prefix+'\n'+fault+'\n'+candidate+'\nROLLBACK;')
 except RuntimeError as err:
  if 'CLOCK_MAINTENANCE_SOURCE_DRIFT' not in str(err):raise
 else:raise AssertionError('source drift admitted: '+name)
 source_refusals.append(name)
 print(name,'REFUSED',flush=True)
evidence={'source_refusals':source_refusals,'scope':'Actual current snapshot/checkpoint/suffix/five-argument owner plus epoch-bound credit candidate; local activation and prior-local-credit fixtures are explicit','cases':results,'passed':sum(r['passed'] for r in results),'production_writes':False,
'limits':['No public clock activation/advance/pause/resume owner yet','No local pause owner proof: earlier local credit is injected as a private fixture','No complete member/paid-capacity lock graph or rollback proof yet','Native full satellite fixture includes local Stage-B prerequisite and seven observed disabled guards'],
'files':{str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [d/'clock-maintenance.sql',d/'clock-epochs.sql',d/'native-maintenance-supplement.sql',d/'maintenance-source-capture.json',d/'native-maintenance-ownership.sql',d/'maintenance-relation-acl.json',d/'native-public-owners.sql',d/'native-public-owner-capture.json',Path(__file__).resolve()]}}
(d/'maintenance-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({'passed':evidence['passed'],'source_refusals':len(source_refusals),'production_writes':False},indent=2))
