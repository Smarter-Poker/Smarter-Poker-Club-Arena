"""Finite PG17 directional totals and install guards, on a private socket only."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,time
import direction_totals_helpers as h
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[2]
FIXTURE=ROOT
OWN=None
MIGRATION=REPO/'supabase/migrations/20261010011934_cashier_totals_count_directional_ranges_without_rescanning.sql'
ROW='public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'
TOTAL='public.fn_cashier_statement_totals(uuid,timestamptz,timestamptz,jsonb)'
INDEX='public.idx_chip_ledger_cashier_direction_totals'

def sql(text,user='postgres',refusal=None):
    remaining=h.deadline-time.monotonic();assert remaining>0
    p=subprocess.run([str(h.PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(h.SOCKET),'-U',user,'-d','postgres'],input=text,text=True,capture_output=True,env={**h.ENV,'PGOPTIONS':'-c statement_timeout=8s'},timeout=min(150,remaining))
    if refusal is not None:
        assert p.returncode!=0 and refusal in p.stderr,'expected_refusal_missing'
        return {'refused':True,'stderrSHA256':hashlib.sha256(p.stderr.encode()).hexdigest()}
    if p.returncode:raise RuntimeError('isolated_sql_failed:'+hashlib.sha256(p.stderr.encode()).hexdigest())
    return p.stdout.strip()

def md5(sig):return sql("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))")
def authority():return sql("SELECT (to_jsonb(p)-'prosrc')::text FROM pg_proc p WHERE oid='"+ROW+"'::regprocedure")

def matrix(q):
    result={}
    for viewer,scope in [(1,'all'),(10,'downline'),(20,'self')]:
        for filters in ['{}','{"direction":"in"}','{"direction":"out"}','{"direction":"managed"}','{"wallet":"player"}','{"state":"posted"}','{"operation":"refund"}','{"counterparty":"Player Twenty"}','{"reference":"mirror-edge-1"}']:
            call=f"fn_cashier_statement_rows(u(100),u({viewer}),'{scope}','2026-09-01Z','2026-09-30Z','{filters}',NULL,NULL,NULL,"
            actual=q("SELECT coalesce(jsonb_object_agg(entry_direction,jsonb_build_array(entry_amount,entry->'count')),'{}') FROM "+call+"0)")
            expected=q("SELECT coalesce(jsonb_object_agg(entry_direction,jsonb_build_array(amount,n)),'{}') FROM (SELECT entry_direction,sum(entry_amount) amount,count(*) n FROM "+call+"NULL) GROUP BY entry_direction) x")
            assert actual==expected,'unlimited_row_oracle_mismatch'
            result[(viewer,scope,filters)]=actual
    return result

def main():
    global OWN
    import tempfile
    scratch=Path(os.environ.get('TMPDIR','/tmp')).resolve()
    if __import__('sys').platform=='darwin':
        assert Path('/Volumes/SmarterWork').is_mount() and scratch.is_relative_to('/Volumes/SmarterWork/agent-work')
    OWN=Path(tempfile.mkdtemp(prefix='cd-',dir=scratch))
    h.OWN=OWN;h.DATA=OWN/'data';h.SOCKET=OWN/'s';h.deadline=time.monotonic()+600
    h.SOCKET.mkdir(mode=0o700);started=False;result=None
    try:
        h.run([h.PG/'initdb','-D',h.DATA,'-U','fixture_bootstrap','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
        with (h.DATA/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(h.SOCKET)+"'\nshared_buffers='32MB'\nmax_connections=12\nautovacuum=off\n")
        h.run([h.PG/'pg_ctl','-D',h.DATA,'-l',OWN/'server.log','-w','start']);started=True
        assert sql("SELECT current_setting('server_version_num')::int BETWEEN 170000 AND 179999",'fixture_bootstrap')=='t'
        sql('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; ALTER DATABASE postgres OWNER TO postgres;','fixture_bootstrap')
        sql((ROOT/'bootstrap.sql').read_text())
        sql('GRANT anon,authenticated,service_role TO postgres WITH SET TRUE;','fixture_bootstrap')
        sql((FIXTURE/'baseline.sql').read_text())
        sql((REPO/'supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql').read_text())
        previous=(REPO/'supabase/migrations/20261007041535_two_owner_screens_read_what_they_show.sql').read_text()
        start=previous.index('CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(')
        original=previous[start:previous.index('$function$;',start)+len('$function$;')]+'\n'
        sql(original)
        assert md5(ROW)=='72d29ab402ff75ae3f240ce40a750437' and md5(TOTAL)=='5e50033127ded658f0bb4de87e0a10e6'
        original_authority=authority();migration=MIGRATION.read_text();cases={}
        cases['missingIndex']=sql(migration,refusal='cashier_direction_cover_missing')
        assert md5(ROW)=='72d29ab402ff75ae3f240ce40a750437' and authority()==original_authority
        # Supported concurrent unique build fails on genuine synthetic duplicates,
        # leaving an actual INVALID index. No pg_catalog edits or fabricated state.
        cases['invalidBuild']=sql('CREATE UNIQUE INDEX CONCURRENTLY idx_chip_ledger_cashier_direction_totals ON chip_ledger(club_id);',refusal='could not create unique index')
        assert sql("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='"+INDEX+"'::regclass")=='t'
        cases['invalidIndex']=sql(migration,refusal='cashier_direction_cover_shape_changed')
        sql('DROP INDEX '+INDEX)
        sql((REPO/'scripts/ops/build-cashier-direction-totals-index-concurrently.sql').read_text())
        sql('ALTER FUNCTION '+ROW+' COST 101')
        cases['wrongPreimage']=sql(migration,refusal='cashier_source_preimage_changed')
        sql('ALTER FUNCTION '+ROW+' COST 100')
        assert md5(ROW)=='72d29ab402ff75ae3f240ce40a750437' and authority()==original_authority
        sql((FIXTURE/'movement-totals-boundaries.sql').read_text())
        sql("""DO $check$ BEGIN
        BEGIN PERFORM 'Infinity'::numeric(14,2); RAISE EXCEPTION 'Infinity accepted'; EXCEPTION WHEN numeric_value_out_of_range THEN NULL; END;
        BEGIN PERFORM '-Infinity'::numeric(15,2); RAISE EXCEPTION 'Infinity accepted'; EXCEPTION WHEN numeric_value_out_of_range THEN NULL; END;
        END $check$;
        INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,created_at)
        VALUES(u(991001),u(100),u(20),u(1),'NaN','transfer','2026-09-07Z'),
              (u(991002),u(100),u(1),u(25),3.25,'transfer','2026-09-07Z');
        INSERT INTO chip_ledger(id,club_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key,created_at)
        VALUES(u(991003),u(100),'club_wallet',u(1),'player_wallet',u(20),'NaN','refund','nan-mirror','2026-09-07Z');
        INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,metadata,created_at)
        VALUES(u(991004),u(100),u(1),u(20),2.5,'topup','{"idempotency_key":"nan-mirror"}','2026-09-07Z');""")
        before=matrix(sql)
        sql(migration)
        assert matrix(sql)==before,'whole_scope_filter_totals_changed'
        assert authority()==original_authority and md5(TOTAL)=='5e50033127ded658f0bb4de87e0a10e6'
        assert sql("SELECT md5(prosrc) FROM pg_proc WHERE oid='"+ROW+"'::regprocedure")=='45d82a8afb00381ee4e784e7ffdf097d'
        cases['noReplay']=sql(migration,refusal='cashier_source_preimage_changed')
        index=json.loads(sql("SELECT jsonb_build_object('definition',pg_get_indexdef(indexrelid),'valid',indisvalid,'ready',indisready,'live',indislive) FROM pg_index WHERE indexrelid='"+INDEX+"'::regclass"))
        result={'state':'ISOLATED_INSTALL_GUARDS_VERIFIED','cases':cases,'authorityUnchanged':True,'wrapperUnchanged':True,'index':index,'productionInstalled':False}
    finally:
        stopped=None
        if started:
            stopped=subprocess.run([str(h.PG/'pg_ctl'),'-D',str(h.DATA),'-m','fast','-w','stop'],capture_output=True,env=h.ENV,timeout=20)
            cleanup={'stopExit':stopped.returncode,'postmasterAbsent':not (h.DATA/'postmaster.pid').exists()}
            if stopped.returncode or not cleanup['postmasterAbsent']:
                (OWN/'cleanup-unknown.json').write_text(json.dumps(cleanup)+'\n');raise RuntimeError('cleanup_unknown')
        if OWN.exists() and not (h.DATA/'postmaster.pid').exists():shutil.rmtree(OWN)
    assert result is not None and stopped is not None and stopped.returncode==0 and not OWN.exists()
    result['cleanup']={'stopExit':0,'namespaceAbsent':True}
    print(json.dumps(result,sort_keys=True))
if __name__=='__main__':main()
