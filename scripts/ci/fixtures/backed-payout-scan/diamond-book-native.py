"""A Diamond tournament is conserved by its own Diamond book (2026-10-09),
qualified in the maintained private PG17 cluster after every earlier
backed-payout qualification.

The migration patches three live definitions through pg_get_functiondef and
EXECUTE: the scalar (fn_tournament_conservation_delta), the one-pass set
function and the backed payout sweep. Each preimage here is the qualified
predecessor, installed by the earlier qualifications; each successor must be
exactly the migration's own anchored swaps applied to it. The Diamond escrow
reader and the Diamond event test are installed verbatim from the migrations
that define them, over a fixture Diamond ledger. Every expected delta comes
from diamond-book-cases.sql's own arithmetic, not from either formula.

Outside a platform Diamond event nothing may change: every other event keeps
its predecessor delta to the cent, and the successor sweep's whole financial
output (alerts, log, reconciler calls, wallets) with the Diamond events
present equals the predecessor's with them absent. No production identity is
used; the seven ids the migration's proof names are fixture rows.
"""
import hashlib
import json
import re

SCALAR = 'fn_tournament_conservation_delta(uuid)'
SET = 'fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'
BATCH = 'fn_pay_backed_payout_shortfalls(boolean,integer)'


def last_definition(sql, name):
    found = re.findall(r'CREATE OR REPLACE FUNCTION public\.' + re.escape(name)
                       + r'\(p_tournament_id uuid\)\n.*?\n\$function\$;', sql, re.S)
    assert found, name + ' definition'
    return found[-1]


def qualify(context):
    q = context['query']; check = context['check']
    f = context['FIXTURE']; root = context['ROOT']
    pins = json.loads((f/'diamond-book-expectations.json').read_text())
    migration = (root/pins['migration']).read_text()
    scalar = (f/'diamond-book-scalar.sql').read_text()
    md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
    assert md5(scalar) == pins['scalarDefinitionMD5'], 'scalar fixture bytes'
    for key in ['scalarBeforeMD5', 'scalarDefinitionMD5', 'setBeforeMD5', 'setAfterMD5',
                'batchBeforeMD5', 'batchAfterMD5']:
        assert pins[key] in migration, 'the migration pins '+key
    defn = lambda fn: q("SELECT pg_get_functiondef('"+fn+"'::regprocedure);")+'\n'
    before = {'v_scalar': defn(SCALAR), 'v_set': defn(SET), 'v_batch': defn(BATCH)}
    assert md5(before['v_scalar']) == pins['scalarBeforeMD5'], 'the live scalar is the qualified predecessor'
    assert md5(before['v_set']) == pins['setBeforeMD5'], 'the live set function is the qualified predecessor'
    assert md5(before['v_batch']) == pins['batchBeforeMD5'], 'the live batch is the qualified predecessor'
    # The successors are the migration's own anchored swaps, each found once.
    swaps = re.findall(r"pg_temp\.ca_swap_once\((v_\w+),\n\$a\$(.*?)\$a\$,\n\$a\$(.*?)\$a\$, '([^']+)'\);", migration, re.S)
    assert [s[0] for s in swaps].count('v_scalar') == 3 and len(swaps) == 7, 'swap inventory'
    after = dict(before)
    for var, old, new, what in swaps:
        assert after[var].count(old) == 1, 'anchor '+what
        after[var] = after[var].replace(old, new)
    assert after['v_scalar'] == scalar, 'swap bytes: scalar'
    assert md5(after['v_set']) == pins['setAfterMD5'], 'swap bytes: set function'
    assert md5(after['v_batch']) == pins['batchAfterMD5'], 'swap bytes: batch'

    q((f/'diamond-book-cases.sql').read_text())
    for key, name in [('escrowSource', 'fn_poker_diamond_tournament_escrow'),
                      ('predicateSource', 'fn_poker_diamond_tournament')]:
        q(last_definition((root/pins[key]).read_text(), name))
        q('REVOKE ALL ON FUNCTION public.'+name+'(uuid) FROM PUBLIC,anon,authenticated; '
          'GRANT EXECUTE ON FUNCTION public.'+name+'(uuid) TO service_role;')
    q('ANALYZE;')

    delta = lambda name: q("SELECT fn_tournament_conservation_delta(id) FROM tournaments WHERE name='"+name+"';")
    reported = ['db-reported-'+str(n) for n in range(1, 8)]
    red = {'db-sat': '-200.00', 'db-target': '200.00', 'db-held': '999.00',
           'db-union-event': '0.00', 'db-union-club': '40.00', 'db-private': '25.00',
           'db-chip-platform': '-15.00', **{n: '-200.00' for n in reported}}
    for name, wanted in red.items():
        assert delta(name) == wanted, 'original formula '+name+' read '+delta(name)
    assert q("SELECT string_agg(name, ',' ORDER BY name) FROM tournaments WHERE fn_poker_diamond_tournament(id);") == \
        ','.join(sorted(['db-sat', 'db-target', 'db-held'] + reported)), 'the Diamond event test'
    print('backed-payout-diamond-book-original-formula-red-reproduced')

    target = q("SELECT md5('db-target')::uuid;")
    def sweep(apply, limit, without_diamond):
        # Whole financial output, then abort the same private transaction. An
        # alert's own row id and clock (defaults the conservation fixture
        # added) are not output; every other alert column is.
        prelude = 'DELETE FROM tournaments WHERE fn_poker_diamond_tournament(id); ' if without_diamond else ''
        out = q('BEGIN; '+prelude+'SELECT public.fn_pay_backed_payout_shortfalls('+apply+','+limit+');'+'''
          SELECT jsonb_build_object(
           'alerts',(SELECT jsonb_agg(to_jsonb(a)-'id'-'created_at' ORDER BY context::text, message) FROM financial_alerts a),
           'log',(SELECT jsonb_agg(to_jsonb(b) ORDER BY tournament_id) FROM tournament_payout_backfill_log b),
           'calls',(SELECT jsonb_agg(to_jsonb(c)) FROM fixture_reconcile_calls c),
           'wallets',(SELECT jsonb_agg(to_jsonb(w)-'id' ORDER BY related_entity_id,type,category,amount,user_id)
                      FROM wallet_transactions w)); ROLLBACK;''')
        return [json.loads(line) for line in out.splitlines()]
    paid = sweep('true', '500', False)
    assert any(c['tournament_id'] == target and c['applying'] for c in (paid[1]['calls'] or [])), \
        'predecessor batch must pay the Diamond target through the chip book'
    print('backed-payout-diamond-book-chip-payment-reproduced')

    pairs = [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]
    expected = {pair: sweep(*pair, True) for pair in pairs}
    old_deltas = json.loads(q('SELECT jsonb_object_agg(id, fn_tournament_conservation_delta(id)) FROM tournaments WHERE NOT fn_poker_diamond_tournament(id);'))
    assert len(old_deltas) > 12000, 'the whole fixture population'
    catalog = ("SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) "
               "FROM pg_proc WHERE oid IN ('"+SCALAR+"'::regprocedure,'"+SET+"'::regprocedure,'"+BATCH+"'::regprocedure);")
    before_catalog = q(catalog)

    for fn in [SCALAR, SET, BATCH]:
        q("ALTER FUNCTION "+fn+" SET statement_timeout='9s';")
        q(migration, 'DIAMOND_BOOK_PREIMAGE_CHANGED')
        q('ALTER FUNCTION '+fn+' RESET statement_timeout;')
    q(migration.replace('COMMIT;', "DO $$ BEGIN RAISE EXCEPTION 'diamond rollback'; END $$; COMMIT;"), 'diamond rollback')
    for var, fn in [('v_scalar', SCALAR), ('v_set', SET), ('v_batch', BATCH)]:
        assert defn(fn) == before[var], 'diamond transaction rollback '+fn
    q(migration)
    q(migration)  # a second run reports itself applied and proves again
    for var, fn in [('v_scalar', SCALAR), ('v_set', SET), ('v_batch', BATCH)]:
        assert defn(fn) == after[var], 'more than the anchored swaps changed in '+fn
    assert q(catalog) == before_catalog, 'diamond successor changed authority or function identity'

    green = {**red, 'db-sat': '0.00', 'db-target': '0.00', 'db-held': '69.00', **{n: '0.00' for n in reported}}
    for name, wanted in green.items():
        assert delta(name) == wanted, 'successor '+name+' read '+delta(name)
    new_deltas = json.loads(q('SELECT jsonb_object_agg(id, fn_tournament_conservation_delta(id)) FROM tournaments WHERE NOT fn_poker_diamond_tournament(id);'))
    assert new_deltas == old_deltas, 'a non-Diamond delta changed'
    assert q('''SELECT count(*) FROM tournaments t, fn_poker_diamond_tournament_escrow(t.id) x
                WHERE fn_poker_diamond_tournament(t.id)
                  AND fn_tournament_conservation_delta(t.id) IS DISTINCT FROM round(x.prize_balance+x.bounty_balance+x.fee_balance, 2);''') == '0', \
        'a Diamond delta is not its escrow balance'
    assert q("""SELECT count(*) FROM fn_tournament_conservation_deltas('-infinity','infinity') d
                WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);""") == '0', \
        'diamond whole-population scalar parity'
    assert q("SELECT count(*) FROM fn_tournament_conservation_deltas('-infinity','infinity') d WHERE fn_poker_diamond_tournament(d.id);") != '0', \
        'the set function reads the Diamond events'
    print('backed-payout-diamond-book-parity-passed')

    for pair, wanted in expected.items():
        got = sweep(*pair, False)
        assert got == wanted, 'whole successor caller differs '+str(pair)+' '+json.dumps(got[0])+' vs '+json.dumps(wanted[0])
        assert not any(c['tournament_id'] == target for c in (got[1]['calls'] or [])), 'the chip sweep read a Diamond event'
    # The next statement reads a committed Diamond leg; nothing is cached.
    q("INSERT INTO poker_diamond_tournament_ledger(tournament_id,kind,amount) VALUES(md5('db-held')::uuid,'prize',4);")
    assert delta('db-held') == '65.00', 'fresh statement missed committed Diamond leg'
    q("DELETE FROM poker_diamond_tournament_ledger WHERE tournament_id=md5('db-held')::uuid AND kind='prize' AND amount=4;")
    for role in ['anon', 'authenticated']:
        q("SELECT fn_tournament_conservation_delta(md5('db-held')::uuid);", 'permission denied for function', role=role)
    assert q("SELECT fn_tournament_conservation_delta(md5('db-held')::uuid);", role='service_role') == '69.00'
    print('backed-payout-diamond-book-native-acceptance-passed')
