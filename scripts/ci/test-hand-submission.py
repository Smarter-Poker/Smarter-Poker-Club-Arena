#!/usr/bin/env python3
"""Original hand submission qualification using the maintained PG17 owner and real catalog."""
import argparse, datetime, hashlib, json, re, signal, sys
from pathlib import Path
from collections import Counter
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import compose, module, table_sql, exact_table_sql, lit, sha
MIGRATION=Path("supabase/migrations/20260918092329_retained_hand_submission_atomic_acknowledgement.sql")
DATA=Path("scripts/ci/fixtures/hand-submission")
PROBE=Path("scripts/ci/probes/hand-submission-native.sql")
SUCCESSOR_MIGRATION=Path("supabase/migrations/20260922022319_a_superseded_original_hands_off_its_retained_hand.sql")
SUPERSEDED_PROBE=Path("scripts/ci/probes/hand-submission-superseded.sql")

def private_snapshot(e,db,label):
    query="""CREATE FUNCTION pg_temp.private_elimination_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE r record;v jsonb;data jsonb:='{}'; BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace='smarter_private'::regnamespace AND c.relkind IN ('r','p') ORDER BY c.relname LOOP
     EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM smarter_private.%I t',r.relname) INTO v;
     data:=data||jsonb_build_object(r.relname,v);
    END LOOP;
    RETURN jsonb_build_object('data',data,
    'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE pronamespace='smarter_private'::regnamespace AND prokind='f'),
    'relations',(SELECT jsonb_agg(jsonb_build_array(relname,relkind,pg_get_userbyid(relowner),relacl,relrowsecurity,relforcerowsecurity) ORDER BY relname) FROM pg_class WHERE relnamespace='smarter_private'::regnamespace),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid::regtype::text,a.attnotnull,a.attacl,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='smarter_private'::regnamespace AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(conrelid::regclass::text,conname,pg_get_constraintdef(oid),convalidated) ORDER BY conrelid::regclass::text,conname) FROM pg_constraint WHERE connamespace='smarter_private'::regnamespace),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='smarter_private'::regnamespace),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(tgrelid::regclass::text,tgname,pg_get_triggerdef(t.oid),tgenabled) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='smarter_private'::regnamespace),
    'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='smarter_private'));
    END $$; SELECT pg_temp.private_elimination_snapshot();"""
    _,out,_=e.sql(db,query,label=label)
    return json.loads(out.strip())


def signature(row):
    s=row["signature"]
    return s if "." in s.split("(")[0] else "public."+s

def captured_function(row):
    s=signature(row)
    output=row["definition"].rstrip().rstrip(";")+";\nALTER FUNCTION "+s+" OWNER TO postgres;\n"
    output+="REVOKE ALL ON FUNCTION "+s+" FROM PUBLIC,anon,authenticated,service_role;\n"
    for item in row["acl"].strip("{}").split(","):
        role,access=item.split("=")
        if "*" in access:raise ValueError("unexpected grant option")
        if "X" not in access.split("/")[0]:raise ValueError("unexpected function ACL")
        output+="GRANT EXECUTE ON FUNCTION "+s+" TO "+(role or "PUBLIC")+";\n"
    output+="DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid="+lit(s)+"::regprocedure AND md5(pg_get_functiondef(oid))="+lit(row["definition_md5"])+" AND proowner='postgres'::regrole AND proacl::text="+lit(row["acl"])+") THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;\n"
    return output

def prepare(root,out):
    m=compose(root)
    (out/"foundation.sql").write_text(m.pop("sql"));m.pop("entry_sql")
    builder=module(root/"scripts/ci/build-hand-submission-migration.py","hand_submission_builder")
    if builder.render()!=(root/MIGRATION).read_text():raise ValueError("generated migration differs")
    captures={p.name:json.loads(p.read_text())["capture"] for p in (root/DATA).glob("*.json")}
    # Real empty receipt catalog closure, not replacement financial functions.
    tables=captures["current-f06-tables-20260918.json"]["tables"]+captures["current-snapshots-20260918.json"]["tables"]+captures["current-outbox-20260918.json"]["tables"]+captures["current-postcommit-tables-20260918.json"]["tables"]+captures["current-cash-lease-20260918.json"]["tables"]
    functions=[]
    for name in ["current-hand-insert-20260918.json","current-outbox-dependencies-20260918.json","current-disposition-dependencies-20260918.json","current-f06-20260918.json","current-stack-authority-20260918.json","current-lease-policy-20260918.json","current-authorities-20260918.json","current-handoff-owners-20260918.json","current-lease-claims-20260918.json","current-handoff-locks-20260918.json","current-maintenance-boundary-20260918.json"]:
        functions+=captures[name]["functions"]
    # Load and verify the captured predecessor first, then the exact installed
    # no-start successor. Never silently replace historical capture bytes.
    tables+=captures["current-no-start-successor-20260918.json"]["tables"]
    functions+=captures["current-no-start-successor-20260918.json"]["functions"]
    functions+=captures["current-cash-postcommit-20260918.json"]["functions"]
    sql="BEGIN;\n"
    for t in tables:
        row=dict(t);schema=row.pop("schema","public")
        deferred=[c for c in row["constraints"] or [] if not c["validated"]]
        if any(c["type"]!="c" or not c["definition"].endswith(" NOT VALID") for c in deferred):
            raise ValueError("unsupported unvalidated capture")
        row["constraints"]=[c for c in row["constraints"] or [] if c["validated"]]
        sql+=table_sql(row).replace('public."'+t["name"]+'"',schema+'."'+t["name"]+'"')+"\n"
        for c in deferred:
            sql+="ALTER TABLE "+schema+"."+t["name"]+" ADD CONSTRAINT "+c["name"]+" "+c["definition"]+";\n"
    # Actual current cash provenance owner is invoked by every accepted-hand core.
    cash=(root/"supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql").read_text()
    a=cash.index("CREATE TABLE public.cash_participant_funding_receipts")
    b=cash.index("-- Invoked only by the original private funding cores")
    sql+=cash[a:b]
    a=cash.index("CREATE FUNCTION public.fn_cash_accept_hand_provenance")
    b=cash.index(";",cash.index("REVOKE ALL ON FUNCTION public.fn_cash_accept_hand_provenance",a))+1
    sql+=cash[a:b]
    for r in functions:sql+=captured_function(r)
    for trigger in captures["current-lease-claims-20260918.json"]["triggers"]:
        sql+=trigger["definition"]+";\n"
    for t in tables:
        schema=t.get("schema","public")
        for c in t["constraints"] or []:
            if c["type"]=="f":
                sql+="ALTER TABLE "+schema+"."+t["name"]+" ADD CONSTRAINT "+c["name"]+" "+c["definition"]+";\n"
        for trigger in t["triggers"] or []:
            if trigger["enabled"]!="O":raise ValueError("unexpected trigger state")
            sql+=trigger["definition"]+";\n"
        row=dict(t);row.pop("schema",None)
        sql+=exact_table_sql(row).replace("public."+t["name"],schema+"."+t["name"])
    money=json.loads((root/"scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json").read_text())
    for r in money["functions"]:
        row=dict(r)
        row["acl"]="{"+",".join(g["role"]+"=X/"+g["grantor"] for g in r["grants"])+"}"
        sql+=captured_function(row)
    sql+="CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();\n"
    sql+="COMMIT;\n"
    (out/"current-authorities.sql").write_text(sql)
    # Reuse the exact existing hand fixture opening and payload builders.
    source=(root/"scripts/ci/probes/atomic-tournament-hand-boundary.sql").read_text()
    opening=source[:source.index("-- Matching zeroes are data")].replace("SET LOCAL session_replication_role = origin;","")
    opening=opening.replace("BEGIN;","",1)
    opening=opening.replace("time_bank_uses_remaining,time_bank_remaining)","time_bank_uses_remaining,time_bank_remaining,active_game_scope,active_parent_key)")
    opening=opening.replace("'20000000-0000-0000-0000-000000000001',4,30)","'20000000-0000-0000-0000-000000000001',4,30,'table:86100000-0000-0000-0000-000000000001','tournament:86000000-0000-0000-0000-000000000001')")
    table_end=opening.index("INSERT INTO public.tournament_players")
    opening=opening[:table_end]+"""UPDATE public.tables SET seat_game_scope='table:'||id::text,
 seat_admission_key='tournament:'||tournament_id::text
 WHERE id='86100000-0000-0000-0000-000000000001';
""" + opening[table_end:]
    helpers=source[source.index("CREATE FUNCTION pg_temp.atomic_hand_stacks()"):source.index("CREATE FUNCTION pg_temp.commit_atomic_hand()")]
    for uid,index,second in [("10000000-0000-0000-0000-000000000001",1,"00"),("10000000-0000-0000-0000-000000000002",2,"01")]:
        # Both exact seat generations in stacks and time-bank obligations.
        anchor="'user_id','"+uid+"'"
        parts=helpers.split("CREATE FUNCTION pg_temp.atomic_hand_row()")
        parts[0]=parts[0].replace(anchor,"'seat_id','86300000-0000-0000-0000-00000000000"+str(index)+"','seat_joined_at','2026-09-08T12:00:"+second+"+00:00',"+anchor)
        middle,obligations=parts[1].split("CREATE FUNCTION pg_temp.atomic_hand_obligations()")
        obligations=obligations.replace(anchor,"'seat_id','86300000-0000-0000-0000-00000000000"+str(index)+"','seat_joined_at','2026-09-08T12:00:"+second+"+00:00',"+anchor)
        helpers=parts[0]+"CREATE FUNCTION pg_temp.atomic_hand_row()"+middle+"CREATE FUNCTION pg_temp.atomic_hand_obligations()"+obligations
    (out/"opening.sql").write_text(opening+"\nSET LOCAL session_replication_role = origin;\n"+helpers)
    paths=[Path(__file__).relative_to(root),MIGRATION,PROBE,SUCCESSOR_MIGRATION,SUPERSEDED_PROBE,Path("scripts/ci/build-hand-submission-migration.py"),Path("scripts/ci/probes/hand-submission-authority.sql"),Path("scripts/ci/probes/hand-submission-disposition.spec"),Path("scripts/ci/probes/hand-submission-successor.sql"),Path("scripts/ci/probes/hand-submission-owner.spec"),Path("scripts/ci/probes/hand-submission-maintenance.spec"),Path("scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json"),Path("scripts/ci/test-mtt-unlimited.py"),Path("scripts/ci/probes/atomic-tournament-hand-boundary.sql"),Path("scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql"),Path("supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql")]+[p.relative_to(root) for p in (root/DATA).glob("*.json")]
    m["source_sha256"].update({str(p):sha(root/p) for p in paths})
    (out/"source-manifest.json").write_text(json.dumps(m,indent=2)+"\n")
    return m

def qualify_fences(e,root,db,native):
    binary=native.stock_isolationtester(e.pg)
    e.report['isolationtester']={'path':str(binary),'sha256':sha(binary)}
    spec=(root/'scripts/ci/probes/hand-submission-disposition.spec').read_text()
    probe=(root/PROBE).read_text()
    probe=probe[:probe.index('DO $cash_successor$')]+probe[probe.index('END $cash_successor$;')+len('END $cash_successor$;'):]
    seed="BEGIN; CREATE SCHEMA hand_submission_native;\n"+(e.output/'opening.sql').read_text()+probe[:probe.index('DO $retained$')]+"COMMIT;"
    seed=seed.replace('pg_temp.','hand_submission_native.')
    retain="PERFORM public.fn_ca_retain_hand_submission(hand_submission_native.submission_request());"
    close="PERFORM public.complete_hand_snapshot('86100000-0000-0000-0000-000000000001',8600001);"
    abort="UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=permit_id WHERE permit_id='86600000-0000-0000-0000-000000000001';"
    for operation in ('snapshot','permit'):
      for first in ('retention','disposition'):
       for finish in ('COMMIT','ROLLBACK'):
        for isolation in ('READ COMMITTED','REPEATABLE READ'):
         label='fence-'+operation+'-'+first+'-'+finish.lower()+'-'+isolation.lower().replace(' ','-')
         case=e.database(db)
         e.sql(case,seed,label=label+'-opening')
         disposal=close if operation=='snapshot' else abort
         a,b=(retain,disposal) if first=='retention' else (disposal,retain)
         failure="NULL" if finish=='ROLLBACK' else "'40001'" if isolation=='REPEATABLE READ' else "'55000'"
         winner=first if finish=='COMMIT' else ('disposition' if first=='retention' else 'retention')
         rendered=spec.replace('A_OPERATION','DO $$ BEGIN '+a+' END $$;').replace('B_OPERATION',b).replace('A_FINISH',finish).replace('ISOLATION_KIND',isolation).replace('EXPECTED_FAILURE',failure).replace('FINAL_DISPOSITION',"'retained'" if winner=='retention' else "'disposed'").replace('FINAL_SUBMISSIONS','1' if winner=='retention' else '0')
         code,out,err=e.run(label,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered,seconds=25,check=False)
         steps=Counter(re.findall(r'^step ([a-z_]+):',out,re.M))
         expected=Counter({'a_begin':1,'b_begin':1,'b_snapshot':1,'a_write':1,'b_write':2,'observed_wait':1,'a_finish':1,'b_commit':1,'final_state':1})
         notices=re.findall(r'NOTICE:\s*(SUBMISSION_RACE_[A-Z_]+)',out+'\n'+err)
         if code or err.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',out,re.M) or steps!=expected or out.count('<waiting ...>')!=1 or out.count('<... completed>')!=1 or notices!=['SUBMISSION_RACE_WAIT_PROVEN','SUBMISSION_RACE_OUTCOME_PROVEN','SUBMISSION_RACE_FINAL_PROVEN']:
          raise RuntimeError('exact disposition race failed: '+label)
         e.discard(case)
         e.report['races'].append({'case':label,'observed_wait':True,'exact_outcome':True,'database_removed':True})

def qualify_owners(e,root,db,native):
    binary=native.stock_isolationtester(e.pg)
    spec=(root/'scripts/ci/probes/hand-submission-owner.spec').read_text()
    probe=(root/PROBE).read_text()
    probe=probe[:probe.index('DO $cash_successor$')]+probe[probe.index('END $cash_successor$;')+len('END $cash_successor$;'):]
    opening="BEGIN; CREATE SCHEMA hand_submission_native;\n"+(e.output/'opening.sql').read_text()+probe[:probe.index('DO $retained$')]
    retain="SELECT public.fn_ca_retain_hand_submission(hand_submission_native.submission_request());"
    resume="public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002')"
    claim="public.claim_tournament_lease_v2('86000000-0000-0000-0000-000000000001','successor-one',NULL,'86500000-0000-0000-0000-000000000002',30)"
    authority="SET request.jwt.claim.role='service_role'; SET app.smarter_data_actor='tournament-manager'; SET app.smarter_tournament_id='86000000-0000-0000-0000-000000000001'; SET app.smarter_tournament_lease_generation='86500000-0000-0000-0000-000000000002';"
    for operation in ('handoff','claim','maintenance'):
      for finish in ('COMMIT','ROLLBACK'):
        label='owner-'+operation+'-'+finish.lower();case=e.database(db)
        seed=opening
        if operation in ('handoff','maintenance'):
            seed+=retain+probe[probe.index('CREATE FUNCTION pg_temp.submission_fault()'):probe.index('DO $refusal$')]
            seed+="SELECT pg_temp.commit_submission(); DROP TRIGGER zz_submission_fault ON public.hand_projection_outbox;"
            seed+="UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp() WHERE tournament_id='86000000-0000-0000-0000-000000000001';"
            a="DO $$ DECLARE r jsonb; BEGIN r:="+resume+"; IF r->>'completed' IS DISTINCT FROM 'true' OR r->>'financial_handoff' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'first handoff did not complete: %',r; END IF; END $$;"
            b="DO $$ DECLARE r jsonb; BEGIN r:="+resume+"; IF r->>'completed' IS DISTINCT FROM 'true' OR r->>'financial_handoff' IS DISTINCT FROM '"+('false' if finish=='COMMIT' else 'true')+"' THEN RAISE EXCEPTION 'contending handoff outcome differs: %',r; END IF; RAISE NOTICE 'SUBMISSION_OWNER_OUTCOME_PROVEN'; END $$;"
            boundary='SELECT 1;'
            checks="(SELECT count(*) FROM smarter_private.hand_submission_handoffs)<>1 OR (SELECT count(*) FROM smarter_private.hand_submission_handoff_results)<>1 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001' AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE permit_id='86600000-0000-0000-0000-000000000001' AND state='accepted') OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch)"
            if operation=='maintenance':
                b="DO $$ BEGIN "+maintenance_insert()+" IF NOT public.fn_platform_frozen() THEN RAISE EXCEPTION 'maintenance writer did not freeze'; END IF; RAISE NOTICE 'SUBMISSION_OWNER_OUTCOME_PROVEN'; END $$;"
                checks="NOT public.fn_platform_frozen() OR (SELECT count(*) FROM smarter_private.hand_submission_handoffs)<>"+('1' if finish=='COMMIT' else '0')+" OR (SELECT count(*) FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')<>"+('1' if finish=='COMMIT' else '0')+" OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch)"
        else:
            a=retain
            # A real concurrent non-key heartbeat write remains possible; this
            # fixture advances its timestamp to the stale side without waiting
            # thirty seconds. The actual claimant then must wait for A's KEY
            # SHARE, not for the already-committed timestamp fixture writer.
            boundary="UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '1 hour' WHERE tournament_id='86000000-0000-0000-0000-000000000001';"
            b="DO $$ DECLARE r record; BEGIN SELECT * INTO r FROM "+claim+"; IF r.granted IS DISTINCT FROM true OR r.lease_generation IS DISTINCT FROM '86500000-0000-0000-0000-000000000002'::uuid THEN RAISE EXCEPTION 'actual claimant did not acquire'; END IF; RAISE NOTICE 'SUBMISSION_OWNER_OUTCOME_PROVEN'; END $$;"
            checks="(SELECT count(*) FROM smarter_private.hand_submissions)<>"+('1' if finish=='COMMIT' else '0')+" OR NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id='86000000-0000-0000-0000-000000000001' AND lease_generation='86500000-0000-0000-0000-000000000002') OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')"
        e.sql(case,(seed+"COMMIT;").replace('pg_temp.','hand_submission_native.'),label=label+'-opening')
        final="DO $$ BEGIN IF "+checks+" THEN RAISE EXCEPTION 'SUBMISSION_OWNER_FINAL_CHANGED'; END IF; RAISE NOTICE 'SUBMISSION_OWNER_FINAL_PROVEN'; END $$;"
        rendered=spec.replace('AUTHORITY',authority).replace('A_OPERATION',a).replace('B_OPERATION',b).replace('A_FINISH',finish).replace('FIXTURE_BOUNDARY',boundary).replace('FINAL_STATE',final)
        code,out,err=e.run(label,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered,seconds=25,check=False)
        expected=Counter({'a_begin':1,'b_begin':1,'a_write':1,'fixture_boundary':1,'b_write':2,'observed_wait':1,'a_finish':1,'b_commit':1,'final_state':1})
        notices=re.findall(r'NOTICE:\s*(SUBMISSION_OWNER_[A-Z_]+)',out+'\n'+err)
        if code or err.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',out,re.M) or Counter(re.findall(r'^step ([a-z_]+):',out,re.M))!=expected or out.count('<waiting ...>')!=1 or out.count('<... completed>')!=1 or notices!=['SUBMISSION_OWNER_WAIT_PROVEN','SUBMISSION_OWNER_OUTCOME_PROVEN','SUBMISSION_OWNER_FINAL_PROVEN']:
            raise RuntimeError('exact owner race failed: '+label)
        e.discard(case);e.report['races'].append({'case':label,'observed_wait':True,'exact_outcome':True,'database_removed':True})

def maintenance_insert():
    return "INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token) VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'86800000-0000-0000-0000-000000000001');"

def qualify_maintenance_first(e,root,db,native):
    binary=native.stock_isolationtester(e.pg)
    spec=(root/'scripts/ci/probes/hand-submission-maintenance.spec').read_text()
    probe=(root/PROBE).read_text()
    probe=probe[:probe.index('DO $cash_successor$')]+probe[probe.index('END $cash_successor$;')+len('END $cash_successor$;'):]
    opening="BEGIN; CREATE SCHEMA hand_submission_native;\n"+(e.output/'opening.sql').read_text()+probe[:probe.index('DO $retained$')]
    opening+="SELECT public.fn_ca_retain_hand_submission(pg_temp.submission_request());"
    opening+=probe[probe.index('CREATE FUNCTION pg_temp.submission_fault()'):probe.index('DO $refusal$')]
    opening+="SELECT pg_temp.commit_submission(); DROP TRIGGER zz_submission_fault ON public.hand_projection_outbox;"
    opening+="UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp() WHERE tournament_id='86000000-0000-0000-0000-000000000001'; COMMIT;"
    resume="public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002')"
    for finish in ('COMMIT','ROLLBACK'):
        label='maintenance-first-'+finish.lower();case=e.database(db)
        e.sql(case,opening.replace('pg_temp.','hand_submission_native.'),label=label+'-opening')
        final="DO $$ DECLARE r jsonb; refused boolean:=false; BEGIN BEGIN r:="+resume+"; EXCEPTION WHEN SQLSTATE '55000' THEN refused:=SQLERRM='HAND_SUBMISSION_PLATFORM_FROZEN'; END; IF "
        if finish=='COMMIT':
            final+="NOT refused OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)"
        else:
            final+="refused OR r->>'completed' IS DISTINCT FROM 'true' OR (SELECT count(*) FROM smarter_private.hand_submission_handoffs)<>1"
        final+=" OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch) THEN RAISE EXCEPTION 'SUBMISSION_MAINTENANCE_FINAL_UNPROVEN'; END IF; RAISE NOTICE 'SUBMISSION_MAINTENANCE_FINAL_PROVEN'; END $$;"
        rendered=spec.replace('MAINTENANCE_WRITE',maintenance_insert()).replace('RESUME_CALL',resume).replace('A_FINISH',finish).replace('FINAL_STATE',final)
        code,out,err=e.run(label,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered,seconds=25,check=False)
        expected=Counter({'a_begin':1,'b_begin':1,'a_write':1,'observed_owner':1,'b_refuse':1,'b_commit':1,'a_finish':1,'final_state':1})
        notices=re.findall(r'NOTICE:\s*(SUBMISSION_MAINTENANCE_[A-Z_]+)',out+'\n'+err)
        if code or err.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',out,re.M) or Counter(re.findall(r'^step ([a-z_]+):',out,re.M))!=expected or '<waiting ...>' in out or notices!=['SUBMISSION_MAINTENANCE_OWNER_PROVEN','SUBMISSION_MAINTENANCE_REFUSAL_PROVEN','SUBMISSION_MAINTENANCE_FINAL_PROVEN']:
            raise RuntimeError('exact maintenance-first race failed: '+label)
        e.discard(case);e.report['races'].append({'case':label,'observed_exclusive_owner':True,'exact_outcome':True,'database_removed':True})

def superseded_opening(e,root):
    probe=(root/PROBE).read_text()
    probe=probe[:probe.index('DO $cash_successor$')]+probe[probe.index('END $cash_successor$;')+len('END $cash_successor$;'):]
    return (e.output/'opening.sql').read_text()+probe[:probe.index('DO $retained$')]

def qualify_superseded(e,root,db):
    # Production recorded 69 retained originals whose own lease proof expired
    # before dispatch. The candidate installs over the qualified journal and a
    # replay is refused by its own pins.
    e.sql(db,file=root/SUCCESSOR_MIGRATION,label="superseded-successor-install")
    code,_,err=e.sql(db,file=root/SUCCESSOR_MIGRATION,label="superseded-successor-replay",check=False)
    if code==0 or 'HAND_SUBMISSION_SUCCESSOR_DRIFT' not in err:
        raise RuntimeError('installed successor replay was not refused')
    before=e.snapshot(db,"superseded-before-data");catalog=e.catalog_snapshot(db,"superseded-before-catalog");private=private_snapshot(e,db,"superseded-before-private")
    probe="BEGIN;\n"+superseded_opening(e,root)+(root/SUPERSEDED_PROBE).read_text()+"\nROLLBACK;\n"
    path=e.output/"superseded-probe.sql";path.write_text(probe)
    code,stdout,stderr=e.sql(db,file=path,label="superseded-original-handoff",check=False,seconds=120)
    e.report.update(superseded_output=stdout,superseded_errors=stderr)
    if code or any(x in stderr for x in ["ERROR:","FATAL:","PANIC:","WARNING:"]):raise RuntimeError("superseded original probe failed")
    if stdout.splitlines().count("HAND_SUBMISSION_SUPERSEDED_PASS")!=1:raise RuntimeError("superseded completion marker missing")
    if before!=e.snapshot(db,"superseded-after-data") or catalog!=e.catalog_snapshot(db,"superseded-after-catalog") or private!=private_snapshot(e,db,"superseded-after-private"):raise RuntimeError("superseded rollback differs")
    count=len(re.findall(r"HAND SUBMISSION PASS: superseded: ",stderr))
    e.report.update(superseded_assertions=count)
    if count!=14:raise RuntimeError("superseded assertion count differs: "+str(count))

def qualify_superseded_race(e,root,db,native):
    # The original's settlement is in flight holding the lease KEY SHARE and
    # this hand's submission lock. The successor's real claim waits for it; a
    # landed original is acknowledged, a rolled-back one is handed off once.
    binary=native.stock_isolationtester(e.pg)
    spec=(root/'scripts/ci/probes/hand-submission-owner.spec').read_text()
    opening="BEGIN; CREATE SCHEMA hand_submission_native;\n"+superseded_opening(e,root)
    opening+="SELECT public.fn_ca_retain_hand_submission(pg_temp.submission_request());"
    opening+="UPDATE public.tables SET lifecycle=NULL WHERE id='86100000-0000-0000-0000-000000000001'; COMMIT;"
    authority="SET request.jwt.claim.role='service_role'; SET app.smarter_data_actor='tournament-manager'; SET app.smarter_tournament_id='86000000-0000-0000-0000-000000000001'; SET app.smarter_tournament_lease_generation='86500000-0000-0000-0000-000000000002';"
    original="SET app.smarter_tournament_lease_generation='86500000-0000-0000-0000-000000000001'; SELECT public.fn_ca_commit_hand_submission('86400000-0000-0000-0000-000000000001','atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001');"
    claim="public.claim_tournament_lease_v2('86000000-0000-0000-0000-000000000001','successor-one',NULL,'86500000-0000-0000-0000-000000000002',30)"
    resume="public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002')"
    boundary="UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '1 hour' WHERE tournament_id='86000000-0000-0000-0000-000000000001';"
    for finish in ('COMMIT','ROLLBACK'):
        label='superseded-original-in-flight-'+finish.lower();case=e.database(db)
        e.sql(case,opening.replace('pg_temp.','hand_submission_native.'),label=label+'-opening')
        handoff='false' if finish=='COMMIT' else 'true'
        b="DO $$ DECLARE c record; r jsonb; BEGIN SELECT * INTO c FROM "+claim+"; IF c.granted IS DISTINCT FROM true THEN RAISE EXCEPTION 'successor did not acquire'; END IF; r:="+resume+"; IF r->>'completed' IS DISTINCT FROM 'true' OR r->>'financial_handoff' IS DISTINCT FROM '"+handoff+"' THEN RAISE EXCEPTION 'superseded outcome differs: %',r; END IF; RAISE NOTICE 'SUBMISSION_OWNER_OUTCOME_PROVEN'; END $$;"
        checks="(SELECT count(*) FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001' AND hand_id='86400000-0000-0000-0000-000000000001' AND post_commit_result->>'ok'='true')<>1"
        checks+=" OR (SELECT count(*) FROM public.hand_history WHERE table_id='86100000-0000-0000-0000-000000000001')<>1"
        checks+=" OR (SELECT sum(stack) FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001')<>20"
        checks+=" OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE permit_id='86600000-0000-0000-0000-000000000001' AND state='accepted')"
        checks+=" OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch) OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures)"
        if finish=='COMMIT':
            checks+=" OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)"
        else:
            checks+=" OR (SELECT count(*) FROM smarter_private.hand_submission_handoffs WHERE original_generation='86500000-0000-0000-0000-000000000001' AND lease_generation='86500000-0000-0000-0000-000000000002')<>1"
            checks+=" OR (SELECT count(*) FROM smarter_private.hand_submission_handoff_results WHERE result->>'handoff_evidence'='superseded_generation')<>1"
        final="DO $$ BEGIN IF "+checks+" THEN RAISE EXCEPTION 'SUBMISSION_OWNER_FINAL_CHANGED'; END IF; RAISE NOTICE 'SUBMISSION_OWNER_FINAL_PROVEN'; END $$;"
        rendered=spec.replace('AUTHORITY',authority).replace('A_OPERATION',original).replace('B_OPERATION',b).replace('A_FINISH',finish).replace('FIXTURE_BOUNDARY',boundary).replace('FINAL_STATE',final)
        code,out,err=e.run(label,[binary,f'host={e.socket} port={e.port} dbname={case} user=postgres'],text=rendered,seconds=25,check=False)
        expected=Counter({'a_begin':1,'b_begin':1,'a_write':1,'fixture_boundary':1,'b_write':2,'observed_wait':1,'a_finish':1,'b_commit':1,'final_state':1})
        notices=re.findall(r'NOTICE:\s*(SUBMISSION_OWNER_[A-Z_]+)',out+'\n'+err)
        if code or err.strip() or re.search(r'^(?:[a-z_]+: )?(ERROR|FATAL|PANIC|WARNING):',out,re.M) or Counter(re.findall(r'^step ([a-z_]+):',out,re.M))!=expected or out.count('<waiting ...>')!=1 or out.count('<... completed>')!=1 or notices!=['SUBMISSION_OWNER_WAIT_PROVEN','SUBMISSION_OWNER_OUTCOME_PROVEN','SUBMISSION_OWNER_FINAL_PROVEN']:
            raise RuntimeError('exact superseded race failed: '+label)
        e.discard(case);e.report['races'].append({'case':label,'observed_wait':True,'exact_outcome':True,'database_removed':True})

def qualify_installation(e,root,db):
    e.report['installation_refusals']=[]
    signature='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
    for label,mutation,error in [
        ('body-config','ALTER FUNCTION '+signature+' SET search_path TO pg_catalog;','HAND_SUBMISSION_AUTHORITY_DRIFT'),
        ('acl','GRANT EXECUTE ON FUNCTION '+signature+' TO anon;','HAND_SUBMISSION_AUTHORITY_DRIFT'),
        ('trigger','ALTER TABLE public.engine_maintenance_break DISABLE TRIGGER aa_serialize_maintenance_break_write;','HAND_SUBMISSION_TRIGGER_DRIFT'),
    ]:
        child=e.database(db)
        e.sql(child,mutation,label='drift-'+label)
        before=e.catalog_snapshot(child,'drift-'+label+'-before')
        private=private_snapshot(e,child,'drift-'+label+'-private-before')
        code,out,err=e.sql(child,file=root/MIGRATION,label='refuse-'+label,check=False)
        if code==0 or error not in err:raise RuntimeError('installation drift not refused: '+label)
        if before!=e.catalog_snapshot(child,'drift-'+label+'-after') or private!=private_snapshot(e,child,'drift-'+label+'-private-after'):
            raise RuntimeError('installation refusal changed catalog: '+label)
        e.report['installation_refusals'].append({'case':label,'expected_refusal':True,'catalog_rollback':True})
        e.discard(child)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--evidence",type=Path,required=True);p.add_argument("--pg-bin",type=Path,required=True)
    args=p.parse_args();root=Path(__file__).resolve().parents[2];out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
    m=prepare(root,out);native=module(root/"scripts/ci/test-mtt-unlimited.py","hand_submission_execution")
    e=native.Execution(root,out,args.pg_bin.resolve(),out,600)
    e.report.update(source_sha256=m["source_sha256"])
    for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,native.interrupted)
    try:
        e.start();db=e.database()
        e.sql(db,file=out/"foundation.sql",label="real-financial-foundation",seconds=180)
        e.sql(db,file=out/"current-authorities.sql",label="current-hand-authority-closure")
        e.sql(db,file=root/"scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql",label="existing-structural-opening")
        qualify_installation(e,root,db)
        e.sql(db,file=root/MIGRATION,label="submission-candidate-install")
        code,_,err=e.sql(db,file=root/MIGRATION,label="submission-install-replay",check=False)
        if code==0 or 'HAND_SUBMISSION_AUTHORITY_DRIFT' not in err:
            raise RuntimeError('installed source replay was not refused')
        query="""SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'body_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(proowner),'acl',proacl,'config',proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.proname LIKE '%hand_submission%' OR p.proname IN ('f06_retained_submission_guard','hand_snapshot_completion_guard')),
        'triggers',(SELECT jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(t.oid),'enabled',tgenabled) ORDER BY tgname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname LIKE '%hand_submission%' OR p.proname IN ('f06_retained_submission_guard','hand_snapshot_completion_guard')));"""
        _,catalog,_=e.sql(db,query,label='installed-source-catalog')
        (out/'installed-source-catalog.json').write_text(json.dumps(json.loads(catalog),indent=2)+'\n')
        before=e.snapshot(db,"before-data");catalog=e.catalog_snapshot(db,"before-catalog");private=private_snapshot(e,db,"before-private")
        probe="BEGIN;\n"+(out/"opening.sql").read_text()+(root/PROBE).read_text()+"\nROLLBACK;\n"
        path=out/"probe.sql";path.write_text(probe)
        code,stdout,stderr=e.sql(db,file=path,label="actual-original-submission",check=False,seconds=120)
        e.report.update(case_output=stdout,case_errors=stderr)
        if code or any(x in stderr for x in ["ERROR:","FATAL:","PANIC:","WARNING:"]):raise RuntimeError("actual hand submission probe failed")
        if stdout.splitlines().count("HAND_SUBMISSION_NATIVE_PASS")!=1:raise RuntimeError("completion marker missing")
        if before!=e.snapshot(db,"after-data") or catalog!=e.catalog_snapshot(db,"after-catalog") or private!=private_snapshot(e,db,"after-private"):raise RuntimeError("full rollback differs")
        e.report.update(assertions=stderr.count("HAND SUBMISSION PASS:"),data_rollback=True,catalog_rollback=True,private_catalog_and_data_rollback=True)
        if stderr.count("HAND SUBMISSION PASS:")!=50:raise RuntimeError("exact assertion count differs")
        qualify_fences(e,root,db,native)
        qualify_owners(e,root,db,native)
        qualify_maintenance_first(e,root,db,native)
        qualify_superseded(e,root,db)
        qualify_superseded_race(e,root,db,native)
        qualify_owners(e,root,db,native)
        qualify_maintenance_first(e,root,db,native)
        for path,digest in m["source_sha256"].items():
            if sha(root/path)!=digest:raise RuntimeError("source changed: "+path)
        e.report["status"]="passed";e.discard(db)
    except BaseException as exc:e.report["failure"]=repr(exc)
    finally:
        for sig in native.CANCELLATION_SIGNALS:signal.signal(sig,signal.SIG_IGN)
        try:e.close()
        except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status="failed")
        e.report["ended_at"]=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out/"result.json").write_text(json.dumps(e.report,indent=2)+"\n")
        print(json.dumps({k:e.report.get(k) for k in ["status","failure","assertions","cleanup"]}),flush=True)
    return 0 if e.report["status"]=="passed" else 1
if __name__=="__main__":sys.exit(main())
