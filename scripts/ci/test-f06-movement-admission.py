"""Original parked movement admission against the real financial PostgreSQL 17 fixture."""
from pathlib import Path
from collections import Counter
import argparse
import datetime
import hashlib
import json
import re
import signal
import sys

sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module, sha, function_sql

MIGRATION = 'supabase/migrations/20260918095135_parked_tournament_movement_requires_canonical_custody.sql'
DECIDED = 'supabase/migrations/20260922152219_a_decided_hand_does_not_hold_a_parked_table.sql'
PROBE = 'scripts/ci/probes/f06-movement-admission.sql'
SPEC = 'scripts/ci/probes/f06-movement-admission.spec'
OPENING = 'scripts/ci/probes/f06-movement-opening.sql'
RECEIPT = 'scripts/ci/fixtures/f06-movement-admission/current-movement-receipt.json'
AUTHORITIES = 'scripts/ci/fixtures/f06-movement-admission/current-movement-authorities.json'
PUBLIC_F06 = 'scripts/ci/fixtures/f06-movement-admission/current-public-f06.json'
DEPENDENCY_CATALOG = 'scripts/ci/fixtures/f06-movement-admission/g8-generation-dependency-catalog-1234.json'
DEPENDENCY_FUNCTIONS = 'scripts/ci/fixtures/f06-movement-admission/g8-generation-dependency-functions-1234.json'
FINAL_RELATIONS = 'scripts/ci/fixtures/f06-movement-admission/current-final-relations.json'
PRIVATE = 'scripts/ci/fixtures/f06-movement-admission/current-private-authorities.json'
CONTROL = 'scripts/ci/fixtures/f06-movement-admission/current-control-relations.json'
CONTINUATION = 'scripts/ci/fixtures/f06-movement-admission/current-continuation-relations.json'
RESULT_TEST = 'tests/operations/f06-movement-results.test.py'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def movement_catalog(root):
    """Compose the actual movement relation/authorities, including its receipt guard."""
    for path, digest in [(RECEIPT, 'd2ba84344d19c04a2b1a778f5c3907d8bf9e3787af3833d343c8101ff6ab61a3'),
                         (AUTHORITIES, '0f817cf583fc23bee5f5da995c9e4747cf416c203803c8ca5952dba655b50528'),
                         (PUBLIC_F06, '73b2726b755dba6b72a0097f4d1ffb9ebdae375fba39007f7ea0a472b1fff095'),
                         (DEPENDENCY_CATALOG, 'bf55bb4695e4d65a1f254a0c021ca94c0183f53bc5d0d8fa6adee93db61ce1bb'),
                         (DEPENDENCY_FUNCTIONS, '7ca0ca8c28bb864abba687982ea0faee2a39631da4ea60f292f2aebde8d54d31'),
                         (FINAL_RELATIONS, '483da5d479bdcccc6c4af83a616c52d7adbb119039bad2900750408ee7c3d4b4'),
                         (PRIVATE, 'f76fd4e6420408407674dbe35e7c7efe73f33aa2d9d7dc4690a55f03d01d50c4'),
                         (CONTROL, '78a4d0353756b321587503ac25412aaa7079763c775e37bcee6900e40de99932'),
                         (CONTINUATION, '835365a534aa4d89f9b8f7d034eda16e530b05bacceea1b7434d69da9a1454cc')]:
        if sha(root / path) != digest:
            raise ValueError('movement catalog capture differs: ' + path)
    capture = json.loads((root / RECEIPT).read_text())['rows'][0]['result']
    relation = capture['relation']
    if relation != {'acl': '{postgres=arwdDxtm/postgres}', 'rls': True,
                    'name': 'tournament_seat_move_receipts', 'owner': 'postgres', 'forcerls': False} or capture['policies']:
        raise ValueError('unexpected receipt relation authority')
    columns = [c['name'] + ' ' + c['type'] + (' NOT NULL' if c['notnull'] else '') +
               (' DEFAULT ' + c['default'] if c['default'] else '') for c in capture['columns']]
    commands = ['BEGIN;', 'CREATE TABLE public.tournament_seat_move_receipts (' + ','.join(columns) + ');',
                'ALTER TABLE public.tournament_seat_move_receipts ENABLE ROW LEVEL SECURITY;',
                'REVOKE ALL ON public.tournament_seat_move_receipts FROM PUBLIC,anon,authenticated,service_role;',
                'GRANT ALL ON public.tournament_seat_move_receipts TO postgres;']
    final_relations = json.loads((root / FINAL_RELATIONS).read_text())['rows']
    immutable = next(t for r in final_relations for t in (r['triggers'] or []) if t['signature']=='smarter_private.f06_abort_receipt_immutable()')
    tables = final_relations + [t for t in json.loads((root / DEPENDENCY_CATALOG).read_text()) if t['relation'].startswith('smarter_private.f06_')]
    tables += json.loads((root / CONTINUATION).read_text())['rows']
    # Current additive abort/continuation schema, captured from the installed
    # owner. This isolated fixture patch does not invent an authority.
    commands.append('ALTER TABLE smarter_private.f06_operations ADD COLUMN abort_receipt_id uuid;')
    for table in json.loads((root / CONTROL).read_text())['rows']:
        for c in table['constraints']:
            commands.append("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid="+literal(table['relation'])+"::regclass AND conname="+literal(c['name'])+" AND pg_get_constraintdef(oid)="+literal(c['definition'])+") THEN ALTER TABLE "+table['relation']+" DROP CONSTRAINT IF EXISTS "+c['name']+"; ALTER TABLE "+table['relation']+" ADD CONSTRAINT "+c['name']+" "+c['definition']+"; END IF; END $$;")
    trigger_functions = {}
    trigger_definitions = []
    privileges = {'a':'INSERT','r':'SELECT','w':'UPDATE','d':'DELETE','D':'TRUNCATE','x':'REFERENCES','t':'TRIGGER','m':'MAINTAIN'}
    for table in tables:
        name = table['relation']
        if table['owner'] != 'postgres' or not table['rls'] or any(c.get('identity') or c.get('generated') for c in table['columns']):
            raise ValueError('unexpected generation relation authority')
        columns = [c['name'] + ' ' + c['type'] + (' NOT NULL' if c['notnull'] else '') +
                   (' DEFAULT ' + c['default'] if c['default'] else '') for c in table['columns']]
        commands += ['CREATE TABLE ' + name + '(' + ','.join(columns) + ');',
                     'ALTER TABLE ' + name + ' ENABLE ROW LEVEL SECURITY;',
                     'REVOKE ALL ON ' + name + ' FROM PUBLIC,anon,authenticated,service_role,postgres;']
        for acl in table['acl'].strip('{}').split(','):
            m = re.fullmatch(r'(postgres|anon|authenticated|service_role)=([arwdDxtm]+)/postgres',acl)
            if not m:
                raise ValueError('unexpected captured relation grant: ' + acl)
            commands.append('GRANT ' + ','.join(privileges[c] for c in m[2]) + ' ON ' + name + ' TO ' + m[1] + ';')
        if table['force_rls']:
            commands.append('ALTER TABLE ' + name + ' FORCE ROW LEVEL SECURITY;')
        for p in table['policies'] or []:
            commands.append('CREATE POLICY "' + p['policyname'] + '" ON ' + name + ' AS ' + p['permissive'] +
                            ' FOR ' + p['cmd'] + ' TO ' + ','.join(p['roles']) +
                            (' USING (' + p['qual'] + ')' if p['qual'] else '') +
                            (' WITH CHECK (' + p['with_check'] + ')' if p['with_check'] else '') + ';')
        for c in table['constraints']:
            if not c['validated']:
                raise ValueError('unvalidated generation constraint')
            commands.append('ALTER TABLE ' + name + ' ADD CONSTRAINT ' + c['name'] + ' ' + c['definition'] + ';')
        for index in table['indexes']:
            if not index['valid'] or not index['ready']:
                raise ValueError('generation index not ready')
            index_name = re.search(r'INDEX (\w+)', index['definition'])[1]
            if index_name not in {c['name'] for c in table['constraints']}:
                commands.append(index['definition'] + ';')
        for t in table['triggers'] or []:
            if 'signature' not in t:
                t = {**immutable, **t, 'definition_md5':t['function_md5']}
            if t['enabled'] != 'O' or hashlib.md5(t['function'].encode()).hexdigest() != t['definition_md5']:
                raise ValueError('generation trigger drift')
            trigger_functions[t['signature']] = {**t, 'identity':t['signature'], 'definition':t['function']}
            trigger_definitions.append(t['definition'] + ';')
    for constraint in capture['constraints']:
        commands.append('ALTER TABLE public.tournament_seat_move_receipts ADD CONSTRAINT ' + constraint['name'] + ' ' + constraint['definition'] + ';')
    functions = capture['functions'] + json.loads((root / AUTHORITIES).read_text())['rows']
    functions += [{**f, 'identity': f['signature']} for f in json.loads((root / PUBLIC_F06).read_text())['rows']]
    functions += [{**f, 'identity': f['signature']} for f in json.loads((root / DEPENDENCY_FUNCTIONS).read_text())]
    functions += list(trigger_functions.values())
    functions += [{**f, 'identity':f['signature']} for f in json.loads((root / PRIVATE).read_text())['rows']
                  if f['signature'] != 'smarter_private.f06_source_guard()']
    for f in functions:
        signature = f['identity'] if '.' in f['identity'].split('(')[0] else 'public.' + f['identity']
        if hashlib.md5(f['definition'].encode()).hexdigest() != f['definition_md5']:
            raise ValueError('movement function definition changed: ' + signature)
        if f['owner'] != 'postgres' or not re.fullmatch(r'\{postgres=X/postgres(?:,service_role=X/postgres)?\}', f['acl']):
            raise ValueError('unexpected movement function ACL: ' + signature)
        commands.extend([f['definition'].rstrip().rstrip(';') + ';',
            'ALTER FUNCTION ' + signature + ' OWNER TO postgres;',
            'REVOKE ALL ON FUNCTION ' + signature + ' FROM PUBLIC,anon,authenticated,service_role;',
            'GRANT EXECUTE ON FUNCTION ' + signature + ' TO postgres;'])
        if 'service_role=' in f['acl']:
            commands.append('GRANT EXECUTE ON FUNCTION ' + signature + ' TO service_role;')
        commands.append("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=" + literal(signature) + "::regprocedure AND md5(pg_get_functiondef(p.oid))=" + literal(f['definition_md5']) + " AND md5(p.prosrc)=" + literal(f['body_md5']) + " AND p.proacl::text=" + literal(f['acl']) + ") THEN RAISE EXCEPTION 'movement authority differs: %'," + literal(signature) + "; END IF; END $$;")
    for trigger in capture['triggers']:
        if trigger['enabled'] != 'O':
            raise ValueError('disabled movement guard')
        commands.append(trigger['definition'] + ';')
    commands += trigger_definitions
    commands.append('COMMIT;')
    return '\n'.join(commands)


def dependency_preflight(root):
    """The production installer enforces the same observed authority graph."""
    capture = json.loads((root / RECEIPT).read_text())['rows'][0]['result']
    functions = capture['functions'] + json.loads((root / AUTHORITIES).read_text())['rows']
    for path in (PUBLIC_F06, PRIVATE):
        functions += json.loads((root / path).read_text())['rows']
    functions += json.loads((root / DEPENDENCY_FUNCTIONS).read_text())
    result = ['-- BEGIN CAPTURED MOVEMENT DEPENDENCIES', 'DO $movement_dependencies$', 'DECLARE actual jsonb;', 'BEGIN']
    unique = {}
    for f in functions:
        signature = f.get('identity', f.get('signature'))
        if '.' not in signature.split('(')[0]:
            signature = 'public.' + signature
        if signature in unique and unique[signature] != f['definition_md5']:
            raise ValueError('conflicting movement preimage: ' + signature)
        if signature in unique:
            continue
        unique[signature] = f['definition_md5']
        result.append(" IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure("+literal(signature)+") AND md5(pg_get_functiondef(p.oid))="+literal(f['definition_md5'])+" AND md5(p.prosrc)="+literal(f['body_md5'])+" AND pg_get_userbyid(p.proowner)="+literal(f['owner'])+" AND p.proacl::text="+literal(f['acl'])+" AND to_jsonb(p.proconfig)="+literal(json.dumps(f['config']))+"::jsonb) THEN RAISE EXCEPTION 'F06_MOVEMENT_DEPENDENCY_DRIFT: %',"+literal(signature)+"; END IF;")
    receipt = {'relation':'public.tournament_seat_move_receipts', **capture['relation'], 'force_rls':capture['relation']['forcerls'],
               'columns':capture['columns'], 'constraints':[{**c,'validated':True} for c in capture['constraints']], 'triggers':capture['triggers']}
    for table in json.loads((root / CONTROL).read_text())['rows'] + [receipt]:
        name = literal(table['relation'])
        result.append(" IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass("+name+") AND pg_get_userbyid(c.relowner)="+literal(table['owner'])+" AND c.relacl::text="+literal(table['acl'])+" AND c.relrowsecurity="+str(table['rls']).lower()+" AND c.relforcerowsecurity="+str(table['force_rls']).lower()+") THEN RAISE EXCEPTION 'F06_MOVEMENT_RELATION_DRIFT: %',"+name+"; END IF;")
        for c in table['constraints']:
            result.append(" IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid="+name+"::regclass AND conname="+literal(c['name'])+" AND pg_get_constraintdef(oid)="+literal(c['definition'])+" AND convalidated) THEN RAISE EXCEPTION 'F06_MOVEMENT_CONSTRAINT_DRIFT: %',"+literal(c['name'])+"; END IF;")
        for t in table['triggers'] or []:
            result.append(" IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid="+name+"::regclass AND tgname="+literal(t['name'])+" AND pg_get_triggerdef(oid)="+literal(t['definition'])+" AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %',"+literal(t['name'])+"; END IF;")
        columns = [{k:c[k] for k in ('name','type','notnull','default')} for c in table['columns']]
        result.append(" SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid="+name+"::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM "+literal(json.dumps(columns))+"::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_COLUMNS_DRIFT: %',"+name+"; END IF;")
    for name, trigger, columns in [('table_seats','a00_f06_source_seat','table_id, user_id, seat_number, left_at'),
                                   ('tournament_players','a00_f06_source_roster','table_id, user_id, seat_number, status')]:
        definition = 'CREATE TRIGGER '+trigger+' BEFORE INSERT OR DELETE OR UPDATE OF '+columns+' ON public.'+name+' FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()'
        result.append('-- money-trigger-ok: '+name+'.'+trigger+' because this asserts its retained enabled binding; the original trigger is not modified.')
        result.append(" IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public."+name+"'::regclass AND tgname="+literal(trigger)+" AND tgenabled='O' AND NOT tgisinternal AND pg_get_triggerdef(oid)="+literal(definition)+") THEN RAISE EXCEPTION 'F06_MOVEMENT_BINDING_DRIFT: %',"+literal(trigger)+"; END IF;")
    result += ['END $movement_dependencies$;', '-- END CAPTURED MOVEMENT DEPENDENCIES']
    return '\n'.join(result)


def validate_race(code, out, err, mode):
    if mode not in ('commit', 'rollback'):
        raise ValueError('unknown movement release mode')
    step = 'b_claim_' + mode
    expected = Counter({'a_begin':1, 'a_claim':1, step:2, 'observed_wait':1, 'a_'+mode:1, 'final_state':1})
    notices = re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(MOVEMENT_[A-Z_]+)\s*$', out, re.M)
    if (code or err.strip() or re.search(r'^(?:[a-z_]+: )?(?:ERROR|FATAL|PANIC|WARNING):', out, re.M)
        or Counter(re.findall(r'^step ([a-z_]+):', out, re.M)) != expected
        or out.count('Parsed test spec with 3 sessions') != 1
        or re.findall(r'^starting permutation: (.*)$',out,re.M) != [f'a_begin a_claim {step} observed_wait a_{mode} final_state']
        or out.count('<waiting ...>') != 1 or out.count('<... completed>') != 1
        or not re.search(r'^step '+step+r': <\.\.\. completed>\nclaim\n-----\n *\n\(1 row\)',out,re.M)
        or notices != ['MOVEMENT_RACE_CLAIM_PROVEN','MOVEMENT_RACE_WAIT_PROVEN','MOVEMENT_RACE_CLAIM_PROVEN','MOVEMENT_RACE_EFFECTS_PROVEN']):
        raise RuntimeError('exact movement admission concurrency proof failed')
    return {'actual_wait':True, 'exact_final_effects':True}


def validate_probe(code, stdout, stderr):
    if code or any(x in stderr for x in ['ERROR:', 'FATAL:', 'PANIC:', 'WARNING:']):
        raise RuntimeError('movement public flow failed; inspect retained SQL output')
    if stdout.splitlines().count('F06_MOVEMENT_ADMISSION_PASS') != 1 or stderr.count('MOVEMENT PASS:') != 139:
        raise RuntimeError('exact movement completion and 139 assertions required')


def installer_refusals(e, db, root, fixture):
    cases = [
        ('body', "ALTER FUNCTION smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[]) RESET ALL;", 'F06_MOVEMENT_DEPENDENCY_DRIFT'),
        ('acl', "REVOKE EXECUTE ON FUNCTION public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text) FROM service_role;", 'F06_MOVEMENT_DEPENDENCY_DRIFT'),
        ('binding', 'ALTER TABLE public.tournament_seat_move_receipts DISABLE TRIGGER f06_bind_move_receipt;', 'F06_MOVEMENT_BINDING_DRIFT'),
        ('constraint', 'ALTER TABLE public.tournament_seat_move_receipts DROP CONSTRAINT tournament_seat_move_receipts_check;', 'F06_MOVEMENT_CONSTRAINT_DRIFT'),
        ('source-binding', 'ALTER TABLE public.table_seats DISABLE TRIGGER a00_f06_source_seat;', 'F06_MOVEMENT_BINDING_DRIFT'),
    ]
    for name, drift, expected in cases:
        case = e.database(db)
        e.sql(case, drift, label='installer-'+name+'-drift')
        before = e.catalog_snapshot(case, 'installer-'+name+'-before')
        private = fixture.private_snapshot(e, case, 'installer-'+name+'-private-before')
        code, _, err = e.sql(case, file=root / MIGRATION, label='installer-'+name+'-refusal', check=False)
        if code == 0 or expected not in err:
            raise RuntimeError('movement installer did not refuse actual '+name+' drift')
        if e.catalog_snapshot(case, 'installer-'+name+'-after') != before or fixture.private_snapshot(e, case, 'installer-'+name+'-private-after') != private:
            raise RuntimeError('movement rejected installer changed catalog or private records')
        e.discard(case)
        e.report['migration_refusals'].append({'case':name,'reason':expected,'atomic_rollback':True})


def decided_installer_refusal(e, db, root, fixture):
    """The decided-hand reader replaces exactly the definition it reasons about."""
    case = e.database(db)
    e.sql(case, "ALTER FUNCTION smarter_private.f06_movement_permits(uuid,uuid,bigint) SET work_mem='64kB';",
          label='decided-installer-owner-drift')
    before = e.catalog_snapshot(case, 'decided-installer-before')
    private = fixture.private_snapshot(e, case, 'decided-installer-private-before')
    code, _, err = e.sql(case, file=root / DECIDED, label='decided-installer-refusal', check=False)
    if code == 0 or 'F06_DECIDED_HAND_OWNER_DRIFT' not in err:
        raise RuntimeError('decided-hand installer did not refuse a drifted movement permit owner')
    if (e.catalog_snapshot(case, 'decided-installer-after') != before
            or fixture.private_snapshot(e, case, 'decided-installer-private-after') != private):
        raise RuntimeError('refused decided-hand installer changed catalog or private records')
    e.discard(case)
    e.report['migration_refusals'].append({'case': 'decided-owner', 'reason': 'F06_DECIDED_HAND_OWNER_DRIFT',
                                           'atomic_rollback': True})


def qualify_races(e, root, native, db):
    spec = (root / SPEC).read_text()
    permutations = re.findall(r'^permutation .+$', spec, re.M)
    if len(permutations) != 2:
        raise ValueError('two exact movement permutations required')
    body = re.sub(r'^permutation .+$', '', spec, flags=re.M)
    binary = native.stock_isolationtester(e.pg)
    e.report['isolationtester'] = {'path':str(binary), 'sha256':sha(binary)}
    for permutation in permutations:
        mode = 'rollback' if 'a_rollback' in permutation else 'commit'
        case = e.database(db)
        unused = 'rollback' if mode == 'commit' else 'commit'
        rendered = re.sub(r'^step "(?:a_'+unused+'|b_claim_'+unused+r')" .*\n', '', body, flags=re.M)
        label = 'movement-admission-' + mode
        code, out, err = e.run(label, [binary, f'host={e.socket} port={e.port} dbname={case} user=postgres'],
                              text=rendered+'\n'+permutation+'\n', seconds=40, check=False)
        proof = validate_race(code, out, err, mode)
        e.discard(case)
        e.report['races'].append({'case':label, **proof, 'database_removed':True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    args = parser.parse_args()
    root, out = args.root.resolve(), args.evidence.resolve()
    out.mkdir(exist_ok=False, parents=True)
    if sha(Path(__file__)) != sha(root / 'scripts/ci/test-f06-movement-admission.py'):
        raise ValueError('executed movement owner differs from source binding')
    fixture = module(root / 'scripts/ci/test-f06-accepted-elimination.py', 'movement_fixture')
    manifest = fixture.prepare(root, out)
    manifest['source_sha256'].update({p: sha(root / p) for p in [MIGRATION, DECIDED, PROBE, SPEC, OPENING, RECEIPT, AUTHORITIES, PUBLIC_F06, DEPENDENCY_FUNCTIONS, DEPENDENCY_CATALOG, FINAL_RELATIONS, PRIVATE, CONTROL, CONTINUATION, RESULT_TEST, 'scripts/ci/test-f06-movement-admission.py']})
    if dependency_preflight(root) not in (root / MIGRATION).read_text():
        raise ValueError('movement installer dependencies differ from actual captured graph')
    (out / 'movement-catalog.sql').write_text(movement_catalog(root))
    (out / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    native = module(root / 'scripts/ci/test-mtt-unlimited.py', 'movement_execution')
    e = native.Execution(root, out, args.pg_bin.resolve(), out, 600)
    e.report.update(source_sha256=manifest['source_sha256'], fixture_identity='real-canonical-hand-and-eliminated-source')
    for sig in native.CANCELLATION_SIGNALS:
        signal.signal(sig, native.interrupted)
    try:
        e.start()
        db = e.database()
        e.sql(db, file=out / 'foundation.sql', label='real-current-financial-foundation', seconds=180)
        e.sql(db, file=out / 'current-authorities.sql', label='current-elimination-authorities')
        e.sql(db, file=out / 'movement-catalog.sql', label='actual-movement-catalog')
        guard = root / 'scripts/ci/fixtures/satellite-qualifiers/current-money-ddl-guard-20260917.json'
        if sha(guard) != '8884f9471acd933072afc05ef3f2427cc63a28de9744785d1bc10611f730ef5b':
            raise ValueError('current money DDL capture differs')
        captured = json.loads(guard.read_text())
        for row in captured['functions']:
            e.sql(db, function_sql(row), label='real-money-ddl-guard')
        e.sql(db, "CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();", label='real-money-ddl-event')
        e.sql(db, file=root / 'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql', label='structural-opening')
        e.sql(db, file=out / 'opening.sql', label='canonical-hand-opening')
        e.sql(db, file=root / OPENING, label='movement-three-player-opening')
        e.sql(db, file=root / fixture.MIGRATION, label='current-accepted-elimination')
        installer_refusals(e, db, root, fixture)
        e.sql(db, file=root / MIGRATION, label='movement-admission-install')
        decided_installer_refusal(e, db, root, fixture)
        e.sql(db, file=root / DECIDED, label='decided-hand-movement-install')
        before = e.snapshot(db, 'before-probe-data')
        catalog = e.catalog_snapshot(db, 'before-probe-catalog')
        private = fixture.private_snapshot(e, db, 'before-probe-private')
        code, stdout, stderr = e.sql(db, file=root / PROBE, label='movement-public-flow', check=False, seconds=120)
        e.report.update(case_output=stdout, case_errors=stderr)
        validate_probe(code, stdout, stderr)
        if e.snapshot(db, 'after-probe-data') != before or e.catalog_snapshot(db, 'after-probe-catalog') != catalog or fixture.private_snapshot(e, db, 'after-probe-private') != private:
            raise RuntimeError('movement qualification did not fully roll back')
        e.report.update(assertions=stderr.count('MOVEMENT PASS:'), data_rollback=True, catalog_rollback=True)
        qualify_races(e, root, native, db)
        for path, digest in manifest['source_sha256'].items():
            if sha(root / path) != digest:
                raise RuntimeError('input changed: ' + path)
        e.report.update(status='passed', failure=None)
        e.discard(db)
    except BaseException as exc:
        e.report['failure'] = repr(exc)
    finally:
        for sig in native.CANCELLATION_SIGNALS:
            signal.signal(sig, signal.SIG_IGN)
        try:
            e.close()
        except BaseException as exc:
            e.report.update(cleanup_failure=repr(exc), status='failed')
        e.report['ended_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out / 'result.json').write_text(json.dumps(e.report, indent=2) + '\n')
        print(json.dumps({key: e.report.get(key) for key in ['status', 'failure', 'assertions', 'cleanup']}), flush=True)
    return 0 if e.report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
