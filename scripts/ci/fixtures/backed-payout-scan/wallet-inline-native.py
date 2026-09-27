"""Single-use wallet CTE qualification in the maintained private PG17 cluster.

The original scalar caller is the independent whole-financial-output oracle.
Only its previously declared reconciliation adapter is modeled.
"""
import hashlib
import json
import subprocess


def qualify(context):
    q = context['query']; outcome = context['outcome']; f = context['FIXTURE']
    root = context['ROOT']; original = context['original']
    pg = context['pg']; socket = context['socket']; env = context['env']
    pins = json.loads((f/'wallet-inline-expectations.json').read_text())
    migration = (root/pins['migration']).read_text()
    old = q("SELECT pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);")+'\n'
    assert hashlib.md5(old.encode()).hexdigest() == pins['beforeDefinitionMD5']
    assert old.count(pins['oldToken']) == 1
    new = old.replace(pins['oldToken'], pins['newToken'])
    assert hashlib.md5(new.encode()).hexdigest() == pins['afterDefinitionMD5']
    catalog = "SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"
    before_catalog = q(catalog)
    pairs = [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]
    q(original)
    expected = {pair: outcome(*pair) for pair in pairs}
    q(old)
    scan = (f/'reviewed-return-batch-selection.sql').read_text().rstrip()
    prefix = scan[:scan.rindex('    SELECT t.id, t.name, t.club_id, t.prize_pool,')].replace('v_window_days','30')
    inline = prefix.replace(pins['oldToken'], pins['newToken'])
    def nodes(n):
        yield n
        for child in n.get('Plans', []):
            yield from nodes(child)
    selection = ' SELECT count(*) FROM deltas WHERE delta>0.01;'
    before_plan = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+prefix+selection))[0]
    assert any(n.get('Subplan Name') == 'CTE wallet_receipts' for n in nodes(before_plan['Plan'])), 'original wallet spool not reproduced'
    print('backed-wallet-inline-original-spool-red-reproduced')
    q('GRANT EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) TO authenticated;')
    q(migration, 'BACKED_WALLET_INLINE_AUTHORITY_CHANGED')
    q('REVOKE EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) FROM authenticated;')
    q("ALTER FUNCTION fn_tournament_conservation_delta(uuid) SET statement_timeout='9s';")
    q(migration, 'BACKED_WALLET_INLINE_PREIMAGE_CHANGED')
    q((f/'reviewed-return-scalar.sql').read_text())
    q('ALTER TABLE tournament_guarantee_overlays DROP CONSTRAINT tournament_guarantee_overlays_pkey; ALTER TABLE tournament_guarantee_overlays ADD CONSTRAINT fixture_inline_deferred UNIQUE(tournament_id) DEFERRABLE INITIALLY DEFERRED;')
    q(migration, 'BACKED_WALLET_INLINE_SINGLETON_KEYS_CHANGED')
    q('ALTER TABLE tournament_guarantee_overlays DROP CONSTRAINT fixture_inline_deferred; ALTER TABLE tournament_guarantee_overlays ADD PRIMARY KEY(tournament_id);')
    for name in ['idx_rake_records_club_data_tournament_window', 'idx_chip_ledger_reviewed_overlay_returns']:
        for flag in ['indisvalid','indisready','indislive']:
            q("UPDATE pg_index SET "+flag+"=false WHERE indexrelid='"+name+"'::regclass;", role=None)
            q(migration, 'BACKED_WALLET_INLINE_COVER_CHANGED')
            q("UPDATE pg_index SET "+flag+"=true WHERE indexrelid='"+name+"'::regclass;", role=None)
    q(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'inline rollback'; END $$; COMMIT;"), 'inline rollback')
    assert q("SELECT md5(pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure));") == pins['beforeDefinitionMD5'], 'inline transaction rollback'
    q(migration)
    q(migration, 'BACKED_WALLET_INLINE_PREIMAGE_CHANGED')
    assert q("SELECT pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);")+'\n' == new, 'more than the single-use CTE changed'
    assert q(catalog) == before_catalog, 'inline changed authority or function identity'
    for pair, wanted in expected.items():
        assert outcome(*pair) == wanted, 'whole inline caller differs '+str(pair)
    assert q(inline+' SELECT count(*) FROM deltas d WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);') == '0', 'inline whole-population scalar parity'
    for role in ['anon','authenticated']:
        q('SELECT fn_pay_backed_payout_shortfalls();', 'permission denied for function', role=role)
    q('BEGIN; SELECT fn_pay_backed_payout_shortfalls(); ROLLBACK;', role='service_role')
    after_plan = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+inline+selection))[0]
    assert not any(n.get('Subplan Name') == 'CTE wallet_receipts' or n.get('CTE Name') == 'wallet_receipts' for n in nodes(after_plan['Plan'])), 'single-use receipt spool remains'
    print(json.dumps({'scope':'private fixture, not provider latency','before_ms':before_plan['Execution Time'],'after_ms':after_plan['Execution Time'],'before_temp_written':before_plan['Plan']['Temp Written Blocks'],'after_temp_written':after_plan['Plan']['Temp Written Blocks']}))
    # A transaction started before a second connection commits both kinds of
    # receipt keeps its old scalar/batch answer; the next statement sees both.
    args = [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres']
    connection = subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env)
    event = "md5('return-4')::uuid"
    comparison = 'SELECT json_build_array(fn_tournament_conservation_delta('+event+'),('+inline+' SELECT delta FROM deltas WHERE id='+event+'));'
    try:
        def exchange(sql):
            connection.stdin.write(sql+'\n'); connection.stdin.flush()
            line = connection.stdout.readline().strip()
            assert line, connection.stderr.read()
            return json.loads(line)
        initial = exchange('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; '+comparison)
        assert initial[0] == initial[1]
        q('BEGIN; INSERT INTO wallet_transactions(related_entity_id,type,category,amount,user_id) VALUES('+event+",'credit','prize',2,"+event+'); INSERT INTO chip_ledger(tournament_id,amount,category,from_type,from_entity_id,metadata) VALUES('+event+",3,'reversal','prize_liability',"+event+",'{\"kind\":\"reviewed_void_overlay_return\"}'); COMMIT;")
        assert exchange(comparison) == initial, 'inline admitted later committed receipts into old snapshot'
        fresh = exchange('COMMIT; '+comparison)
        assert fresh[0] == fresh[1] == initial[0]-5, 'inline fresh statement misses wallet or return receipt'
        connection.stdin.close()
        assert connection.wait(timeout=5) == 0, connection.stderr.read()
    finally:
        if connection.poll() is None:
            connection.terminate(); connection.wait(timeout=5)
    print('backed-wallet-inline-native-acceptance-passed')
