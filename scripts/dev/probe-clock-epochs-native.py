#!/usr/bin/env python3
"""Native immutable epoch component proof. No activation/publication assertion.
Uses one owned DB in the satellite agent's existing local cluster.
"""
from pathlib import Path
import hashlib,json,subprocess
repo=Path(__file__).resolve().parents[2]
d=repo/'docs/audits/2026-09-10-k01-production-clock'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp/codex-satellite-cohort-pg17/socket','-p','55387','-d','clock_maintenance_composition_sep10']
def q(sql):
 r=subprocess.run(psql,input=sql,text=True,capture_output=True,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
seed=(repo.parent/'codex-satellite-swarm-sep10/docs/audits/2026-09-10-satellite-qualification-proof/native-seed.sql').read_text().split('COMMIT;\n',1)[1]
seed=seed.split("SELECT public.fn_close_tournament_entry_window",1)[0]
seed=seed.replace("000000000050',now(),","000000000050',clock_timestamp()-interval '58 seconds',")
seed=seed.replace("SELECT public.fn_tournament_management_readiness_for_row", """UPDATE public.tournaments SET accelerated_mtt=true,late_reg_levels=0,late_reg_mins=1
WHERE id='e1000000-0000-4000-8000-000000000001';
SELECT public.fn_tournament_management_readiness_for_row""")
setup='\n'.join((d/x).read_text() for x in ['native-maintenance-supplement.sql','clock-duration.sql','clock-epochs.sql'])
sql='BEGIN;\n'+setup+'\nCOMMIT;\n'+seed+r"""
DO $proof$
DECLARE tid uuid:='e1000000-0000-4000-8000-000000000001';
 gen uuid:='e1000000-0000-4000-8000-000000000051';
 eid uuid:='c1000000-0000-4000-8000-000000000001';
 op uuid:='c1000000-0000-4000-8000-000000000011';
 a timestamptz;r jsonb;s jsonb;close_result jsonb;
 checks jsonb:='[]'; caught boolean;
BEGIN
 SELECT started_at INTO a FROM public.tournaments WHERE id=tid;
 r:=smarter_private.fn_ca_clock_admit_epoch(tid,eid,op,gen,0,a);
 IF r IS NULL OR (r->>'entry_closed')::boolean OR (r->>'accelerated')::boolean
 OR (r->>'raw_duration_micros')::bigint<>180000000
 OR (r->>'duration_micros')::bigint<>180000000 THEN
 RAISE EXCEPTION 'open epoch admission %',r; END IF;
 checks:=checks||'"open admission freezes raw duration"';
 PERFORM pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (a+interval '60.05 seconds'-clock_timestamp()))));
 close_result:=public.fn_close_tournament_entry_window(tid,'clock.native.epoch-proof');
 IF NOT (SELECT prize_pool_finalized FROM public.tournaments WHERE id=tid) THEN
 RAISE EXCEPTION 'actual closure owner did not finalize %',close_result; END IF;
 s:=smarter_private.fn_ca_clock_epoch_state(eid);
 IF s IS DISTINCT FROM r THEN RAISE EXCEPTION 'midlevel closure repriced epoch';END IF;
 checks:=checks||'"actual entry closure midlevel preserves duration"';
 s:=smarter_private.fn_ca_clock_admit_epoch(tid,eid,op,gen,0,a);
 IF s IS DISTINCT FROM r THEN RAISE EXCEPTION 'immutable admission replay changed';END IF;
 checks:=checks||'"replay after closure returns original admission"';
 s:=smarter_private.fn_ca_clock_admit_epoch(tid,
 'c1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000012',gen,1,a+interval '3 minutes');
 IF NOT (s->>'entry_closed')::boolean OR NOT (s->>'accelerated')::boolean
 OR (s->>'duration_micros')::bigint<>120000000
 OR (s->>'raw_duration_micros')::bigint<>180000000 THEN
 RAISE EXCEPTION 'next admission does not accelerate once %',s;END IF;
 checks:=checks||'"next epoch freezes accelerated effective duration once"';
 UPDATE public.tournaments SET accelerated_mtt=false,
 blind_structure='[{"level":1,"smallBlind":10,"bigBlind":20,"durationMinutes":17.9}]' WHERE id=tid;
 IF smarter_private.fn_ca_clock_epoch_state(eid) IS DISTINCT FROM r THEN
 RAISE EXCEPTION 'config change repriced epoch';END IF;
 checks:=checks||'"later config changes do not reprice stored epoch"';
 IF smarter_private.fn_ca_clock_admit_epoch(tid,eid,op,gen,0,a) IS DISTINCT FROM r THEN
 RAISE EXCEPTION 'config change affected original replay';END IF;
 checks:=checks||'"immutable replay precedes config recomputation"';
 caught:=false;
 BEGIN UPDATE smarter_private.ca_clock_epochs SET duration_micros=1 WHERE epoch_id=eid;
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=SQLERRM='CLOCK_EPOCH_IS_IMMUTABLE';END;
 IF NOT caught THEN RAISE EXCEPTION 'epoch update admitted';END IF;
 checks:=checks||'"epoch update refused"';
 caught:=false;
 BEGIN DELETE FROM smarter_private.ca_clock_epochs WHERE epoch_id=eid;
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=SQLERRM='CLOCK_EPOCH_IS_IMMUTABLE';END;
 IF NOT caught THEN RAISE EXCEPTION 'epoch delete admitted';END IF;
 checks:=checks||'"epoch delete refused"';
 caught:=false;
 BEGIN PERFORM smarter_private.fn_ca_clock_admit_epoch(tid,eid,op,gen,0,a+interval '1 microsecond');
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=SQLERRM='CLOCK_EPOCH_REPLAY_MISMATCH';END;
 IF NOT caught THEN RAISE EXCEPTION 'different operation payload replayed';END IF;
 checks:=checks||'"changed canonical instant refuses replay"';
 PERFORM set_config('TimeZone','America/New_York',true);
 IF smarter_private.fn_ca_clock_admit_epoch(tid,eid,op,gen,0,a) IS DISTINCT FROM r THEN
 RAISE EXCEPTION 'equivalent timestamp timezone changed identity';END IF;
 checks:=checks||'"timestamp identity and stored reply ignore caller timezone"';
 UPDATE public.engine_tournament_leases SET lease_generation='c1000000-0000-4000-8000-000000000099',heartbeat_at=clock_timestamp() WHERE tournament_id=tid;
 IF smarter_private.fn_ca_clock_epoch_state(eid) IS DISTINCT FROM r THEN
 RAISE EXCEPTION 'replacement reader repriced epoch';END IF;
 checks:=checks||'"replacement generation readback retains immutable creation facts"';
 caught:=false;
 BEGIN PERFORM smarter_private.fn_ca_clock_admit_epoch(tid,eid,op,gen,0,a);
 EXCEPTION WHEN SQLSTATE '40001' THEN caught:=SQLERRM='CLOCK_LEASE_EXPIRED_AFTER_WAIT';END;
 IF NOT caught THEN RAISE EXCEPTION 'retired generation replay acquired write authority';END IF;
 checks:=checks||'"retired generation cannot reuse original write authority"';
 IF has_function_privilege('service_role','smarter_private.fn_ca_clock_admit_epoch(uuid,uuid,uuid,uuid,integer,timestamp with time zone)','EXECUTE')
 OR has_table_privilege('service_role','smarter_private.ca_clock_epochs','INSERT') THEN
 RAISE EXCEPTION 'private epoch authority exposed';END IF;
 checks:=checks||'"service cannot call private admission or write epoch rows"';
 PERFORM set_config('clock.proof_results',checks::text,true);
END $proof$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT current_setting('clock.proof_results');
ROLLBACK;
"""
# All prospective DDL, fixture launch, closure and assertions roll back together.
sql=sql.replace('BEGIN;\n'+setup+'\nCOMMIT;\nBEGIN;','BEGIN;\n'+setup+'\n')
out=q(sql)
checks=json.loads(out.splitlines()[-1])
evidence={'scope':'Immutable epoch component only; no activation, table publication, local pause or thaw composition yet',
'cases':checks,'passed':len(checks),'production_writes':False,
'fixture_limits':['satellite native fixture ba84a5b91 plus exact captured v3 maintenance supplement',
'explicit local Stage-B prerequisite, absent live','seven observed live disabled tournament guards remain disabled',
'fixture funding and direct generation fault injection are local component setup, not entry/claimant proof'],
'files':{str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [d/'clock-epochs.sql',d/'clock-duration.sql',d/'maintenance-source-capture.json',d/'native-maintenance-supplement.sql']}}
(d/'epoch-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps(evidence,indent=2))
