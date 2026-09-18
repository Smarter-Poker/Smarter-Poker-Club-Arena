"""Current original-funding closure for the existing isolated activation runner.

The two complete installed migrations retain their own exact preconditions.
The bounded frame supplement uses captured real definitions and catalog DDL;
it does not install the unrelated weekly payer or invent authority stubs.
"""
import hashlib
import json
from pathlib import Path

FIXTURE = "scripts/ci/fixtures/mtt-format-activation"
HUMAN = "supabase/migrations/20260917233447_tournament_original_funding_and_obligation_receipts.sql"
HORSE = "supabase/migrations/20260918002654_horse_tournament_entry_retains_original_funding.sql"
SUCCESSOR = "supabase/migrations/20260918005809_mtt_activation_preserves_original_funding.sql"
ACTIVATION = "supabase/migrations/20260918005913_mtt_activate_unlimited_with_original_funding.sql"
HORSE_MISSING = {
    "fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)",
    "fn_register_horse_for_tournament_before_atomic_lifecycle_gate(uuid,uuid)",
    "fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean)",
    "fn_ca_find_tournament_entry_ticket_for(uuid,uuid)",
}


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def horse_predecessors_sql(root):
    """Restore only missing real registration owners; preserve prepared helpers.

    These are byte-identical accounting captures from a7d70ff6, whose native
    horse qualification called the actual two-argument public registration RPC.
    The capture also contains seat-first wrappers, which are outside this call
    chain and deliberately not installed here. No prepared function is replaced.
    """
    base = root / FIXTURE
    owners = json.loads((base / 'funding-captured-horse-preimages.json').read_text())
    dependencies = json.loads((base / 'funding-captured-horse-dependencies.json').read_text())
    if len(owners) != 8 or len(dependencies) != 4:
        raise ValueError('qualified horse capture scope changed')
    rows = [r for r in owners if r['signature'].startswith('fn_register_horse_for_tournament')]
    rows += dependencies
    present = {
        'fn_register_horse_for_tournament(uuid,uuid)',
        'fn_register_horse_for_tournament(uuid,uuid,boolean)',
        'fn_poker_diamond_tournament(uuid)',
        'fn_tournament_entry_cap_reached(uuid)',
        'fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)',
    }
    if len(rows) != 9 or {r['signature'] for r in rows} != HORSE_MISSING | present:
        raise ValueError('qualified horse registration closure changed')
    result = ['BEGIN; SET LOCAL search_path=public,pg_catalog;']
    for row in rows:
        sig = 'public.' + row['signature']
        definition = row['definition']
        body = definition.split('AS $function$\n', 1)[1].rsplit('$function$', 1)[0]
        # prosrc starts with the newline after the dollar quote.
        if hashlib.md5(('\n' + body).encode()).hexdigest() != row['body_md5']:
            raise ValueError('qualified horse body changed: ' + sig)
        grants = row['acl'].removeprefix('{').removesuffix('}').split(',')
        if row['owner'] != 'postgres' or any(g not in {
            'postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres'
        } for g in grants):
            raise ValueError('unsupported qualified horse permissions: ' + sig)
        expected_acl = literal(json.dumps(sorted(grants))) + '::jsonb'
        expected_md5 = literal(hashlib.md5(definition.encode()).hexdigest())
        result.append('DO $horse_presence$ BEGIN IF (to_regprocedure(' + literal(sig) +
            ') IS NULL) IS DISTINCT FROM ' + ('true' if row['signature'] in HORSE_MISSING else 'false') +
            ' THEN RAISE EXCEPTION \'horse prerequisite presence drift: %\',' + literal(sig) +
            '; END IF; END $horse_presence$;')
        if row['signature'] in HORSE_MISSING:
            result.append(definition + ';')
            result.append('ALTER FUNCTION ' + sig + ' OWNER TO postgres;')
            result.append('REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;')
            for grant in grants:
                result.append('GRANT EXECUTE ON FUNCTION ' + sig + ' TO ' + identifier(grant.split('=', 1)[0]) + ';')
        result.append('DO $horse_identity$ DECLARE p record; BEGIN '
            'SELECT * INTO STRICT p FROM pg_proc WHERE oid=' + literal(sig) + '::regprocedure; '
            'IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM ' + expected_md5 +
            ' OR pg_get_userbyid(p.proowner) IS DISTINCT FROM \'postgres\''
            ' OR (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(p.proacl,acldefault(\'f\',p.proowner)))a)'
            ' IS DISTINCT FROM ' + expected_acl + ' THEN RAISE EXCEPTION \'horse prerequisite identity drift: %\',' +
            literal(sig) + '; END IF; END $horse_identity$;')
    result.append('COMMIT;')
    return '\n'.join(result)


def frame_sql(root):
    """Emit only the current reached inventory/frame/ledger dependency graph."""
    base = root / FIXTURE
    capture = json.loads((base / "funding-frame-dependencies-20260918.json").read_text())
    catalog = json.loads((base / "funding-frame-relations-20260918.json").read_text())
    if {r['name'] for r in catalog['relations']} != {
        'union_pnl_transaction_frames', 'union_pnl_inventory_events', 'union_pnl_original_flows'
    } or catalog['policies']:
        raise ValueError("exact private funding-frame relation scope changed")
    result = ["BEGIN; SET LOCAL search_path=public,pg_catalog;"]
    # The only FK is original_flows -> transaction_frames, so create that owner first.
    for name in ('union_pnl_transaction_frames', 'union_pnl_inventory_events', 'union_pnl_original_flows'):
        cols = []
        for row in catalog['columns']:
            if row[0] != name:
                continue
            _, column, typename, notnull, acl, default, identity = row
            if acl is not None or identity not in ('', 'a'):
                raise ValueError("unsupported captured column rights/identity")
            field = identifier(column) + ' ' + typename
            if identity:
                field += ' GENERATED ALWAYS AS IDENTITY'
            elif default is not None:
                field += ' DEFAULT ' + default
            if notnull:
                field += ' NOT NULL'
            cols.append(field)
        cols += ['CONSTRAINT ' + identifier(x[1]) + ' ' + x[2]
                 for x in catalog['constraints'] if x[0] == name]
        result.append('CREATE TABLE public.' + identifier(name) + '(' + ','.join(cols) + ');')
        result.append('ALTER TABLE public.' + identifier(name) + ' ENABLE ROW LEVEL SECURITY;')
        result.append('REVOKE ALL ON public.' + identifier(name) + ' FROM PUBLIC,anon,authenticated,service_role;')
    constraint_indexes = {x[1] for x in catalog['constraints'] if x[2].startswith(('PRIMARY KEY', 'UNIQUE'))}
    result += [x[1] + ';' for x in catalog['indexes'] if x[0] not in constraint_indexes]
    result.append('REVOKE ALL ON SEQUENCE public.union_pnl_inventory_events_event_id_seq FROM PUBLIC,anon,authenticated,service_role;')
    tranche = json.loads((base / 'funding-tranche-column-20260918.json').read_text())
    if tranche != ['tournament_refund_tranches', 'transaction_id', 'xid8', False, None, 'pg_current_xact_id()', '']:
        raise ValueError('captured refund-frame column contract changed')
    result.append('ALTER TABLE public.tournament_refund_tranches ADD COLUMN transaction_id xid8;')
    result.append('ALTER TABLE public.tournament_refund_tranches ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();')
    for row in capture['functions']:
        definition = row['definition']
        if hashlib.md5(definition.encode()).hexdigest() != row['definition_md5']:
            raise ValueError('captured funding-frame definition changed: ' + row['signature'])
        sig = 'public.' + row['signature']
        # fn_union_week_start already exists in the full financial catalog.
        # An existing definition must match; never replace another authority.
        result.append('DO $present$ DECLARE p record; BEGIN SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(' + literal(sig) + '); '
            'IF FOUND THEN IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM ' + literal(row['definition_md5']) +
            ' OR pg_get_userbyid(p.proowner) IS DISTINCT FROM ' + literal(row['owner']) +
            ' OR (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(p.proacl,acldefault(\'f\',p.proowner)))a) IS DISTINCT FROM ' +
            literal(json.dumps(row['acl'])) + '::jsonb THEN RAISE EXCEPTION \'current frame dependency drift: %\',' + literal(sig) + '; END IF; '
            'ELSE EXECUTE ' + literal(definition) + '; END IF; END $present$;')
        result.append('ALTER FUNCTION ' + sig + ' OWNER TO ' + identifier(row['owner']) + ';')
        result.append('REVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;')
        for acl in row['acl']:
            grantee, rights = acl.split('=', 1)
            if rights != 'X/postgres':
                raise ValueError('unsupported captured function grant')
            result.append('GRANT EXECUTE ON FUNCTION ' + sig + ' TO ' + (identifier(grantee) if grantee else 'PUBLIC') + ';')
    declarations = json.loads((base / 'funding-trigger-declarations-20260918.json').read_text())
    for row in declarations:
        result.append('INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note,declared_at) VALUES (' +
                      ','.join(literal(row[k]) for k in ('table_name','trigger_name','note','declared_at')) + ');')
    allowed = {'chip_ledger','tables','table_seats','tournaments','tournament_players','union_clubs','tournament_refund_tranches',
               'tournament_participant_funding_receipts','tournament_accounting_credit_receipts','tournament_obligation_events'}
    allowed.update(r['name'] for r in catalog['relations'])
    for table, name, ddl, enabled in capture['triggers']:
        if table not in allowed:
            continue
        if enabled != 'O':
            raise ValueError('captured funding trigger is not enabled in origin mode')
        result.append(ddl + ';')
    result.append('COMMIT;')
    return '\n'.join(result)


def install_funding(e, database):
    e.sql(database, file=e.root / HUMAN, label='actual-original-human-funding')
    before_data = e.snapshot(database, 'horse-prerequisites-before-data')
    before_catalog = e.catalog_snapshot(database, 'horse-prerequisites-before-catalog')
    path = e.output / 'actual-horse-prerequisites.sql'
    path.write_text(horse_predecessors_sql(e.root))
    e.sql(database, file=path, label='actual-original-horse-prerequisites')
    after_catalog = e.catalog_snapshot(database, 'horse-prerequisites-after-catalog')
    added = [r for r in after_catalog['functions'] if r not in before_catalog['functions']]
    if {r[1].removeprefix('public.') for r in added} != HORSE_MISSING or len(added) != 4:
        raise RuntimeError('horse prerequisites did not add exactly the four captured owners')
    after_catalog['functions'] = [r for r in after_catalog['functions'] if r not in added]
    if before_catalog != after_catalog or before_data != e.snapshot(database, 'horse-prerequisites-after-data'):
        raise RuntimeError('horse prerequisites changed existing authority, schema or money')
    e.sql(database, file=e.root / HORSE, label='actual-original-horse-funding')
    path = e.output / 'actual-funding-frame-supplement.sql'
    path.write_text(frame_sql(e.root))
    e.sql(database, file=path, label='actual-original-funding-frame-closure')


def guard_refusals(e, template, refusal):
    transaction = (e.root / ACTIVATION).read_text()
    for name, mutation, error in (
        ('funding-capture-security', 'ALTER FUNCTION public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb) SECURITY INVOKER;',
         'MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)'),
        ('horse-funding-identity', "ALTER FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid) SET statement_timeout='1s';",
         'MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)'),
        ('funding-private-read', 'GRANT INSERT ON public.tournament_participant_funding_receipts TO authenticated;',
         'MTT_ACTIVATION_FUNDING_RELATION_DRIFT: tournament_participant_funding_receipts'),
        ('funding-evidence-immutable', 'ALTER TABLE public.tournament_participant_funding_receipts DISABLE TRIGGER original_evidence_immutable;',
         'MTT_ACTIVATION_TRIGGER_DRIFT: tournament_participant_funding_receipts.original_evidence_immutable'),
        ('funding-frame-detached', 'DROP TRIGGER original_union_pnl_frame ON public.tournament_participant_funding_receipts;',
         'MTT_ACTIVATION_TRIGGER_DRIFT: tournament_participant_funding_receipts.original_union_pnl_frame'),
        ('funding-identity-default', 'ALTER TABLE public.tournament_participant_funding_receipts ALTER COLUMN transaction_id DROP DEFAULT;',
         'MTT_ACTIVATION_FUNDING_COLUMN_DRIFT: tournament_participant_funding_receipts.transaction_id'),
    ):
        refusal(e, template, name, mutation, transaction, error)


def funding_native(e, template, catalog, activate):
    """Real human/horse admission at the ABI boundary, including capture failure."""
    database = e.database(template)
    group = next(g for g in catalog['preparation_races'] if g['mode'] == 'legacy')
    # Chips horses use the real legacy house-board allowlist. A chips club
    # cannot be marked is_platform: that flag identifies Diamond custody.
    fixture_club = '46462000-0000-4000-8000-000000000002'
    house_club = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
    base_input = (e.root / group['fixture']['path']).read_text()
    e.sql(database, base_input.replace(fixture_club, house_club), label='funding-native-base-input')
    setup = (e.root / FIXTURE / 'transition.sql').read_text()
    if setup.count('-- @ACTUAL_ROW_ACTIVATION@') != 1 or setup.count('@INITIAL_COUNT@') != 1:
        raise ValueError('actual admission fixture seams changed')
    e.sql(database, setup.replace('-- @ACTUAL_ROW_ACTIVATION@', '').replace('@INITIAL_COUNT@', '2').replace(fixture_club, house_club),
          label='funding-native-historical-input')
    # The real service-role debit journal records its captured fallback actor.
    # Supply that referenced identity only in this isolated synthetic opening;
    # do not change the authority, forge a human JWT, or disable its FK.
    e.sql(database, """BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d');
      INSERT INTO public.users(id,username)
       VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','activation_service_journal_actor');
      COMMIT;""", label='funding-native-captured-service-actor-input')
    e.sql(database, "UPDATE public.profiles SET is_horse=true WHERE id='46468100-0000-4000-8000-000000000003';",
          label='funding-native-horse-input')
    human = "SELECT r46_activation.enter_event('human');"
    horse = """BEGIN; SET LOCAL ROLE service_role;
      SET LOCAL request.jwt.claims='{"role":"service_role"}';
      SELECT public.fn_register_horse_for_tournament('46462000-0000-4000-8000-000000000003',
       '46468100-0000-4000-8000-000000000003'); COMMIT;"""
    _, current, _ = e.sql(database, "SELECT pg_get_functiondef('public.fn_ca_capture_tournament_charge_entitlement()'::regprocedure);",
                          label='funding-charge-current-definition')
    predecessor = json.loads((e.root / FIXTURE / 'funding-charge-predecessor.json').read_text())
    if hashlib.md5(predecessor['definition'].encode()).hexdigest() != predecessor['md5']:
        raise ValueError('exact old capture definition changed')

    def rejected_capture(label, call):
        data = e.snapshot(database, label + '-before-data')
        expected_catalog = e.catalog_snapshot(database, label + '-before-catalog')
        e.sql(database, predecessor['definition'] + ';', label=label + '-restore-real-predecessor')
        code, _, error = e.sql(database, call, label=label, check=False)
        if code != 3 or error.count('Original tournament funding references do not match') != 1:
            raise RuntimeError('missing original capture did not refuse the actual admission: ' + label)
        e.sql(database, current + ';', label=label + '-restore-current-capture')
        if data != e.snapshot(database, label + '-after-data') or expected_catalog != e.catalog_snapshot(database, label + '-after-catalog'):
            raise RuntimeError('failed original-funding capture leaked money/roster/receipt state')

    rejected_capture('human-original-capture-atomic-refusal', human)
    e.sql(database, human, label='real-human-entry-before-activation')
    _, answer, _ = e.sql(database, horse, label='real-horse-full-before-activation')
    if json.loads(answer)['reason'] != 'tournament_full':
        raise RuntimeError('legacy horse entry must retain the real capacity refusal')
    activate(e, database, 'original-funding-actual-activation')
    rejected_capture('horse-original-capture-atomic-refusal', horse)
    _, answer, _ = e.sql(database, horse, label='real-horse-entry-after-activation')
    if json.loads(answer).get('ok') is not True:
        raise RuntimeError('unlimited horse entry did not retain its original successful receipt')
    _, answer, _ = e.sql(database, """SELECT jsonb_build_object(
      'funding',count(*),'exact',count(*) FILTER(WHERE f.amount=200 AND f.operation='entry'
       AND f.asset='chips' AND f.funding_club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
       AND e.source_ledger_id=f.ledger_id AND f.entitlement_snapshot->>'id'=e.id::text
       AND l.amount=200 AND w.amount=200 AND p.user_id=f.user_id
       AND f.registration_snapshot->>'id'=p.id::text
       AND f.ledger_snapshot->>'id'=l.id::text AND f.wallet_snapshot->>'id'=w.id::text
       AND frame.transaction_id=f.transaction_id),
      'wallets',(SELECT jsonb_agg(chip_balance ORDER BY user_id) FROM public.club_members
       WHERE club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
       AND user_id IN('46468100-0000-4000-8000-000000000003','46468100-0000-4000-8000-000000000004')),
      'entrants',(SELECT current_players FROM public.tournaments WHERE id='46462000-0000-4000-8000-000000000003'))
      FROM public.tournament_participant_funding_receipts f
      JOIN public.tournament_refund_entitlements e ON e.id=f.entitlement_id
      JOIN public.chip_ledger l ON l.id=f.ledger_id
      JOIN public.wallet_transactions w ON w.id=f.wallet_transaction_id
      JOIN public.tournament_players p ON p.id=f.registration_id
      JOIN public.union_pnl_transaction_frames frame ON frame.transaction_id=f.transaction_id;""",
      label='original-human-horse-funding-and-frame-identity')
    if json.loads(answer) != {'funding': 2, 'exact': 2, 'wallets': [800, 800], 'entrants': 4}:
        raise RuntimeError('original funding/frame identity or exact admission charge mismatch: ' + answer)
    data = e.snapshot(database, 'original-funding-replay-before-data')
    expected_catalog = e.catalog_snapshot(database, 'original-funding-replay-before-catalog')
    _, prior_receipt, _ = e.sql(database, "SELECT receipt FROM r46_activation.observations WHERE actor='human';",
                              label='original-human-receipt-before-replay')
    # Actual human request receipt replay and actual horse already-registered path.
    e.sql(database, "DELETE FROM r46_activation.observations WHERE actor='human';" + human,
          label='original-human-request-replay-after-activation')
    _, replay_receipt, _ = e.sql(database, "SELECT receipt FROM r46_activation.observations WHERE actor='human';",
                               label='original-human-receipt-after-replay')
    if json.loads(prior_receipt) != json.loads(replay_receipt):
        raise RuntimeError('same human request changed its committed receipt')
    _, answer, _ = e.sql(database, horse, label='original-horse-entry-replay-after-activation')
    if json.loads(answer).get('reason') != 'already_registered':
        raise RuntimeError('horse duplicate did not preserve its existing entry')
    if data != e.snapshot(database, 'original-funding-replay-after-data') or expected_catalog != e.catalog_snapshot(database, 'original-funding-replay-after-catalog'):
        raise RuntimeError('original admission replay changed money or evidence')
    e.discard(database)
    e.report['native'].append({'case': 'original_human_horse_funding_across_activation',
        'two_actual_200_charges': True, 'exact_registration_wallet_entitlement_frame': True,
        'two_missing_capture_whole_transaction_rollbacks': True, 'unchanged_replay': True,
        'database_removed': True})
