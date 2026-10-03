"""Renewed batch qualification for 20261001151646 in the maintained private PG17 cluster.

The migration changes the maintained scalar (a satellite award is found by its
payout_id, and house-funded bubble protection counts as funding) and patches
the payer's inline batch delta to the same award key. The payer deliberately
does not carry the bubble term, so this proves the exact relationship instead
of claiming parity: the batch equals the scalar on every event, except that on
an event with paired bubble legs it reads exactly the scalar minus that term,
so the payer can only select and pay less, never more. The original captured
whole caller, which reads the scalar itself, is the whole-function oracle.
"""
import hashlib
import json
import subprocess


def qualify(context):
    q = context['query']; outcome = context['outcome']; f = context['FIXTURE']
    root = context['ROOT']; original = context['original']
    pg = context['pg']; socket = context['socket']; env = context['env']
    pins = json.loads((f/'seat-award-expectations.json').read_text())
    migration = (root/pins['migration']).read_text()
    assert migration.count('\nCOMMIT;') == 1 and migration.count('\nBEGIN;') == 1, 'one transaction'
    scalar_before = (f/'reviewed-return-scalar.sql').read_text()
    scalar_after = (f/'seat-award-scalar.sql').read_text()
    audit_before = (f/'seat-award-audit-preimage.sql').read_text()
    md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
    assert md5(scalar_before) == pins['scalarBeforeDefinitionMD5']
    assert md5(scalar_after) == pins['scalarDefinitionMD5']
    assert md5(audit_before) == pins['auditBeforeDefinitionMD5']
    payer_sig = 'fn_pay_backed_payout_shortfalls(boolean,integer)'
    scalar_sig = 'fn_tournament_conservation_delta(uuid)'
    audit_sig = 'fn_satellite_conservation_audit(integer)'
    definition = lambda sig: q("SELECT pg_get_functiondef('"+sig+"'::regprocedure);")+'\n'
    # The audit's escrow and journal tables are not part of this fixture. Its
    # body is pinned byte for byte by md5 before and after and never executed,
    # so only its body validation is deferred; every other function executes.
    nocheck = 'SET check_function_bodies = off;\n'
    q(nocheck+audit_before)
    old_payer = definition(payer_sig)
    assert md5(old_payer) == pins['payerBeforeDefinitionMD5'], 'payer preimage'
    assert md5(definition(scalar_sig)) == pins['scalarBeforeDefinitionMD5'], 'scalar preimage'
    assert md5(definition(audit_sig)) == pins['auditBeforeDefinitionMD5'], 'audit preimage'
    assert old_payer.count(pins['oldPayerJoin']) == pins['payerJoins']
    new_payer = old_payer.replace(pins['oldPayerJoin'], pins['newPayerJoin'])
    assert md5(new_payer) == pins['payerAfterDefinitionMD5'], 'payer postimage differs from the two award joins'

    def batch_prefix(text):
        start = text.index('    WITH eligible AS MATERIALIZED (')
        end = text.rindex('    SELECT t.id, t.name, t.club_id, t.prize_pool,')
        return text[start:end].replace('v_window_days', '30')
    old_prefix = batch_prefix(old_payer)
    new_prefix = batch_prefix(new_payer)

    # Every award already in the cluster is ranked: its place finds exactly one
    # payout. That is checked before the cases adopt it as the production key.
    assert q("SELECT count(*) FROM tournament_satellite_awards a WHERE (SELECT count(*) FROM tournament_payouts p WHERE p.tournament_id=a.tournament_id AND p.position=a.place) <> 1;") == '0', 'a ranked award does not name exactly one payout'
    q((f/'seat-award-cases.sql').read_text())
    q('CREATE TABLE fixture_old_deltas AS SELECT id, fn_tournament_conservation_delta(id) AS delta FROM tournaments;')

    # RED: the predecessor scalar and the predecessor batch both read the
    # issued, cash and cancelled NULL-position tickets as seats that arrived,
    # and make the balanced target a payer candidate.
    assert q("SELECT count(*) FROM fixture_expected_awards e WHERE fn_tournament_conservation_delta(md5(e.name)::uuid) IS DISTINCT FROM e.old_scalar;") == '0', 'predecessor oracle'
    assert q(old_prefix+" SELECT delta FROM deltas WHERE id=md5('award-target')::uuid;") == '40.00', 'predecessor batch'
    assert q(old_prefix+" SELECT count(*) FROM deltas WHERE id=md5('award-target')::uuid AND delta>0.01;") == '1'
    print('backed-seat-award-original-formula-red-reproduced')

    # The independent oracle under the maintained successor scalar, and the
    # whole-caller oracle: the original caller reading that scalar per event.
    q(scalar_after)
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='"+scalar_sig+"'::regprocedure;") == pins['scalarBodyMD5']
    assert q("SELECT count(*) FROM fixture_expected_awards e WHERE fn_tournament_conservation_delta(md5(e.name)::uuid) IS DISTINCT FROM e.scalar;") == '0', 'independent award/bubble oracle'
    q(original)
    pairs = [('false','500'),('true','500'),('NULL','500'),('false','0'),('false','-9'),('false','NULL'),('true','1')]
    expected = {pair: outcome(*pair) for pair in pairs}
    q(scalar_before); q(old_payer)
    assert md5(definition(payer_sig)) == pins['payerBeforeDefinitionMD5']
    assert md5(definition(scalar_sig)) == pins['scalarBeforeDefinitionMD5']
    catalog = "SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile) ORDER BY oid) FROM pg_proc WHERE oid IN ('"+payer_sig+"'::regprocedure,'"+scalar_sig+"'::regprocedure,'"+audit_sig+"'::regprocedure);"
    before_catalog = q(catalog)

    def unchanged():
        assert md5(definition(payer_sig)) == pins['payerBeforeDefinitionMD5'], 'payer moved by a refused install'
        assert md5(definition(scalar_sig)) == pins['scalarBeforeDefinitionMD5'], 'scalar moved by a refused install'
        assert md5(definition(audit_sig)) == pins['auditBeforeDefinitionMD5'], 'audit moved by a refused install'
    # Each guard refuses the whole transaction and leaves every function as it was.
    q("ALTER FUNCTION "+scalar_sig+" SET statement_timeout='9s';")
    q(nocheck+migration, 'fn_tournament_conservation_delta changed underneath this migration')
    q(scalar_before); unchanged()
    q("ALTER FUNCTION "+payer_sig+" SET statement_timeout='9s';")
    q(nocheck+migration, 'fn_pay_backed_payout_shortfalls(boolean,integer) changed underneath this migration')
    q(old_payer); unchanged()
    q('ALTER TABLE tournament_satellite_awards DROP CONSTRAINT tournament_satellite_awards_payout_id_key;')
    q(nocheck+migration, 'is no longer a NOT NULL, UNIQUE foreign key to tournament_payouts')
    q('ALTER TABLE tournament_satellite_awards ADD CONSTRAINT tournament_satellite_awards_payout_id_key UNIQUE (payout_id);'); unchanged()
    q("INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position) VALUES(md5('award-source')::uuid,md5('award-orphan')::uuid,1,'satellite_seat',NULL);")
    q(nocheck+migration, '1 satellite payout(s) of settled satellites have no award by payout_id')
    q("DELETE FROM tournament_payouts WHERE user_id=md5('award-orphan')::uuid;"); unchanged()
    q("CREATE FUNCTION fixture_place_reader() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM tournament_payouts p JOIN tournament_satellite_awards a ON a.tournament_id = p.tournament_id AND a.place = p.position $$;")
    q(nocheck+migration, 'a satellite award is still located by place = position in: fixture_place_reader()')
    q('DROP FUNCTION fixture_place_reader();'); unchanged()
    q(nocheck+migration.replace('\nCOMMIT;', "\nDO $$ BEGIN RAISE EXCEPTION 'award rollback'; END $$;\nCOMMIT;"), 'award rollback')
    unchanged()
    assert q(catalog) == before_catalog, 'refused installs changed function identity'

    q(nocheck+migration)
    q(nocheck+migration, 'fn_tournament_conservation_delta changed underneath this migration')
    assert definition(scalar_sig) == scalar_after, 'installed scalar is not the maintained successor fixture'
    assert definition(payer_sig) == new_payer, 'more than the two payer award joins changed'
    assert md5(definition(audit_sig)) == pins['auditAfterDefinitionMD5'], 'audit postimage'
    assert definition(audit_sig) == audit_before.replace('ON a.tournament_id = p.tournament_id AND a.place = p.position', 'ON a.payout_id = p.id'), 'more than the audit award join changed'
    assert q(catalog) == before_catalog, 'award install changed authority or function identity'

    # The successor oracle, the payer's batch oracle, and every other event.
    assert q("SELECT count(*) FROM fixture_expected_awards e WHERE fn_tournament_conservation_delta(md5(e.name)::uuid) IS DISTINCT FROM e.scalar;") == '0', 'installed award/bubble oracle'
    assert q(new_prefix+" SELECT count(*) FROM fixture_expected_awards e LEFT JOIN deltas d ON d.id=md5(e.name)::uuid WHERE d.delta IS DISTINCT FROM e.batch;") == '0', 'payer batch award/bubble oracle'
    changed = q("SELECT string_agg(t.name, ',' ORDER BY t.name) FROM fixture_old_deltas o JOIN tournaments t ON t.id=o.id WHERE o.delta IS DISTINCT FROM fn_tournament_conservation_delta(o.id);")
    assert changed == 'award-bubble,award-bubble-two-legs,award-bubble-two-payouts,award-target', 'ranked awards changed: '+changed
    # Whole population: the batch is the scalar, except exactly the paired
    # house bubble legs it does not carry, where it reads that much lower.
    gap = q(new_prefix+" SELECT coalesce(jsonb_object_agg(d.name, fn_tournament_conservation_delta(d.id) - d.delta), '{}') FROM deltas d WHERE d.delta IS DISTINCT FROM fn_tournament_conservation_delta(d.id);")
    assert json.loads(gap) == {'award-bubble': 180, 'award-bubble-two-legs': 50, 'award-bubble-two-payouts': 60}, 'batch differs from scalar beyond the bubble term: '+gap
    for pair, wanted in expected.items():
        assert outcome(*pair) == wanted, 'whole award caller differs '+str(pair)
    # Where the omitted term flips the sign the payer is conservative: the
    # scalar reads 130.00 retained, the batch -50.00, and nothing is selected.
    flip = q("BEGIN; INSERT INTO tournaments(id,name,club_id,prize_pool,ended_at,status) VALUES(md5('award-bubble-flip')::uuid,'award-bubble-flip',md5('club')::uuid,100,now()-interval '1 day','COMPLETED');"
             " INSERT INTO wallet_transactions(related_entity_id,type,category,amount) VALUES(md5('award-bubble-flip')::uuid,'debit','tournament_buyin',230),(md5('award-bubble-flip')::uuid,'credit','prize',280);"
             " INSERT INTO chip_ledger(tournament_id,amount,category,to_type) VALUES(md5('award-bubble-flip')::uuid,180,'correction','prize_liability');"
             " INSERT INTO tournament_payouts(tournament_id,user_id,amount,source) VALUES(md5('award-bubble-flip')::uuid,md5('award-bubble-user')::uuid,180,'bubble_protection');"
             " SELECT json_build_array(fn_tournament_conservation_delta(md5('award-bubble-flip')::uuid),("+new_prefix+" SELECT delta FROM deltas WHERE id=md5('award-bubble-flip')::uuid),"
             " ("+new_prefix+" SELECT count(*) FROM deltas WHERE id=md5('award-bubble-flip')::uuid AND delta>0.01)); ROLLBACK;")
    assert json.loads(flip) == [130, -50, 0], 'payer is not conservative where it omits the bubble term: '+flip
    for role in ['anon', 'authenticated']:
        q('SELECT fn_pay_backed_payout_shortfalls();', 'permission denied for function', role=role)
        q("SELECT fn_tournament_conservation_delta(md5('award-target')::uuid);", 'permission denied for function', role=role)
    q('BEGIN; SELECT fn_pay_backed_payout_shortfalls(); ROLLBACK;', role='service_role')

    # A retained snapshot sees neither a later award nor its payout; the next
    # statement sees both, through the scalar and the payer batch alike.
    args = [str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(socket),'-U','fixture_admin','-d','postgres']
    connection = subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env)
    event = "md5('award-target')::uuid"
    comparison = 'SELECT json_build_array(fn_tournament_conservation_delta('+event+'),('+new_prefix+' SELECT delta FROM deltas WHERE id='+event+'));'
    try:
        def exchange(sql):
            connection.stdin.write(sql+'\n'); connection.stdin.flush()
            line = connection.stdout.readline().strip()
            assert line, connection.stderr.read()
            return json.loads(line)
        initial = exchange('SET ROLE postgres; BEGIN ISOLATION LEVEL REPEATABLE READ; '+comparison)
        assert initial[0] == initial[1] == 0
        q("BEGIN; INSERT INTO tournament_tickets VALUES(md5('award-ticket-9')::uuid,'redeemed');"
          " WITH p AS (INSERT INTO tournament_payouts(tournament_id,user_id,amount,source,position,metadata) VALUES(md5('award-source')::uuid,md5('award-user-9')::uuid,15,'satellite_ticket',NULL,jsonb_build_object('satellite_target_id',md5('award-target')::uuid::text)) RETURNING id)"
          " INSERT INTO tournament_satellite_awards(tournament_id,place,ticket_id,delivery_kind,payout_id) SELECT md5('award-source')::uuid,9,md5('award-ticket-9')::uuid,'ticket',id FROM p; COMMIT;")
        assert exchange(comparison) == initial, 'award admitted a later committed receipt into the old snapshot'
        fresh = exchange('COMMIT; '+comparison)
        assert fresh[0] == fresh[1] == initial[0]+15, 'award fresh statement misses the committed award'
        connection.stdin.close()
        assert connection.wait(timeout=5) == 0, connection.stderr.read()
    finally:
        if connection.poll() is None:
            connection.terminate(); connection.wait(timeout=5)
    print('backed-seat-award-native-acceptance-passed')
