"""Install the captured production money-DDL guard and reproduce its refusal.

The legacy migration must fail at the unregistered public settlement authority.
No predicate, trigger, monetary function body or financial guard is substituted.
"""
import hashlib
import json


def install_and_reproduce_registry_guard(e, db, root, migration):
    path = root / 'scripts/ci/fixtures/tournament-abort/current-money-registry-guard.json'
    captured = json.loads(path.read_text())
    assert captured['registry_security'] == {
        'acl': '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}',
        'rls': True, 'owner': 'postgres',
    }
    columns = []
    for c in captured['registry_columns']:
        columns.append('"'+c['name']+'" '+c['type']
                       + (' DEFAULT '+c['default'] if c['default'] else '')
                       + (' NOT NULL' if c['notnull'] else ''))
    constraints = [c['definition'] for c in captured['registry_constraints']]
    sql = ('CREATE TABLE IF NOT EXISTS public.ca_money_rpc_registry('+','.join(columns+constraints)+');'
           'ALTER TABLE public.ca_money_rpc_registry ENABLE ROW LEVEL SECURITY;'
           'REVOKE ALL ON public.ca_money_rpc_registry FROM PUBLIC,anon,authenticated;'
           'GRANT ALL ON public.ca_money_rpc_registry TO service_role;')
    for f in captured['functions']:
        assert hashlib.md5(f['definition'].encode()).hexdigest() == f['definition_md5']
        sql += f['definition']+';'
        sql += 'REVOKE ALL ON FUNCTION public.'+f['signature']+' FROM PUBLIC,anon,authenticated;'
    for row in captured['registry_rows']:
        # Only the actual captured baseline row, never catalog-wide approval.
        assert row['proname'] == 'atomic_cancel_tournament' and row['status'] == 'approved'
        sql += "INSERT INTO public.ca_money_rpc_registry(proname,status,notes,added_at) VALUES("+','.join(
            "'"+row[k].replace("'", "''")+"'" for k in ('proname','status','notes','added_at'))+') ON CONFLICT(proname) DO NOTHING;'
    for t in captured['event_triggers']:
        assert t == {'name':'ab_ca_money_rpc_registered','tags':['CREATE FUNCTION'],
                     'event':'ddl_command_end','enabled':'O',
                     'function':'fn_ca_money_rpc_registry_guard()'}
        sql += ('CREATE EVENT TRIGGER '+t['name']+' ON ddl_command_end WHEN TAG IN '
                "('CREATE FUNCTION') EXECUTE FUNCTION public."+t['function']+';')
    setup = e.output / 'actual-money-registry-guard.sql'
    setup.write_text(sql)
    e.sql(db, file=setup, label='actual-production-money-registry-guard')
    # Remove only the correction. Everything else is the exact candidate, so the
    # failure includes the same full DDL/preimage sequence as the failed install.
    current = migration.read_text()
    start = current.index('-- Register the explicit monetary authority before CREATE FUNCTION,')
    stop = current.index('CREATE FUNCTION public.fn_ca_settle_tournament_abort(', start)
    legacy = e.output / 'unregistered-abort-regression.sql'
    legacy.write_text('\\set VERBOSITY verbose\n'+current[:start]+current[stop:])
    before = registry_snapshot(e, db, 'registry-before-unregistered-install')
    code, _, error = e.sql(db, file=legacy, label='unregistered-abort-install-refused', check=False)
    assert code != 0 and '42501' in error
    assert ('REFUSED: fn_ca_settle_tournament_abort writes balance columns and is not '
            'in ca_money_rpc_registry') in error
    assert registry_snapshot(e, db, 'registry-after-refused-install') == before
    assert before['abort_tables'] == [] and before['abort_authority'] is None
    assert before['new_registration'] is None
    e.sql(db, "INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES"
          "('fn_ca_settle_tournament_abort','retired','Native prior authority decision');",
          label='existing-retired-authority-scene')
    retired_before = registry_snapshot(e, db, 'registry-before-retired-install')
    rejected = e.output / 'retired-abort-authority-regression.sql'
    rejected.write_text('\\set VERBOSITY verbose\n'+current)
    code, _, error = e.sql(db, file=rejected, label='retired-abort-authority-refused', check=False)
    assert code != 0 and '42501' in error
    assert 'started_abort_money_authority_registration_not_approved' in error
    assert registry_snapshot(e, db, 'registry-after-retired-refusal') == retired_before
    e.sql(db, "DELETE FROM public.ca_money_rpc_registry WHERE proname='fn_ca_settle_tournament_abort'"
          " AND status='retired' AND notes='Native prior authority decision';",
          label='remove-local-retired-authority-scene')
    assert registry_snapshot(e, db, 'registry-ready-for-approved-install') == before
    e.report['registry_guard_cases'] = ['unregistered-exact-abort-install-refused',
                                        'failed-install-catalog-fully-rolled-back',
                                        'existing-retired-authority-refused',
                                        'prior-retired-decision-and-catalog-preserved']
    e.report['source_sha256'][str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()


def registry_snapshot(e, db, label):
    _, out, _ = e.sql(db, """SELECT jsonb_build_object(
 'abort_tables',coalesce((SELECT jsonb_agg(c.relname ORDER BY c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='smarter_private' AND c.relname IN
   ('tournament_abort_operations','tournament_abort_targets','tournament_abort_boundaries',
    'diamond_tournament_abort_receipts')),'[]'::jsonb),
 'abort_authority',to_regprocedure('public.fn_ca_settle_tournament_abort(uuid,uuid,text)'),
 'new_registration',(SELECT to_jsonb(g) FROM public.ca_money_rpc_registry g
   WHERE proname='fn_ca_settle_tournament_abort'),
 'preimages',(SELECT jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND p.proname IN ('fn_f06_begin_hand','fn_ca_tournament_entry_gate',
    'fn_ca_capture_tournament_charge_entitlement','fn_poker_diamond_tournament_charge',
    'fn_ca_operator_floor_state','fn_ca_tournament_cancellation_receipt','fn_ca_escrow_on_rake_record')),
 'guard',(SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))) FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
   ('fn_ca_money_rpc_balance_columns','fn_ca_money_rpc_writes_balances','fn_ca_money_rpc_registry_guard')),
 'trigger',(SELECT jsonb_build_array(evtname,evtevent,evtenabled,evttags)
   FROM pg_event_trigger WHERE evtname='ab_ca_money_rpc_registered'));
""", label=label)
    return json.loads(out.strip())


def assert_registered_install(e, db, root):
    _, out, _ = e.sql(db, """SELECT jsonb_build_object(
 'autoledger_bound',EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')),
 'registered',EXISTS(SELECT 1 FROM public.ca_money_rpc_registry
   WHERE proname='fn_ca_settle_tournament_abort' AND status='approved'),
 'actual_predicate',public.fn_ca_money_rpc_writes_balances((SELECT prosrc FROM pg_proc
   WHERE oid='public.fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure)),
 'enabled_guard',EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='ab_ca_money_rpc_registered'
   AND evtevent='ddl_command_end' AND evtenabled='O' AND evttags=ARRAY['CREATE FUNCTION']));
""", label='registered-abort-install-guard-readback')
    proof = json.loads(out.strip())
    assert proof == {'registered':True,'actual_predicate':True,'enabled_guard':True,'autoledger_bound':True}
    e.report['registry_guard_cases'].append('registered-exact-install-under-enabled-production-guard')
    e.report['registry_guard'] = proof

    captured = json.loads((root / 'scripts/ci/fixtures/tournament-abort/current-money-registry-guard.json').read_text())
    expected = {f['signature'].split('(')[0]:f['definition_md5'] for f in captured['functions']}
    snapshot = registry_snapshot(e, db, 'installed-production-registry-guard-body-proof')
    assert snapshot['guard'] == expected
    e.report['registry_guard_postimages'] = snapshot['guard']
