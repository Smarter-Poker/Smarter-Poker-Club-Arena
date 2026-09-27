#!/usr/bin/env python3
"""Finite PG17 Cashier read qualification on a private Unix socket only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests/fixtures/cashier-statements"
PG = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
MIGRATION = ROOT / "supabase/migrations/20260927151528_cashier_movement_totals_use_a_covered_ledger_range.sql"
BASE = ROOT / "supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql"
ENV = {"PATH": str(PG) + ":/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
cluster = Path(tempfile.mkdtemp(prefix="cashier-ledger-cover-", dir=os.environ.get("TMPDIR")))
socket = Path(tempfile.mkdtemp(prefix="lc-sock-", dir="/tmp"))
data = cluster / "data"
started = False
processes = []

def args(user="postgres"):
    return [str(PG/"psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-h", str(socket), "-U", user, "-d", "postgres"]

def run(argv, text=None, expected=None, timeout=150):
    p = subprocess.run(list(map(str, argv)), input=text, capture_output=True,
                       text=True, env=ENV, timeout=timeout)
    if expected:
        assert p.returncode and expected in p.stderr, p.stdout+p.stderr
    elif p.returncode:
        server_log = (cluster/"server.log").read_text() if (cluster/"server.log").exists() else ""
        raise RuntimeError(p.stdout+p.stderr+server_log[-4000:])
    return p

def q(text, expected=None, user="postgres"):
    return run(args(user), text, expected).stdout.strip()

def require(value, label):
    assert value, label
    print("PASS: "+label, flush=True)

def catalog():
    return json.loads(q("""SELECT jsonb_object_agg(oid::regprocedure::text,
    jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,
    'definer',prosecdef,'volatility',provolatile,'definition',pg_get_functiondef(oid)))
    FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname LIKE 'fn\\_cashier\\_statement\\_%'"""))

def data_hash():
    return q("""SELECT md5(coalesce(string_agg(j,'' ORDER BY j),''))
      FROM (SELECT row_to_json(t)::text j FROM chip_ledger t
        UNION ALL SELECT row_to_json(t)::text FROM chip_transactions t) x""")

def call(viewer, scope, filters="{}", limit=0, cursor="NULL,NULL,NULL"):
    return f"""SELECT * FROM public.fn_cashier_statement_rows(u(100),u({viewer}),'{scope}',
    '2026-09-01Z','2026-09-30Z','{filters}'::jsonb,{cursor},{'NULL' if limit is None else limit})"""

def result(viewer, scope, filters="{}", limit=0, cursor="NULL,NULL,NULL"):
    return q("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.entry_direction,t.entry_at,t.entry_source,t.entry_id),'[]') FROM ("+call(viewer,scope,filters,limit,cursor)+") t")

def totals_oracle(viewer, scope, filters="{}"):
    # The unchanged unlimited page/read path is a separate executor path.
    return q("""SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.entry_direction),'[]') FROM (
    SELECT NULL::timestamptz entry_at,NULL::text entry_source,NULL::uuid entry_id,
    entry_direction,sum(entry_amount) entry_amount,jsonb_build_object('count',count(*)) entry
    FROM ("""+call(viewer,scope,filters,None)+""") p GROUP BY entry_direction) a""")

def matrix():
    out = {}
    filters = ["{}",'{"wallet":"player"}','{"wallet":"table"}','{"wallet":"cashout"}',
      '{"wallet":"agent"}','{"wallet":"bank"}','{"wallet":"promo"}','{"wallet":"union"}',
      '{"wallet":"ticket"}','{"wallet":"other"}','{"direction":"in"}','{"direction":"out"}',
      '{"direction":"managed"}','{"state":"posted"}','{"state":"pending"}',
      '{"state":"reversed"}','{"operation":"refund"}','{"operation":"adjustment"}',
      '{"counterparty":"Player Twenty"}','{"counterparty":"00000000-0000-0000-0000-000000000020"}',
      '{"counterparty":"%_"}','{"reference":"mirror-edge-1"}']
    for viewer,scope in [(1,"all"),(10,"downline"),(11,"downline"),(12,"downline"),(20,"self"),(25,"self")]:
        for f in filters:
            got=result(viewer,scope,f)
            require(got==totals_oracle(viewer,scope,f),f"full row oracle: {viewer}/{scope}/{f}")
            out[(viewer,scope,f)] = got
        for limit,cursor in [(7,"NULL,NULL,NULL"),(7,"'2026-09-05T15:00:00Z','receipt',u(1005)"),(None,"NULL,NULL,NULL")]:
            out[(viewer,scope,limit,cursor)] = result(viewer,scope,"{}",limit,cursor)
    return out

def regression():
    # Every synthetic write/helper/export from the maintained full oracle rolls
    # back, so original and candidate see exactly the same baseline.
    # The existing oracle's RESET ROLE reads browser-owned temporary tables;
    # keep that independent oracle administrator, while every installed function
    # stays owned by the actual NOSUPERUSER postgres role.
    p=run(args("fixture_bootstrap"), "BEGIN;\n"+(FIXTURE/"regression.sql").read_text()+"\nROLLBACK;")
    require("PASS:" in p.stderr, "existing complete scope/auth/filter/export native oracle")

def wait(sql,label):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        if q(sql)=="t": return
        time.sleep(.025)
    raise AssertionError(label)

ONLINE=ROOT/'tests/fixtures/cashier-statements/ledger-cover-build-online.sql'
RECOVERY=ROOT/'tests/fixtures/cashier-statements/ledger-cover-recover-online.sql'
INDEX='idx_chip_ledger_cashier_totals_cover'
CATEGORIES=['buyin','addon','rebuy','tournament_prize','bounty','refund','spin_entry','spin_prize','promo','promo_send','treasury_transfer','transfer','player_funding','agent_funding','overlay','reversal','correction','adjustment','leaderboard_payout']

def durable():
    return q("SELECT jsonb_build_object('valid',indisvalid,'ready',indisready,'live',indislive,'definition',pg_get_indexdef(indexrelid)) FROM pg_index WHERE indexrelid=to_regclass('"+INDEX+"')")

def nodes(n):
    yield n
    for c in n.get('Plans',[]): yield from nodes(c)

def projection():
    cats=','.join("'"+x+"'" for x in CATEGORIES)
    return "SELECT cl.id,cl.amount,cl.from_entity_id,cl.to_entity_id FROM chip_ledger cl WHERE cl.club_id=u(100) AND cl.created_at>='2026-09-01Z' AND cl.created_at<'2026-09-30Z' AND cl.status='posted' AND cl.category=ANY(ARRAY["+cats+"]::text[])"

def measure(sql):
    return json.loads(q("SET statement_timeout='8s'; EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) "+sql))[0]

def hold_snapshot():
    p=subprocess.Popen(args(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV)
    processes.append(p)
    p.stdin.write("SET application_name='cashier_cover_snapshot';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM chip_ledger;\n");p.stdin.flush()
    wait("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cashier_cover_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)",'old snapshot established')
    return p

def release(p):
    p.stdin.write('ROLLBACK;\n');p.stdin.close();require(p.wait(timeout=10)==0,'old snapshot releases normally')

def start_build(sql):
    p=subprocess.Popen(args(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV)
    processes.append(p);p.stdin.write("SET statement_timeout='30s';SET lock_timeout='10s';\n"+sql);p.stdin.close()
    wait("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_create_index WHERE relid='chip_ledger'::regclass AND phase='waiting for old snapshots')",'online operation reached real old-snapshot phase')
    return p
try:
    run([PG/'initdb','-D',data,'-U','fixture_bootstrap','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nshared_buffers='32MB'\nmax_connections=12\nautovacuum=off\n")
    run([PG/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start']);started=True
    q('CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; ALTER DATABASE postgres OWNER TO postgres;',user='fixture_bootstrap')
    q((FIXTURE/'bootstrap.sql').read_text())
    q('GRANT anon,authenticated,service_role TO postgres WITH SET TRUE; CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon,authenticated,service_role TO authenticator WITH SET TRUE;',user='fixture_bootstrap')
    q((FIXTURE/'baseline.sql').read_text());q(BASE.read_text())
    q((FIXTURE/'ledger-cover-installed-rows.sql').read_text())
    q('CREATE INDEX idx_chip_tx_club_time_totals ON chip_transactions(club_id,created_at DESC) INCLUDE(amount,from_user_id,to_user_id);CREATE INDEX idx_chip_tx_type_user_created ON chip_transactions(transaction_type,to_user_id,created_at);')
    regression()
    original=catalog();before=matrix();rows=data_hash()
    require(q("SELECT NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname='postgres'")=='t','actual NOSUPERUSER BYPASSRLS owner')
    require(q("SELECT md5(pg_get_functiondef('fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure))")=='49e310be00e91afc9a9b7582bb048184','exact installed whole function source')
    migration=MIGRATION.read_text();online=ONLINE.read_text()
    q(migration,'CASHIER_LEDGER_COVER_MISSING_BUILD_ONLINE')
    q('BEGIN;'+online+'COMMIT;','cannot run inside a transaction block')
    q(online)
    q(migration)
    regression();require(matrix()==before,'132 whole-function scope/filter results and keyset/export unchanged')
    require(catalog()==original and data_hash()==rows,'financial source/OIDs/ACL and rows unchanged')
    q((FIXTURE/'ledger-cover-boundaries.sql').read_text())
    matrix()
    for flag in ('indisvalid','indisready','indislive'):
        q(f"UPDATE pg_index SET {flag}=false WHERE indexrelid='{INDEX}'::regclass",user='fixture_bootstrap');q(migration,'CASHIER_LEDGER_COVER_INDEX_CHANGED')
        q(f"UPDATE pg_index SET {flag}=true WHERE indexrelid='{INDEX}'::regclass",user='fixture_bootstrap')
    q('CREATE ROLE wrong_owner; ALTER TABLE chip_ledger OWNER TO wrong_owner',user='fixture_bootstrap');q(migration,'CASHIER_LEDGER_COVER_INDEX_CHANGED')
    q('ALTER TABLE chip_ledger OWNER TO postgres',user='fixture_bootstrap')
    q('ALTER TABLE chip_ledger ALTER COLUMN amount TYPE numeric');q(migration,'CASHIER_LEDGER_COVER_COLUMN_CHANGED')
    q('ALTER TABLE chip_ledger ALTER COLUMN amount TYPE numeric(15,2)')
    q('ALTER TABLE chip_ledger ALTER COLUMN category DROP NOT NULL');q(migration,'CASHIER_LEDGER_COVER_COLUMN_CHANGED')
    q('ALTER TABLE chip_ledger ALTER COLUMN category SET NOT NULL')
    q("UPDATE pg_proc SET prosrc=prosrc||E'\n-- drift' WHERE proname='fn_cashier_statement_rows'",user='fixture_bootstrap');q(migration,'CASHIER_LEDGER_COVER_SOURCE_CHANGED')
    q((FIXTURE/'ledger-cover-installed-rows.sql').read_text());require(catalog()==original,'source restoration retains identities')
    q('GRANT EXECUTE ON FUNCTION fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) TO authenticated')
    q(migration,'CASHIER_LEDGER_COVER_AUTHORITY_CHANGED')
    q('REVOKE EXECUTE ON FUNCTION fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) FROM authenticated')
    q('SET ROLE authenticated;'+online,'must be owner of table chip_ledger',user='authenticator')
    q('DROP INDEX '+INDEX)
    q('CREATE INDEX '+INDEX+' ON chip_ledger(club_id,created_at DESC) INCLUDE(id,amount,from_entity_id,to_entity_id)')
    q(migration,'CASHIER_LEDGER_COVER_INDEX_CHANGED');q('DROP INDEX '+INDEX)
    # Every allowed category, unknown labels and both status populations retain
    # original rows. Long nonindexed text must not make a new write fail.
    q("INSERT INTO chip_ledger(id,club_id,from_type,to_type,from_entity_id,to_entity_id,amount,category,status,created_at,notes,metadata) SELECT u(800000+n),u(100+n%4),'player_wallet','club_treasury',u(20+n%6),u(1),(n%300-150)/100.0,CASE WHEN n%5=0 THEN 'rake' ELSE (ARRAY["+','.join("'"+x+"'" for x in CATEGORIES)+"])[1+n%19] END,CASE WHEN n%7=0 THEN 'pending' ELSE 'posted' END,'2026-09-01Z'::timestamptz+n*interval '20 seconds',repeat(md5(n::text),20),jsonb_build_object('payload',repeat(md5((n+1)::text),20)) FROM generate_series(1,80000)n;VACUUM ANALYZE chip_ledger;VACUUM ANALYZE chip_transactions;")
    q("INSERT INTO chip_ledger(club_id,from_type,to_type,amount,category,status,created_at,notes,metadata) VALUES(u(100),repeat('type',3000),repeat('other',3000),-0.01,'adjustment','posted','2026-09-10Z',repeat('notes',5000),jsonb_build_object('payload',repeat('metadata',4000))),(u(100),'player_wallet','club_treasury',0,repeat('unknown_category',2000),'posted','2026-09-10Z',NULL,NULL)")
    q('VACUUM ANALYZE chip_ledger')
    counts=q('SELECT count(*),sum(amount) FROM ('+projection()+') x');baseline=measure(projection());whole_before=measure(call(1,'all'))
    old=hold_snapshot();build=start_build(online)
    q("SET statement_timeout='1s'; INSERT INTO chip_ledger(club_id,from_type,to_type,amount,category,status,created_at) VALUES(u(999),'player_wallet','club_treasury',1,'adjustment','posted','2026-09-10Z')")
    require(build.poll() is None,'online build waits for original snapshot while another writer commits')
    release(old);require(build.wait(timeout=30)==0,'concurrent build completes: '+build.stderr.read())
    q(migration);q('VACUUM ANALYZE chip_ledger')
    after=measure(projection());whole_after=measure(call(1,'all'))
    require(q('SELECT count(*),sum(amount) FROM ('+projection()+') x')==counts,'all category/status/signed/range projection outputs equal')
    scans=[n for n in nodes(after['Plan']) if n.get('Index Name')==INDEX]
    require(scans and all(n['Node Type']=='Index Only Scan' and n.get('Heap Fetches')==0 for n in scans),'unchanged projection now uses heap-free narrow cover')
    blocks=lambda p:p['Plan']['Shared Hit Blocks']+p['Plan']['Shared Read Blocks']
    require(blocks(after)<blocks(baseline)/4,'same native projection uses fewer than25percent buffers')
    require(blocks(whole_after)<blocks(whole_before)/2,'whole unchanged function uses fewer than half the buffers')
    print(json.dumps({'projectionBefore':baseline,'projectionAfter':after,'wholeBefore':whole_before,'wholeAfter':whole_after,'productionTiming':False}),flush=True)
    # Genuine interrupted final validation leaves a ready-but-invalid index.
    # Recovery resumes it online and keeps every original row and constraint.
    q('DROP INDEX CONCURRENTLY '+INDEX);old=hold_snapshot()
    q("SET lock_timeout='200ms';"+online,'lock timeout')
    require(json.loads(durable())['valid'] is False,'interrupted original operation has durable invalid outcome')
    q(migration,'CASHIER_LEDGER_COVER_INDEX_CHANGED');release(old)
    old=hold_snapshot();rebuild=start_build(RECOVERY.read_text())
    q("SET statement_timeout='1s'; INSERT INTO chip_ledger(club_id,from_type,to_type,amount,category,status,created_at) VALUES(u(999),'player_wallet','club_treasury',1,'adjustment','posted','2026-09-10Z')")
    release(old);require(rebuild.wait(timeout=30)==0,'qualified online reindex recovery finishes: '+rebuild.stderr.read())
    q(migration);d=durable();q(migration.replace('COMMIT;','ROLLBACK;'));require(durable()==d,'recording rollback has no index mutation')
    q(migration);require(durable()==d,'recording is verification-only, no duplicate index or financial mutation')
    require(catalog()==original,'every accounting RPC, permission and identity remains byte-identical')
    require(q("SELECT count(*)=0 FROM pg_class WHERE relname LIKE 'idx_chip_ledger_cashier_totals_cover_cc%'")=='t','no invalid-build recovery transient remains')
    print('PASS: cashier ledger cover finite native acceptance',flush=True)
finally:
    for p in processes:
        if p.poll() is None:
            if p.stdin and not p.stdin.closed:
                p.stdin.write('ROLLBACK;\n');p.stdin.close()
            p.wait(timeout=15)
    if started and (data/'postmaster.pid').exists():run([PG/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    shutil.rmtree(cluster);shutil.rmtree(socket)
