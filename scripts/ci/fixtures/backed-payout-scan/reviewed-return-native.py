"""Successor acceptance, called by the maintained native runner after baseline.
Uses its existing real PG17 cluster and unchanged reconciliation adapter.
"""
import hashlib,json,subprocess
from pathlib import Path

def qualify(context):
    query=context['query']; check=context['check']; outcome=context['outcome']
    fixture=context['FIXTURE']; root=context['ROOT']; oldbatch=context['expected']
    original=context['original']; oldscalar=context['scalar']; oldprefix=context['prefix']
    pg=context['pg']; socket=context['socket']; env=context['env']
    scalar=(fixture/'reviewed-return-scalar.sql').read_text()
    scan=(fixture/'reviewed-return-batch-selection.sql').read_text().rstrip()
    migration=(root/'supabase/migrations/20260927163648_backed_payout_discovery_follows_reviewed_overlay_returns.sql').read_text()
    pins=json.loads((fixture/'reviewed-return-expectations.json').read_text())
    assert '$scan$'+scan+'$scan$' in migration
    assert hashlib.md5(scalar.encode()).hexdigest()==pins['scalarDefinitionMD5']
    prefix=scan[:scan.rindex('    SELECT t.id, t.name, t.club_id, t.prize_pool,')].replace('v_window_days','30')
    # A pending separate scalar is a true admission dependency, not an implied
    # permission to install another owner's migration from this qualification.
    query(migration,'BACKED_PAYOUT_RETURN_PREIMAGE_CHANGED')
    query((fixture/'reviewed-return-cases.sql').read_text())
    query(scalar)
    check("md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure))='"+pins['scalarDefinitionMD5']+"'",'exact maintained successor scalar')
    check("md5((SELECT prosrc FROM pg_proc WHERE oid='fn_tournament_conservation_delta(uuid)'::regprocedure))='"+pins['scalarBodyMD5']+"'",'exact successor body')
    check("NOT EXISTS(SELECT FROM fixture_expected_returns e WHERE fn_tournament_conservation_delta(md5('return-'||e.n)::uuid) IS DISTINCT FROM round(13-e.amount,2))",'independent signed/NULL/identity/metadata/rounding return oracle')
    assert int(query(oldprefix+" SELECT count(*) FROM deltas d WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);"))>0,'predecessor batch must reproduce the reviewed-return mismatch'
    print('backed-payout-return-original-formula-red-reproduced')
    # The original captured whole caller still reads the scalar itself. It is
    # the independent whole-function oracle under the successor formula.
    query(original)
    expected={(a,l):outcome(a,l) for a,l in [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]}
    query(oldbatch)
    catalog="SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"
    before=query(catalog)
    query("GRANT EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) TO authenticated;")
    query(migration,'BACKED_PAYOUT_RETURN_AUTHORITY_CHANGED')
    query("REVOKE EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) FROM authenticated;")
    query('DROP INDEX idx_chip_ledger_tournament_category;')
    query(migration,'BACKED_PAYOUT_RETURN_LEDGER_INDEX_CHANGED')
    query(pins['ledgerIndexDefinition']+';')
    query('ALTER TABLE chip_ledger ALTER COLUMN metadata TYPE json USING metadata::json;')
    query(migration,'BACKED_PAYOUT_RETURN_COLUMNS_CHANGED')
    query('ALTER TABLE chip_ledger ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb;')
    query(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'successor rollback'; END $$; COMMIT;"),'successor rollback')
    check("md5(pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure))='"+pins['previousBatchDefinitionMD5']+"'",'successor transaction rollback')
    query(migration)
    query(migration,'BACKED_PAYOUT_RETURN_PREIMAGE_CHANGED')
    check("md5(pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure))='"+pins['batchDefinitionMD5']+"'",'successor exact result')
    assert query(catalog)==before,'successor authority/OIDs/config changed'
    for pair,wanted in expected.items():assert outcome(*pair)==wanted,'whole successor caller differs '+str(pair)
    assert query(prefix+" SELECT count(*) FROM deltas d WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);")=='0','whole-population scalar parity'
    for role in ['anon','authenticated']:
        query('SELECT fn_pay_backed_payout_shortfalls();','permission denied for function',role=role)
    query('BEGIN; SELECT fn_pay_backed_payout_shortfalls(); ROLLBACK;',role='service_role')
    # Same snapshot sees the same committed return on both paths; retain
    # exact equality while a second real session inserts a recorded return.
    command=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres']
    connection=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env)
    event="md5('return-4')::uuid"
    comparison="SELECT json_build_array(fn_tournament_conservation_delta("+event+"),("+prefix+" SELECT delta FROM deltas WHERE id="+event+"));"
    try:
        def exchange(sql):
            connection.stdin.write(sql+'\n');connection.stdin.flush()
            line=connection.stdout.readline().strip();assert line,connection.stderr.read()
            return json.loads(line)
        initial=exchange('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; '+comparison)
        assert initial[0]==initial[1]
        query("INSERT INTO chip_ledger(tournament_id,amount,category,from_type,from_entity_id,metadata) VALUES("+event+",3,'reversal','prize_liability',"+event+",'{\"kind\":\"reviewed_void_overlay_return\"}');")
        assert exchange(comparison)==initial,'return leaked into retained statement snapshot'
        fresh=exchange('COMMIT; '+comparison)
        assert fresh[0]==fresh[1]==initial[0]-3,'fresh statement missed committed return'
        connection.stdin.close();assert connection.wait(timeout=5)==0,connection.stderr.read()
    finally:
        if connection.poll() is None:connection.terminate();connection.wait(timeout=5)
    print('backed-payout-reviewed-return-native-acceptance-passed')
