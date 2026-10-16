#!/usr/bin/env python3
"""Private PG17 proof of the real conservation scalar and exact guarded patch."""
import argparse, hashlib, json, os, re, shutil, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / 'scripts/ci/fixtures/backed-payout-scan'
MIG = ROOT / 'supabase/migrations/20261015212119_a_spin_conservation_reading_counts_its_reserve_movements.sql'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch', default=os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))
args = parser.parse_args()
pg = Path(args.pg_bin)
scratch = Path(tempfile.mkdtemp(prefix='sc-',dir=args.scratch))
data = scratch/'data'
started = False
def run(argv, sql=None, error=None):
    r = subprocess.run([str(x) for x in argv],input=sql,text=True,capture_output=True,timeout=90)
    if error:
        assert r.returncode and error in r.stderr, r.stdout+r.stderr
    else:
        assert r.returncode == 0, r.stdout+r.stderr
    return r.stdout.strip()
def q(sql,error=None):
    return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',scratch,'-U','postgres','-d','postgres'],sql,error)
try:
    assert ' 17.' in run([pg/'postgres','--version'])
    run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(scratch)+"'\nautovacuum=off\n")
    run([pg/'pg_ctl','-D',data,'-l',scratch/'server.log','-w','start']); started=True
    q((FIX/'setup.sql').read_text())
    q('ALTER TABLE chip_ledger ADD COLUMN idempotency_key text;')
    q((FIX/'diamond-book-cases.sql').read_text())
    src=(ROOT/'supabase/migrations/20261007000010_the_diamond_arena_spawns_the_midway_schedule.sql').read_text()
    escrow=re.findall(r'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow\(p_tournament_id uuid\)\n.*?\n\$function\$;',src,re.S)[-1]
    q(escrow)
    q("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text); CREATE TABLE fixture_freeze(frozen boolean); INSERT INTO fixture_freeze VALUES(false); CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_freeze$$; CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$; CREATE TABLE spin_reserve_ledger(tournament_id uuid,kind text,amount numeric);")
    before=(FIX/'spin-reserve-scalar-before.sql').read_text()
    pins=json.loads((FIX/'spin-reserve-replacement.json').read_text())
    assert hashlib.md5(before.encode()).hexdigest()==pins['beforeHash']
    q(before)
    q("REVOKE ALL ON FUNCTION fn_tournament_conservation_delta(uuid) FROM PUBLIC;")
    q("INSERT INTO tournaments(id,name,variant) SELECT md5(x)::uuid,x,'spin' FROM unnest(ARRAY['low','high','missing','wrong','empty']) x; INSERT INTO wallet_transactions(related_entity_id,type,category,amount) SELECT id,'debit','tournament_buyin',30 FROM tournaments WHERE variant='spin' AND name<>'empty'; INSERT INTO wallet_transactions(related_entity_id,type,category,amount) SELECT id,'credit','prize',CASE name WHEN 'low' THEN 20 ELSE 100 END FROM tournaments WHERE variant='spin' AND name<>'empty'; INSERT INTO rake_records(tournament_id,rake_amount,is_tournament) SELECT id,3,true FROM tournaments WHERE variant='spin' AND name<>'empty'; INSERT INTO spin_reserve_ledger SELECT id,'contribution',27 FROM tournaments WHERE variant='spin' AND name<>'empty'; INSERT INTO spin_reserve_ledger SELECT id,'jackpot_draw',CASE name WHEN 'low' THEN -20 WHEN 'wrong' THEN -99 ELSE -100 END FROM tournaments WHERE name IN('low','high','wrong'); INSERT INTO spin_reserve_ledger SELECT id,'seed_return',-999 FROM tournaments WHERE name='low';")
    delta=lambda name:q("SELECT fn_tournament_conservation_delta(id) FROM tournaments WHERE name='"+name+"';")
    assert delta('low')=='7.00' and delta('high')=='-73.00', 'fail-before reproduced'
    nonspin=q("SELECT jsonb_object_agg(name,fn_tournament_conservation_delta(id)) FROM tournaments WHERE variant IS DISTINCT FROM 'spin';")
    catalog=q("SELECT jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_tournament_conservation_delta(uuid)'::regprocedure;")
    migration=MIG.read_text()
    q("UPDATE fixture_freeze SET frozen=true;"); q(migration,'spin_conservation_freeze_refused'); q("UPDATE fixture_freeze SET frozen=false;")
    q("INSERT INTO supabase_migrations.schema_migrations VALUES('20261015212119');"); q(migration,'spin_conservation_replay_refused'); q('DELETE FROM supabase_migrations.schema_migrations;')
    q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture_abort'; END $$; COMMIT;"),'fixture_abort')
    assert delta('low')=='7.00', 'rollback restores original'
    q(migration)
    expected={'low':'0.00','high':'0.00','missing':'-100.00','wrong':'-1.00','empty':'0.00'}
    for name,value in expected.items(): assert delta(name)==value,(name,delta(name),value)
    assert nonspin==q("SELECT jsonb_object_agg(name,fn_tournament_conservation_delta(id)) FROM tournaments WHERE variant IS DISTINCT FROM 'spin';"),'non-Spin and Diamond parity'
    assert catalog==q("SELECT jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid='fn_tournament_conservation_delta(uuid)'::regprocedure;"),'authority preserved'
    assert q("SELECT md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure));")==pins['afterHash']
    q(migration,'spin_conservation_preimage_refused')
    print('PASS: fail-before/pass-after; low/high/missing/wrong/empty; non-Spin and Diamond parity; rollback; freeze; replay; exact hash; authority')
finally:
    if started: run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(scratch)
