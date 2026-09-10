"""Real funded Heads-Up entries through the cumulative prize writer.

Winner identity is synthetic input. This proof does not claim authoritative
elimination, fee attribution, seat exit, or a paid terminal-settlement receipt.
"""
from pathlib import Path
import hashlib
import json
import re

import tournament_heads_up_ladder_cases as ladder

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/heads-up-payout'
event = ladder.event
observations = []
runtime_catalog = []


def install_archive(q, text):
    # Import captured schema/function SQL into a new private fixture. The HU
    # support catalog already owns financial_alerts; preserve its exact columns.
    definitions = []
    pattern = r'CREATE OR REPLACE FUNCTION public[.]([a-z0-9_]+)\(.*?\bAS\s+(\$[A-Za-z0-9_]*\$).*?\2;'
    def keep(match):
        definitions.append(match.group(0))
        return ''
    ddl = re.sub(pattern, keep, text, flags=re.S)
    existing_tables = set(json.loads(q("SELECT json_agg(relname) FROM pg_class WHERE relnamespace='public'::regnamespace;")))
    existing_constraints = set(json.loads(q("SELECT json_agg(conname) FROM pg_constraint;")))
    existing_triggers = set(json.loads(q("SELECT json_agg(tgname) FROM pg_trigger;")))
    statements = []
    for statement in ddl.split(';'):
        statement = statement.strip()
        if not statement:
            continue
        table = re.match(r'CREATE TABLE public[.]([a-z0-9_]+) ', statement)
        constraint = re.match(r'ALTER TABLE public[.][a-z0-9_]+ ADD CONSTRAINT ([a-z0-9_]+) ', statement)
        index = re.match(r'CREATE (?:UNIQUE )?INDEX ([a-z0-9_]+) ', statement)
        trigger = re.match(r'CREATE TRIGGER ([a-z0-9_]+) ', statement)
        assert table or constraint or index or trigger, statement
        if table and table[1] in existing_tables:
            continue
        if constraint and constraint[1] in existing_constraints:
            continue
        if index and index[1] in existing_tables:
            continue
        if trigger:
            if trigger[1] not in existing_triggers:
                statements.append(statement + ';')
            continue
        statements.insert(0 if table else len(statements), statement + ';')
    # Functions must exist before trigger DDL and tables before rowtype parsing.
    table_statements = [s for s in statements if not s.startswith('CREATE TRIGGER')]
    trigger_statements = [s for s in statements if s.startswith('CREATE TRIGGER')]
    q('BEGIN; SET LOCAL check_function_bodies=off;\n' +
      '\n'.join(table_statements + definitions + trigger_statements) + '\nCOMMIT;')


def prepare(q):
    global runtime_catalog
    manifest = json.loads((fixture / 'source-manifest.json').read_text())
    raw = (fixture / 'installed.sql').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest['archive_sql_sha256']
    install_archive(q, raw.decode())
    for row in manifest['functions']:
        actual = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure;" % row['signature'])
        assert actual == row['body_md5'], (row['signature'], actual)
    path = repo / manifest['approved_migration']
    source = path.read_bytes()
    assert hashlib.sha256(source).hexdigest() == manifest['approved_migration_sha256']
    match = re.search(
        r'CREATE OR REPLACE FUNCTION public[.]fn_settle_tournament_obligation_before_atomic_batch_gate\b.*?AS (\$[A-Za-z0-9_]*\$)(.*?)\1;',
        source.decode(), re.S)
    assert match and hashlib.md5(match[2].encode()).hexdigest() == manifest['approved_body_md5']
    # Only import the already-applied body; production ACL/source gates are not
    # run against this deliberately separate local role and fixture schema.
    q(match.group(0))
    ladder.prepare(q)
    expected = {row['signature']: row['body_md5'] for row in manifest['functions']}
    expected['fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'] = manifest['approved_body_md5']
    expected['fn_tournament_payouts_are_append_only()'] = ladder.selected['fn_tournament_payouts_are_append_only']
    for signature, body in expected.items():
        assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure;" % signature) == body
    signatures = ','.join("'public." + signature + "'::regprocedure" for signature in expected)
    actual = json.loads(q("""SELECT json_agg(json_build_object(
        'signature',p.oid::regprocedure::text,'body_md5',md5(prosrc),
        'definition_md5',md5(pg_get_functiondef(p.oid)),
        'owner',pg_get_userbyid(proowner),'acl',proacl,'security_definer',prosecdef,
        'config',proconfig) ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p WHERE p.oid IN (""" + signatures + ');'))
    if runtime_catalog:
        assert actual == runtime_catalog
    runtime_catalog = actual


def verify_launched(q, snapshot, variant, chips, check, overlap):
    ladder.verify_launched(q, snapshot, variant, chips, check)
    winner = 'c1000000-0000-4000-8000-' + ('1' if variant == 'nlh' else '2').zfill(12)
    other = 'c1000000-0000-4000-8000-' + ('2' if variant == 'nlh' else '1').zfill(12)
    def settle(user):
        # The cumulative amount comes from the installed reader over the real
        # funded field. No prize/obligation/credit receipt is seeded by the test.
        return """SELECT fn_settle_tournament_obligation(
            '%s','place',a.place,'%s',a.amount,'engine.audit.hu-funded')
            FROM fn_ca_tournament_place_amounts('%s') a;""" % (event,user,event)

    q("""CREATE FUNCTION probe_hu_payout_receipt_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected HU payout receipt failure'; END $$;
        CREATE TRIGGER zzzzz_probe_hu_payout_receipt_failure BEFORE INSERT ON tournament_payouts
        FOR EACH ROW EXECUTE FUNCTION probe_hu_payout_receipt_failure();""")
    before = snapshot()
    q(settle(winner), 'injected HU payout receipt failure')
    rollback_after = snapshot()
    assert rollback_after == before, 'failed payout receipt changed a funded source relation'
    rollback_hashes = dict(before_sha256=hashlib.sha256(before.encode()).hexdigest(),
                           after_sha256=hashlib.sha256(rollback_after.encode()).hexdigest(),
                           public_table_count=len(json.loads(before)))
    q('DROP TRIGGER zzzzz_probe_hu_payout_receipt_failure ON tournament_payouts; DROP FUNCTION probe_hu_payout_receipt_failure();')
    check(variant + ' ' + str(chips) + ': late actual payout receipt failure rolls every funded source relation back')

    first, retry = overlap(settle(winner), settle(winner))
    assert first['paid'] == 380 and first['fully_settled'] is True, first
    assert retry['paid'] == 0 and retry['amount_paid'] == 380 and retry['fully_settled'] is True, retry
    state = json.loads(q("""SELECT json_build_object(
        'wallets',(SELECT sum(chip_balance) FROM club_members),
        'winner_balance',(SELECT chip_balance FROM club_members WHERE user_id='%s'),
        'prize',(SELECT prize_balance FROM tournament_escrow),
        'fee',(SELECT fee_balance FROM tournament_escrow),
        'bounty',(SELECT bounty_balance FROM tournament_escrow),
        'gross',(SELECT gross_in FROM tournament_escrow),
        'payouts',(SELECT count(*) FROM tournament_payouts),
        'paid',(SELECT sum(amount) FROM tournament_payouts),
        'owed',(SELECT sum(amount_owed) FROM tournament_obligations),
        'obligation_paid',(SELECT sum(amount_paid) FROM tournament_obligations),
        'obligations',(SELECT count(*) FROM tournament_obligations),
        'credits',(SELECT count(*) FROM wallet_credit_idempotency),
        'credit_receipts',(SELECT count(*) FROM wallet_transactions WHERE type='credit'),
        'journal_payments',(SELECT sum(amount) FROM chip_ledger WHERE from_type='prize_liability'),
        'status',(SELECT status FROM tournaments),
        'terminal_receipts',(SELECT count(*) FROM tournament_terminal_settlements),
        'seated',(SELECT count(*) FROM table_seats WHERE left_at IS NULL)
    );""" % winner))
    expected = dict(wallets=1980,winner_balance=680,prize=0,fee=20,bounty=0,gross=400,
                    payouts=1,paid=380,owed=380,obligation_paid=380,obligations=1,
                    credits=1,credit_receipts=1,journal_payments=380,status='RUNNING',
                    terminal_receipts=0,seated=2)
    assert state == expected, (state, expected)
    assert state['wallets'] + state['prize'] + state['fee'] + state['bounty'] == 2000
    exact = q("""SELECT count(*) FROM tournament_obligations o
        JOIN tournament_payouts p ON p.tournament_id=o.tournament_id AND p.position=o.place
        JOIN wallet_credit_idempotency k ON k.key=p.idempotency_key
        JOIN wallet_transactions w ON w.user_id=p.user_id AND w.related_entity_id=p.tournament_id
          AND w.type='credit' AND w.amount=p.amount
        WHERE o.tournament_id='%s' AND o.kind='place' AND o.place=1
          AND o.user_id='%s' AND p.user_id=o.user_id AND k.user_id=o.user_id
          AND o.amount_owed=380 AND o.amount_paid=380 AND p.amount=380 AND k.amount=380
          AND w.balance_after=680 AND p.source='structure';""" % (event,winner))
    assert exact == '1', 'one exact obligation/payout/key/wallet receipt chain is required'
    check(variant + ' ' + str(chips) + ': overlapping actual cumulative payments exhaust funded prize once and retain fee custody')

    before = snapshot()
    replay = json.loads(q(settle(winner)))
    assert replay['paid'] == 0 and replay['fully_settled'] is True, replay
    refused = json.loads(q(settle(other)))
    assert refused['refused_reason'] == 'place_paid_to_another_user', refused
    q('UPDATE tournament_payouts SET amount=379;', 'append-only payout record')
    q('DELETE FROM tournament_payouts;', 'append-only payout record')
    after = snapshot()
    assert after == before, 'retry, recipient refusal, or history refusal changed a public source row'
    check(variant + ' ' + str(chips) + ': exact replay and wrong-recipient or history refusals preserve all payment evidence')
    observations.append(dict(variant=variant,starting_stack=chips,winner=winner,state=state,
                             exact_receipt_chain=True,late_failure_rollback_exact=True,
                             concurrent_replay_paid=retry['paid'],refusal_unchanged=True,
                             late_failure_snapshot=rollback_hashes,
                             replay_before_sha256=hashlib.sha256(before.encode()).hexdigest(),
                             replay_after_sha256=hashlib.sha256(after.encode()).hexdigest()))


def evidence():
    assert len(observations) == 4 and len(runtime_catalog) == 9, 'all four paid compositions must run before evidence is emitted'
    manifest = json.loads((fixture / 'source-manifest.json').read_text())
    return dict(scope='Real funded HU admission and launch through installed amount and cumulative prize writers',
                funded_ladder=ladder.evidence(),source_manifest=manifest,
                exercised_runtime_catalog=runtime_catalog,variants=observations,
                production_mutations=False,stage_b_installed=False,
                prize_payment_exercised=True,terminal_payment_exercised=False,
                limits=['Winner identity is synthetic input; no authoritative elimination or hand witness is claimed.',
                        'All financial credits, receipts and escrow changes use actual captured approved writers.',
                        'The native dependency roles are fixture roles, not proof of production ACL or HTTP/RLS parity.',
                        'Fee custody stays 20; seats remain live and status RUNNING with zero terminal receipts.',
                        'Current terminal readiness, fee attribution and seat-exit closure remain outside this proof.',
                        'The base full suite had 53 total groups, including 16 HU groups.'])
