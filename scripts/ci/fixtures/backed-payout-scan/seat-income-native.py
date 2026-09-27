"""Existing satellite target index qualification in the maintained private PG17 cluster.

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
    pins = json.loads((f/'seat-income-expectations.json').read_text())
    migration = (root/pins['migration']).read_text()
    old = q("SELECT pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);")+'\n'
    assert hashlib.md5(old.encode()).hexdigest() == pins['beforeDefinitionMD5']
    start = old.index('    ), seat_income AS MATERIALIZED (')
    end = old.index('    ), seat_outgoing AS MATERIALIZED (', start)
    income = old[start:end]
    assert hashlib.md5(income.encode()).hexdigest() == pins['incomeBeforeMD5']
    assert income.count(pins['oldPredicate']) == 1
    new = old[:start]+income.replace(pins['oldPredicate'],pins['newPredicate'])+old[end:]
    q((f/'seat-income-cases.sql').read_text())
    assert q("SELECT fn_tournament_conservation_delta(md5('income-target')::uuid);") == '123.00', 'independent incoming total'
    # Adopt the captured real index instead of the simplified historical
    # expression index in the original fixture. No production DDL is used.
    q('DROP INDEX tournament_payouts_expr_idx; '+pins['indexDefinition']+';')
    q('ANALYZE tournament_payouts; ANALYZE tournaments;')
    assert hashlib.md5(new.encode()).hexdigest() == pins['afterDefinitionMD5']
    catalog = "SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"
    before_catalog = q(catalog)
    pairs = [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]
    q(original)
    expected = {pair: outcome(*pair) for pair in pairs}
    q(old)
    scan = (f/'reviewed-return-batch-selection.sql').read_text().rstrip().replace('wallet_receipts AS MATERIALIZED (','wallet_receipts AS NOT MATERIALIZED (')
    prefix = scan[:scan.rindex('    SELECT t.id, t.name, t.club_id, t.prize_pool,')].replace('v_window_days','30')
    a = prefix.index('    ), seat_income AS MATERIALIZED (')
    b = prefix.index('    ), seat_outgoing AS MATERIALIZED (', a)
    inline = prefix[:a]+prefix[a:b].replace(pins['oldPredicate'],pins['newPredicate'])+prefix[b:]
    assert inline[b+len(pins['newPredicate'])-len(pins['oldPredicate']):] == prefix[b:], 'outgoing bytes changed'
    def income_read(value):
        eligible = value[:value.index('    ), wallet_receipts AS NOT MATERIALIZED (')]+')'
        start = value.index('seat_income AS MATERIALIZED (')
        end = value.index('    ), seat_outgoing AS MATERIALIZED (',start)
        return eligible+', '+value[start:end]+') SELECT * FROM seat_income;'
    before_rows = q(income_read(prefix))
    def nodes(n):
        yield n
        for child in n.get('Plans', []):
            yield from nodes(child)
    selection = ' SELECT count(*) FROM deltas WHERE delta>0.01;'
    before_plan = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+income_read(prefix)))[0]
    assert any(n.get('Node Type') == 'Seq Scan' and n.get('Relation Name') == 'tournament_payouts' for n in nodes(before_plan['Plan'])), 'original unbounded payout heap read not reproduced'
    print('backed-seat-income-original-heap-read-red-reproduced')
    q('GRANT EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) TO authenticated;')
    q(migration, 'BACKED_SEAT_INCOME_AUTHORITY_CHANGED')
    q('REVOKE EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) FROM authenticated;')
    q("ALTER FUNCTION fn_tournament_conservation_delta(uuid) SET statement_timeout='9s';")
    q(migration, 'BACKED_SEAT_INCOME_PREIMAGE_CHANGED')
    q((f/'reviewed-return-scalar.sql').read_text())
    q('ALTER TABLE tournament_guarantee_overlays DROP CONSTRAINT tournament_guarantee_overlays_pkey; ALTER TABLE tournament_guarantee_overlays ADD CONSTRAINT fixture_inline_deferred UNIQUE(tournament_id) DEFERRABLE INITIALLY DEFERRED;')
    q(migration, 'BACKED_SEAT_INCOME_SINGLETON_KEYS_CHANGED')
    q('ALTER TABLE tournament_guarantee_overlays DROP CONSTRAINT fixture_inline_deferred; ALTER TABLE tournament_guarantee_overlays ADD PRIMARY KEY(tournament_id);')
    for name in ['idx_rake_records_club_data_tournament_window', 'idx_chip_ledger_reviewed_overlay_returns', 'idx_tournament_payouts_satellite_target']:
        for flag in ['indisvalid','indisready','indislive']:
            q("UPDATE pg_index SET "+flag+"=false WHERE indexrelid='"+name+"'::regclass;", role=None)
            q(migration, 'BACKED_SEAT_INCOME_COVER_CHANGED')
            q("UPDATE pg_index SET "+flag+"=true WHERE indexrelid='"+name+"'::regclass;", role=None)
    q(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'income rollback'; END $$; COMMIT;"), 'income rollback')
    assert q("SELECT md5(pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure));") == pins['beforeDefinitionMD5'], 'income transaction rollback'
    q(migration)
    q(migration, 'BACKED_SEAT_INCOME_PREIMAGE_CHANGED')
    assert q("SELECT pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);")+'\n' == new, 'more than the income predicate changed'
    assert q(catalog) == before_catalog, 'income changed authority or function identity'
    for pair, wanted in expected.items():
        assert outcome(*pair) == wanted, 'whole incoming caller differs '+str(pair)
    assert q(inline+' SELECT count(*) FROM deltas d WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);') == '0', 'income whole-population scalar parity'
    for role in ['anon','authenticated']:
        q('SELECT fn_pay_backed_payout_shortfalls();', 'permission denied for function', role=role)
    q('BEGIN; SELECT fn_pay_backed_payout_shortfalls(); ROLLBACK;', role='service_role')
    after_plan = json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+income_read(inline)))[0]
    assert q(income_read(inline)) == before_rows, 'incoming rows changed'
    assert any(n.get('Index Name') == 'idx_tournament_payouts_satellite_target' for n in nodes(after_plan['Plan'])), 'existing target index is not used'
    print(json.dumps({'scope':'private fixture, not provider latency','before_ms':before_plan['Execution Time'],'after_ms':after_plan['Execution Time'],'before_temp_written':before_plan['Plan']['Temp Written Blocks'],'after_temp_written':after_plan['Plan']['Temp Written Blocks']}))
    # The retained transaction sees neither a later payout nor ticket redemption;
    # the next statement sees both through the original scalar and candidate.
    args = [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres']
    connection = subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env)
    event = "md5('income-target')::uuid"
    comparison = 'SELECT json_build_array(fn_tournament_conservation_delta('+event+'),('+inline+' SELECT delta FROM deltas WHERE id='+event+'));'
    try:
        def exchange(sql):
            connection.stdin.write(sql+'\n'); connection.stdin.flush()
            line = connection.stdout.readline().strip()
            assert line, connection.stderr.read()
            return json.loads(line)
        initial = exchange('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; '+comparison)
        assert initial[0] == initial[1]
        q("BEGIN; INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata) VALUES(md5('income-source')::uuid,md5('income-fresh')::uuid,4,'satellite_seat',100000,jsonb_build_object('satellite_target_id',md5('income-target')::uuid::text)); UPDATE tournament_tickets SET status='redeemed' WHERE id=md5('income-ticket-15')::uuid; COMMIT;")
        assert exchange(comparison) == initial, 'income admitted later committed receipts into old snapshot'
        fresh = exchange('COMMIT; '+comparison)
        assert fresh[0] == fresh[1] == initial[0]+11, 'income fresh statement misses payout or ticket state'
        connection.stdin.close()
        assert connection.wait(timeout=5) == 0, connection.stderr.read()
    finally:
        if connection.poll() is None:
            connection.terminate(); connection.wait(timeout=5)
    print('backed-seat-income-native-acceptance-passed')
