"""Ticket and house-funding successor, qualified in the maintained private PG17
cluster after every earlier backed-payout qualification (2026-10-03).

The original captured whole caller reads the scalar itself, so under the
successor scalar it is the independent whole-financial-output oracle for the
successor batch. Every expected delta comes from ticket-funding-cases.sql's
own arithmetic, not from either formula. No production identity is used.
"""
import hashlib
import json


def qualify(context):
    q = context['query']; check = context['check']; outcome = context['outcome']
    f = context['FIXTURE']; root = context['ROOT']; original = context['original']
    pins = json.loads((f/'ticket-funding-expectations.json').read_text())
    migration = (root/pins['migration']).read_text()
    scalar = (f/'ticket-funding-scalar.sql').read_text()
    old_scalar = (f/'reviewed-return-scalar.sql').read_text()
    assert hashlib.md5(scalar.encode()).hexdigest() == pins['scalarDefinitionMD5'], 'scalar fixture bytes'
    assert scalar.rstrip('\n') + ';' in migration, 'the migration declares the fixture scalar verbatim'
    defn = lambda fn: q("SELECT pg_get_functiondef('"+fn+"'::regprocedure);")+'\n'
    old_batch = defn('fn_pay_backed_payout_shortfalls(boolean,integer)')
    assert hashlib.md5(old_batch.encode()).hexdigest() == pins['batchBeforeMD5'], 'the live batch is the qualified predecessor'
    assert hashlib.md5(defn('fn_tournament_conservation_delta(uuid)').encode()).hexdigest() == pins['scalarBeforeMD5'], 'the live scalar is the qualified predecessor'
    new_batch = old_batch
    for r in pins['replacements']:
        assert old_batch.count(r['old']) == r['count'], r['old']
        new_batch = new_batch.replace(r['old'], r['new'])
    assert hashlib.md5(new_batch.encode()).hexdigest() == pins['batchAfterMD5'], 'batch replacement bytes'

    q((f/'ticket-funding-cases.sql').read_text())
    delta = lambda name: q("SELECT fn_tournament_conservation_delta(md5('"+name+"')::uuid);")
    events = ['tf-sat', 'tf-sat-2', 'tf-sat-3', 'tf-ticket-target', 'tf-malformed-target',
              'tf-correction-target', 'tf-overlay-and-correction', 'tf-phantom-backing']
    red = {'tf-ticket-target': '200.00', 'tf-correction-target': '-180.00',
           'tf-overlay-and-correction': '-50.00', 'tf-phantom-backing': '100.00'}
    for name in events:
        assert delta(name) == red.get(name, '0.00'), 'original formula '+name+' read '+delta(name)
    print('backed-payout-ticket-funding-original-formula-red-reproduced')

    pairs = [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]
    # The predecessor batch pays the phantom backing when applying.
    paid = json.loads(outcome('true','500').splitlines()[1])
    assert any(c['tournament_id'] == q("SELECT md5('tf-phantom-backing')::uuid;") and c['applying']
               for c in (paid['calls'] or [])), 'predecessor batch must pay the phantom backing'
    print('backed-payout-ticket-funding-phantom-payment-reproduced')

    q(original)
    q(scalar)
    for name in events:
        assert delta(name) == '0.00', 'successor '+name+' read '+delta(name)
    expected = {pair: outcome(*pair) for pair in pairs}
    withheld = json.loads(expected[('true','500')].splitlines()[1])
    assert not any(c['tournament_id'] == q("SELECT md5('tf-phantom-backing')::uuid;") and c['applying']
                   for c in (withheld['calls'] or [])), 'successor oracle must not pay the phantom backing'

    q(old_scalar)
    q(old_batch)
    catalog = "SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) FROM pg_proc WHERE oid IN ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'fn_tournament_conservation_delta(uuid)'::regprocedure);"
    before_catalog = q(catalog)
    q('GRANT EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) TO authenticated;')
    q(migration, 'TICKET_FUNDING_AUTHORITY_CHANGED')
    q('REVOKE EXECUTE ON FUNCTION fn_pay_backed_payout_shortfalls(boolean,integer) FROM authenticated;')
    q("ALTER FUNCTION fn_tournament_conservation_delta(uuid) SET statement_timeout='9s';")
    q(migration, 'TICKET_FUNDING_PREIMAGE_CHANGED')
    q(old_scalar)
    q(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'ticket rollback'; END $$; COMMIT;"), 'ticket rollback')
    check("md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure))='"+pins['scalarBeforeMD5']+"' AND md5(pg_get_functiondef('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure))='"+pins['batchBeforeMD5']+"'", 'ticket transaction rollback')
    q(migration)
    q(migration, 'TICKET_FUNDING_PREIMAGE_CHANGED')
    check("md5(pg_get_functiondef('fn_tournament_conservation_delta(uuid)'::regprocedure))='"+pins['scalarDefinitionMD5']+"'", 'exact successor scalar')
    check("md5((SELECT prosrc FROM pg_proc WHERE oid='fn_tournament_conservation_delta(uuid)'::regprocedure))='"+pins['scalarBodyMD5']+"'", 'exact successor body')
    assert defn('fn_pay_backed_payout_shortfalls(boolean,integer)') == new_batch, 'more than the four batch blocks changed'
    assert q(catalog) == before_catalog, 'ticket successor changed authority or function identity'
    for pair, wanted in expected.items():
        assert outcome(*pair) == wanted, 'whole successor caller differs '+str(pair)
    start = new_batch.index('    WITH eligible AS MATERIALIZED (')
    end = new_batch.rindex('    SELECT t.id, t.name, t.club_id, t.prize_pool,')
    prefix = new_batch[start:end].replace('v_window_days', '30')
    assert q(prefix+' SELECT count(*) FROM deltas d WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);') == '0', 'ticket whole-population scalar parity'
    for role in ['anon', 'authenticated']:
        q('SELECT fn_pay_backed_payout_shortfalls();', 'permission denied for function', role=role)
        q("SELECT fn_tournament_conservation_delta(md5('tf-sat')::uuid);", 'permission denied for function', role=role)
    q('BEGIN; SELECT fn_pay_backed_payout_shortfalls(); ROLLBACK;', role='service_role')
    print('backed-payout-ticket-funding-native-acceptance-passed')
