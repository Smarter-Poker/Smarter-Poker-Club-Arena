#!/usr/bin/env python3
"""Isolated PG17 exact heap/TOAST free-byte and least-privilege qualification."""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261013161705_horse_retention_exact_space_diagnostics.sql'

def main():
    p=argparse.ArgumentParser(); p.add_argument('--evidence',type=Path,required=True); p.add_argument('--pg-bin',type=Path,required=True); a=p.parse_args()
    a.evidence.mkdir(parents=True,exist_ok=False)
    scratch=Path(tempfile.mkdtemp(prefix='pg-',dir=a.evidence)); socket=scratch/'s'; socket.mkdir()
    data=scratch/'d'; pg=a.pg_bin; checks=[]; started=False
    env={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','TZ'] if k in os.environ}
    def run(args,**kw): return subprocess.run([str(x) for x in args],env=env,text=True,capture_output=True,timeout=45,**kw)
    def sql(q,user='postgres',ok=True):
        r=run([pg/'psql','-X','-qAt','-h',socket,'-p','55479','-U',user,'-d','postgres','-v','ON_ERROR_STOP=1','-c',q])
        if ok and r.returncode: raise RuntimeError(r.stderr)
        return r
    def yes(q,label):
        assert sql(q).stdout.strip()=='t',label; checks.append(label)
    try:
        r=run([pg/'initdb','-D',data,'-U','native_admin','--auth=trust','--no-locale']); assert r.returncode==0,r.stderr
        r=run([pg/'pg_ctl','-D',data,'-l',scratch/'server.log','-o',f"-k {socket} -p 55479 -c listen_addresses=''",'-w','start']); assert r.returncode==0,r.stderr; started=True
        sql('CREATE ROLE postgres LOGIN SUPERUSER; CREATE ROLE anon LOGIN; CREATE ROLE authenticated LOGIN; CREATE ROLE service_role LOGIN; GRANT pg_stat_scan_tables TO postgres; CREATE SCHEMA extensions AUTHORIZATION postgres; GRANT CREATE ON SCHEMA public TO postgres;',user='native_admin')
        sql(MIGRATION.read_text()); checks.append('exact-candidate-installs-version-and-default-scan-authority')
        r=sql(MIGRATION.read_text(),ok=False); assert r.returncode and 'HORSE_SPACE_DIAGNOSTIC_PREIMAGE_CHANGED' in r.stderr; checks.append('installed-extension-replay-refused')
        sql('ALTER ROLE postgres NOSUPERUSER',user='native_admin')
        yes("SELECT NOT rolsuper AND pg_has_role(current_user,'pg_stat_scan_tables','member') FROM pg_roles WHERE rolname=current_user",'actual-reader-NOSUPER-with-existing-scan-membership')
        # Alternate rows prevent a trailing-file truncation from masquerading as
        # internal reusable space. Incompressible MD5 strings also exercise TOAST.
        sql("CREATE TABLE public.native_heap(id integer,payload text) WITH(autovacuum_enabled=false); INSERT INTO native_heap SELECT i,repeat(md5(i::text),30) FROM generate_series(1,2000)i; CREATE TABLE public.native_toast(id integer,payload text) WITH(autovacuum_enabled=false); INSERT INTO native_toast SELECT i,string_agg(md5((i*10000+n)::text),'') FROM generate_series(1,100)i CROSS JOIN generate_series(1,300)n GROUP BY i;")
        before=json.loads(sql("SELECT row_to_json(s) FROM extensions.pgstattuple('public.native_heap'::regclass)s").stdout)
        sql('DELETE FROM native_heap WHERE id%2=0')
        dead=json.loads(sql("SELECT row_to_json(s) FROM extensions.pgstattuple('public.native_heap'::regclass)s").stdout)
        assert dead['dead_tuple_count']==1000 and dead['tuple_count']==1000; checks.append('exact-full-scan-distinguishes-dead-tuples-from-free-space')
        sql('VACUUM public.native_heap')
        after=json.loads(sql("SELECT row_to_json(s) FROM extensions.pgstattuple('public.native_heap'::regclass)s").stdout)
        assert after['table_len']==before['table_len'] and after['dead_tuple_count']==0 and after['tuple_count']==1000 and after['free_space']>before['free_space']; checks.append('actual-vacuum-creates-exact-reusable-bytes-without-file-shrink')
        toast=json.loads(sql("SELECT row_to_json(s) FROM pg_class c CROSS JOIN LATERAL extensions.pgstattuple(c.reltoastrelid)s WHERE c.oid='public.native_toast'::regclass").stdout)
        assert toast['tuple_count']>100; checks.append('actual-catalog-linked-TOAST-scan-includes-out-of-line-payload')
        for role in ['anon','authenticated','service_role']:
            r=sql("SELECT * FROM extensions.pgstattuple('public.native_heap'::regclass)",user=role,ok=False)
            assert r.returncode and 'permission denied' in r.stderr; checks.append(role+'-actual-diagnostic-call-refused')
        report={'qualified':True,'checks':checks,'source_sha256':hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),'reader_superuser':False,'provider_NOSUPER_creation_natively_proven':False,'provider_creation_requires_actual_allowlist_and_once-installation_readback':True,'heap_before':before,'heap_after':after,'toast':toast,'production_actions':False}
        (a.evidence/'result.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'qualified':True,'checks':len(checks),'source_sha256':report['source_sha256']}))
    finally:
        if started:
            r=run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop']); assert r.returncode==0,r.stderr
        shutil.rmtree(scratch)

if __name__=='__main__': main()
