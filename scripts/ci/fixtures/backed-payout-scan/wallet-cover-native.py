"""Actual PG17 cover/build/recovery qualification in the existing private cluster."""
import json,subprocess,time

def qualify(context):
    q=context['query'];f=context['FIXTURE'];root=context['ROOT'];outcome=context['outcome']
    pg=context['pg'];socket=context['socket'];env=context['env']
    pin=json.loads((f/'wallet-cover-expectations.json').read_text());name=pin['name']
    migration=(root/pin['migration']).read_text()
    online=(f/'wallet-cover-build-online.sql').read_text();recovery=(f/'wallet-cover-recover-online.sql').read_text()
    # Production postgres is NOSUPERUSER BYPASSRLS with pg_monitor USAGE
    # (read-only catalog verified 2026-09-27). Match that observer authority.
    q('GRANT pg_monitor TO postgres;',role=None)
    # The financial-parity stage intentionally covers more permissive NULL and
    # subcent inputs. This index stage adopts the actual bounded amount type
    # before capturing its independent before/after data and financial outputs.
    q('ALTER TABLE wallet_transactions ALTER COLUMN amount TYPE numeric(15,2);')
    q("INSERT INTO wallet_transactions(related_entity_id,type,category,amount) SELECT md5('noise-'||n)::uuid,'credit','noise-'||md5(n::text),1 FROM generate_series(1,100000)n;")
    q("INSERT INTO wallet_transactions(related_entity_id,type,category,amount) SELECT md5('cover-match-'||(n%1000))::uuid,CASE WHEN n%2=0 THEN 'debit' ELSE 'credit' END,CASE n%6 WHEN 0 THEN 'tournament_buyin' WHEN 1 THEN 'prize' WHEN 2 THEN 'rebuy' WHEN 3 THEN 'refund' WHEN 4 THEN 'addon' ELSE 'bounty' END,CASE WHEN n%10=0 THEN -1 ELSE 1 END FROM generate_series(1,10000)n;")
    q("INSERT INTO wallet_transactions(related_entity_id,type,category,amount) VALUES(md5('oversized-excluded-label')::uuid,'credit',repeat('x',50000),1);")
    catalog="SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definition',pg_get_functiondef(oid)) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"
    before_catalog=q(catalog)
    projection="SELECT related_entity_id,type,category,sum(amount) amount FROM wallet_transactions WHERE "+pin['predicate']+" GROUP BY related_entity_id,type,category"
    result="SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY related_entity_id,type,category),'[]') FROM ("+projection+")x;"
    before=q(result)
    financial={(a,l):outcome(a,l) for a,l in [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]}
    rows=q("SELECT count(*),sum(amount),sum(octet_length(type)+octet_length(category)) FROM wallet_transactions;")
    q(migration,'WALLET_RECEIPT_COVER_MISSING_BUILD_ONLINE')
    q('BEGIN;'+online+'COMMIT;','cannot run inside a transaction block')
    q(online,'must be owner of table wallet_transactions',role='authenticated')
    q(online);q(migration)
    for pair,wanted in financial.items():assert outcome(*pair)==wanted,'initial index changes financial output '+str(pair)
    assert q("SELECT pg_get_indexdef('"+name+"'::regclass);")==pin['definition'],'actual canonical index definition'
    for flag in ['indisvalid','indisready','indislive']:
        q("UPDATE pg_index SET "+flag+"=false WHERE indexrelid='"+name+"'::regclass;",role=None)
        q(migration,'WALLET_RECEIPT_COVER_DEFINITION_CHANGED')
        q("UPDATE pg_index SET "+flag+"=true WHERE indexrelid='"+name+"'::regclass;",role=None)
    q('ALTER TABLE wallet_transactions ALTER COLUMN amount TYPE numeric;')
    q(migration,'WALLET_RECEIPT_COVER_COLUMNS_CHANGED')
    q('ALTER TABLE wallet_transactions ALTER COLUMN amount TYPE numeric(15,2);')
    q("GRANT EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) TO authenticated;")
    q(migration,'WALLET_RECEIPT_COVER_AUTHORITY_CHANGED')
    q("REVOKE EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) FROM authenticated;")
    q("ALTER FUNCTION fn_tournament_conservation_delta(uuid) SET statement_timeout='9s';")
    q(migration,'WALLET_RECEIPT_COVER_SOURCE_CHANGED')
    q((f/'reviewed-return-scalar.sql').read_text())
    q('DROP INDEX '+name);q('CREATE INDEX '+name+' ON wallet_transactions(related_entity_id) INCLUDE(amount) WHERE category=\'prize\';')
    q(migration,'WALLET_RECEIPT_COVER_DEFINITION_CHANGED');q('DROP INDEX '+name)
    q('VACUUM ANALYZE wallet_transactions;')
    baseline=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+projection))[0]
    args=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres']
    processes=[]
    def wait(sql,label):
        until=time.monotonic()+10
        while time.monotonic()<until:
            if q(sql)=='t':return
            time.sleep(.025)
        raise AssertionError(label)
    def hold():
        p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);processes.append(p)
        p.stdin.write("SET ROLE postgres;SET application_name='wallet_cover_old_snapshot';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM wallet_transactions;\n");p.stdin.flush()
        wait("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='wallet_cover_old_snapshot' AND state='idle in transaction' AND backend_xmin IS NOT NULL)",'real old snapshot established');return p
    def release(p):
        p.stdin.write('ROLLBACK;\n');p.stdin.close();assert p.wait(timeout=10)==0,p.stderr.read()
    def build(sql):
        p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);processes.append(p)
        p.stdin.write("SET ROLE postgres;SET statement_timeout='30s';SET lock_timeout='10s';\n"+sql);p.stdin.close()
        wait("SELECT EXISTS(SELECT FROM pg_stat_progress_create_index WHERE relid='wallet_transactions'::regclass AND phase='waiting for old snapshots')",'real concurrent build waits for old snapshot');return p
    writer="SET statement_timeout='1s';INSERT INTO wallet_transactions(related_entity_id,amount,type,category) VALUES(md5('online-writer')::uuid,0,'credit','prize');"
    try:
        old=hold();p=build(online)
        q(migration,'WALLET_RECEIPT_COVER_ACTIVE_BUILD');q(writer)
        assert p.poll() is None,'writer must commit while online build remains waiting'
        release(old);assert p.wait(timeout=30)==0,p.stderr.read();q(migration)
        # Compare original groups; the separately asserted committed writer adds
        # one known zero-valued group, never alters old rows or accounting.
        assert q("SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY related_entity_id,type,category),'[]') FROM ("+projection+")x WHERE related_entity_id<>md5('online-writer')::uuid;")==before
        assert q("SELECT count(*)=1 AND sum(amount)=0 FROM wallet_transactions WHERE related_entity_id=md5('online-writer')::uuid;")=='t'
        # The concurrent writer is itself a new wallet row. Compare the entire
        # output against the independent original scalar caller on this same
        # current state, not against the pre-writer wallet inventory.
        current=q("SELECT pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);")+'\n'
        q(context['original'])
        with_writer={pair:outcome(*pair) for pair in financial}
        q(current)
        for pair,wanted in with_writer.items():assert outcome(*pair)==wanted,'index changes financial output '+str(pair)
        # The whole financial oracle intentionally rolls back receipt inserts.
        # Force their small dead-index cleanup in this PRIVATE fixture before
        # asserting zero heap fetches; production is never vacuumed here.
        q('VACUUM (ANALYZE, INDEX_CLEANUP ON) wallet_transactions;')
        after=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+projection))[0]
        def nodes(n):
            yield n
            for c in n.get('Plans',[]):yield from nodes(c)
        print(json.dumps({'walletCoverDiagnosticPlan':after}),flush=True)
        scans=[n for n in nodes(after['Plan']) if n.get('Index Name')==name]
        assert scans and all(n['Node Type']=='Index Only Scan' and n.get('Heap Fetches')==0 for n in scans),'new predicate uses narrow heap-free cover'
        blocks=lambda v:v['Plan']['Shared Hit Blocks']+v['Plan']['Shared Read Blocks']
        assert blocks(after)<blocks(baseline),'same projection must use fewer baseline buffers'
        print(json.dumps({'walletCoverBefore':baseline,'walletCoverAfter':after,'indexBytes':int(q("SELECT pg_relation_size('"+name+"');")),'productionTiming':False}),flush=True)
        q('DROP INDEX CONCURRENTLY '+name);old=hold()
        q("SET lock_timeout='200ms';"+online,'lock timeout')
        assert q("SELECT NOT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid='"+name+"'::regclass;")=='t','real interrupted build leaves invalid durable state'
        q(migration,'WALLET_RECEIPT_COVER_DEFINITION_CHANGED');release(old)
        old=hold();p=build(recovery);q(writer);release(old);assert p.wait(timeout=30)==0,p.stderr.read();q(migration)
        assert q(catalog)==before_catalog,'source/OID/ACL/config changed during build/recovery'
        durable=q("SELECT pg_get_indexdef(indexrelid),indisvalid,indisready,indislive FROM pg_index WHERE indexrelid='"+name+"'::regclass;")
        q(migration.replace('COMMIT;','ROLLBACK;'));q(migration)
        assert q("SELECT pg_get_indexdef(indexrelid),indisvalid,indisready,indislive FROM pg_index WHERE indexrelid='"+name+"'::regclass;")==durable
        assert q("SELECT count(*)=0 FROM pg_class WHERE relname LIKE '"+name+"_cc%';")=='t','recovery left a transient index'
        # Both concurrent writes have zero amount and the same literal type/category.
        a,b,c=rows.split('|');assert q("SELECT count(*),sum(amount),sum(octet_length(type)+octet_length(category)) FROM wallet_transactions WHERE related_entity_id IS DISTINCT FROM md5('online-writer')::uuid;")==rows,'financial data changed'
        print('backed-payout-wallet-cover-native-acceptance-passed',flush=True)
    finally:
        for p in processes:
            if p.poll() is None:
                if p.stdin and not p.stdin.closed:p.stdin.write('ROLLBACK;\n');p.stdin.close()
                p.wait(timeout=15)
