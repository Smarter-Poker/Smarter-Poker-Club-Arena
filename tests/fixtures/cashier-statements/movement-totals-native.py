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
MIGRATION = ROOT / "supabase/migrations/20260927143108_cashier_totals_match_receipt_omissions_before_the_movement_r.sql"
BASE = ROOT / "supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql"
ENV = {"PATH": str(PG) + ":/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
cluster = Path(tempfile.mkdtemp(prefix="cashier-movement-", dir=os.environ.get("TMPDIR")))
socket = Path(tempfile.mkdtemp(prefix="cm-sock-", dir="/tmp"))
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

try:
    run([PG/"initdb","-D",data,"-U","fixture_bootstrap","--auth-local=trust",
         "--auth-host=reject","--no-locale","-E","UTF8"])
    with (data/"postgresql.conf").open("a") as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\nshared_buffers='32MB'\nmax_connections=12\nautovacuum=off\n")
    run([PG/"pg_ctl","-D",data,"-l",cluster/"server.log","-w","start"])
    started=True
    q("CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; ALTER DATABASE postgres OWNER TO postgres;",user="fixture_bootstrap")
    q((FIXTURE/"bootstrap.sql").read_text())
    q("GRANT anon,authenticated,service_role TO postgres WITH SET TRUE; CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon,authenticated,service_role TO authenticator WITH SET TRUE;",user="fixture_bootstrap")
    q((FIXTURE/"baseline.sql").read_text())
    q(BASE.read_text())
    q("CREATE INDEX idx_chip_tx_type_user_created ON chip_transactions(transaction_type,to_user_id,created_at);")
    migration=MIGRATION.read_text()
    original=catalog()
    require(all(not x for x in json.loads(q("SELECT json_build_array(rolsuper,NOT rolbypassrls) FROM pg_roles WHERE rolname='postgres'"))), "actual NOSUPERUSER BYPASSRLS function owner")
    require(q("SELECT md5(pg_get_functiondef('fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)'::regprocedure))")=="d6152f4bb944489aa4e1dfaf5417fc00","captured installed row function exactly matches original fixture")
    regression()
    q("ALTER TABLE chip_ledger ALTER COLUMN to_type DROP NOT NULL")
    q(migration,"CASHIER_TOTALS_NULL_CONTRACT_CHANGED")
    q("ALTER TABLE chip_ledger ALTER COLUMN to_type SET NOT NULL")
    q("GRANT EXECUTE ON FUNCTION fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) TO authenticated")
    q(migration,"CASHIER_TOTALS_AUTHORITY_CHANGED")
    q("REVOKE EXECUTE ON FUNCTION fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer) FROM authenticated")
    q("ALTER INDEX idx_chip_tx_type_user_created RENAME TO fixture_missing_lookup")
    q(migration,"CASHIER_TOTALS_EXISTING_LOOKUP_INDEX_CHANGED")
    q("ALTER INDEX fixture_missing_lookup RENAME TO idx_chip_tx_type_user_created")
    for field in ('indisvalid','indisready','indislive'):
        q(f"UPDATE pg_index SET {field}=false WHERE indexrelid='idx_chip_tx_type_user_created'::regclass",user="fixture_bootstrap")
        q(migration,"CASHIER_TOTALS_EXISTING_LOOKUP_INDEX_CHANGED")
        q(f"UPDATE pg_index SET {field}=true WHERE indexrelid='idx_chip_tx_type_user_created'::regclass",user="fixture_bootstrap")
    q("UPDATE pg_proc SET prosrc=prosrc||E'\\n-- drift' WHERE proname='fn_cashier_statement_totals'",user="fixture_bootstrap")
    q(migration,"CASHIER_TOTALS_SOURCE_CHANGED")
    q(BASE.read_text())
    require(catalog()==original, "restored preimage preserves every RPC OID and permission")
    q(migration.replace("COMMIT;","ROLLBACK;"))
    require(catalog()==original,"migration rollback restores exact source and authority")
    q("SET ROLE authenticated;\n"+migration,"permission denied for schema public",user="postgres")
    q(migration)
    regression()
    q(BASE.read_text())
    require(catalog()==original,"full candidate oracle rollback leaves base rows and permissions intact")

    # Boundary fixtures augment the maintained oracle only after its exact
    # historical counts have passed. No production/player rows are involved.
    q((FIXTURE/"movement-totals-boundaries.sql").read_text())
    before=matrix()
    rows_hash=data_hash()
    q(migration)
    after=catalog()
    target=next(k for k in after if k.startswith("fn_cashier_statement_rows("))
    require(after[target]["definition"]==(FIXTURE/"movement-totals-after.sql").read_text(), "exact reviewed target function definition")
    require(all(v==after[k] for k,v in original.items() if k!=target), "every other financial/read function byte-identical")
    require({k:v for k,v in original[target].items() if k!="definition"}=={k:v for k,v in after[target].items() if k!="definition"}, "target OID/owner/ACL/security/config unchanged")
    require(matrix()==before,"all totals/filter/scope/page/cursor outputs identical before and after")
    require(data_hash()==rows_hash,"all source rows and monetary fields unchanged")
    q(migration,"CASHIER_TOTALS_SOURCE_CHANGED")
    print("PASS: replay refuses installed source without mutation",flush=True)
    # Real authenticated caller reads the same totals at the unchanged timeout.
    q("SET ROLE authenticated; SET statement_timeout='8s'; SELECT as_user(20); SELECT fn_cashier_statement_totals(u(100),'2026-09-01Z','2026-09-30Z','{}');",user="authenticator")
    for role in ("anon","authenticated","service_role"):
        q("SET ROLE "+role+"; "+call(1,"all"),"permission denied")
    # Snapshot holds the receipt/ledger decision while a new matching receipt
    # commits in another real connection. The next statement then sees it.
    q("INSERT INTO chip_ledger(id,club_id,from_type,to_type,to_entity_id,amount,category,idempotency_key,created_at) VALUES(u(98000),u(100),'club_wallet','player_wallet',u(20),17.25,'refund','snapshot-key','2026-09-11Z');")
    reader=subprocess.Popen(args(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=ENV)
    processes.append(reader)
    reader.stdin.write("SET application_name='cashier_snapshot'; BEGIN ISOLATION LEVEL REPEATABLE READ; "+call(20,"self")+";\n")
    reader.stdin.flush()
    wait("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cashier_snapshot' AND state='idle in transaction')","snapshot not retained")
    q("INSERT INTO chip_transactions(club_id,to_user_id,amount,transaction_type,metadata,created_at) VALUES(u(100),u(20),17.25,'seat_credit_restored','{\"restore_key\":\"snapshot-key\"}','2026-09-11Z');")
    reader.stdin.write(call(20,"self")+"; ROLLBACK;\n")
    reader.stdin.close()
    require(reader.wait(timeout=10)==0,"snapshot reader exits successfully: "+reader.stderr.read())
    values=reader.stdout.read().splitlines()
    half=len(values)//2
    require(values[:half]==values[half:],"real retained snapshot preserves both receipt and movement selection")
    require(result(20,"self")==totals_oracle(20,"self"),"next statement observes committed mirror exactly once")
    # A bounded wide/interleaved fixture models the observed range and mirror
    # lookup cost. It is synthetic, and its timing is not production savings.
    q("""INSERT INTO chip_ledger(id,club_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key,created_at,metadata)
      SELECT md5('movement-'||n)::uuid,u(100+(n%4)), 'club_wallet',u(10),'player_wallet',u(20),
       1+(n%1000)/100.0,CASE WHEN n%3=0 THEN 'adjustment' ELSE 'refund' END,
       'synthetic-key-'||n,'2026-09-12Z'::timestamptz+n*interval '1 second',
       jsonb_build_object('wide',repeat(md5(n::text),16)) FROM generate_series(1,80000)n;
      INSERT INTO chip_transactions(club_id,from_user_id,to_user_id,amount,transaction_type,metadata,created_at)
      SELECT u(100),u(10),u(20),1,'seat_credit_restored',jsonb_build_object('restore_key','synthetic-key-'||(n*8)),
       '2026-09-12Z'::timestamptz+(n*8)*interval '1 second' FROM generate_series(1,5000)n;
      VACUUM ANALYZE chip_ledger; VACUUM ANALYZE chip_transactions;""")
    expected=result(1,'all')
    plans=[]
    for label,definition in [('original','movement-totals-before.sql'),('candidate','movement-totals-after.sql')]:
        q((FIXTURE/definition).read_text())
        plan=json.loads(q("SET statement_timeout='8s'; EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) "+call(1,'all')))[0]
        require(result(1,'all')==expected,label+' complete large-range totals equal')
        plans.append({'scenario':label,'plan':plan})
    print(json.dumps({'nativeWholeFunctionPlans':plans,'productionTiming':False}),flush=True)
    buffers=lambda p:p['plan']['Plan']['Shared Hit Blocks']+p['plan']['Plan']['Shared Read Blocks']
    require(buffers(plans[1])<buffers(plans[0])*0.75,"complete candidate uses less than 75 percent of original buffers on the same native fixture")
    require(catalog()[target]==after[target],"final target is the reviewed candidate")
    print("PASS: finite cashier movement totals native acceptance",flush=True)
finally:
    for p in processes:
        if p.poll() is None:
            if p.stdin and not p.stdin.closed: p.stdin.close()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.terminate();p.wait(timeout=5)
    if started and (data/"postmaster.pid").exists():
        run([PG/"pg_ctl","-D",data,"-m","fast","-w","stop"])
    shutil.rmtree(cluster)
    shutil.rmtree(socket)
