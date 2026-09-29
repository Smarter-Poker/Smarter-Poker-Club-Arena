"""Render authentic catalog overlays for the existing isolated Spin allocator.

No synthetic trigger body or financial data is generated. Unknown base schema
differences fail closed. These files are fixture-only, never migrations.
"""
import hashlib
import json
from pathlib import Path
import re

BASE = Path(__file__).resolve().parent
captured = json.loads((BASE / 'catalog.json').read_text())


def q(value):
    return "'" + value.replace("'", "''") + "'"


def ident(value):
    return '"' + value.replace('"', '""') + '"'


BOUNDARY = """BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=public,extensions,pg_temp;
DO $isolation$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user NOT IN('fixture_bootstrap','postgres')
 OR current_database() NOT LIKE 'qual_spin_expiry_%'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'AUTHENTIC_CORE_PROVIDER_ISOLATION_REQUIRED'; END IF;
END $isolation$;
"""
columns = [BOUNDARY]
constraints = [BOUNDARY]
triggers = [BOUNDARY, 'SET LOCAL check_function_bodies=off;']
for relation in captured['catalog']:
    name = relation['nspname'] + '.' + relation['relname']
    # This phase runs before historical seed, not by editing a populated model.
    columns.append('DO $empty$ BEGIN IF EXISTS(SELECT 1 FROM ' + name + ') THEN RAISE EXCEPTION '
                   + q('AUTHENTIC_CORE_PROVIDER_EMPTY_REQUIRED: ' + name) + '; END IF; END $empty$;')
    for column in relation['columns']:
        col = ident(column['name'])
        spec = column['type']
        if column['generated']:
            spec += ' GENERATED ALWAYS AS (' + column['default'] + ') STORED'
        elif column['identity']:
            raise ValueError('Unexpected identity column: ' + name + '.' + col)
        elif column['default']:
            spec += ' DEFAULT ' + column['default']
        if column['notnull']:
            spec += ' NOT NULL'
        columns.append('ALTER TABLE ' + name + ' ADD COLUMN IF NOT EXISTS ' + col + ' ' + spec + ';')
        columns.append("DO $type$ BEGIN IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid="
                       + q(name) + '::regclass AND attname=' + q(column['name']) + ') IS DISTINCT FROM '
                       + q(column['type']) + ' THEN RAISE EXCEPTION ' + q('AUTHENTIC_CORE_PROVIDER_TYPE_CHANGED: ' + name + '.' + col)
                       + '; END IF; END $type$;')
        if not column['generated']:
            columns.append('ALTER TABLE ' + name + ' ALTER COLUMN ' + col + (' SET DEFAULT ' + column['default'] if column['default'] else ' DROP DEFAULT') + ';')
        columns.append('ALTER TABLE ' + name + ' ALTER COLUMN ' + col + (' SET NOT NULL;' if column['notnull'] else ' DROP NOT NULL;'))
    # Never silently drop an old constraint or its dependents. Exact current
    # definitions are required; missing ones may be restored after seed.
    for constraint in relation['constraints']:
        # Constraint-trigger metadata is recreated by its authentic CREATE
        # CONSTRAINT TRIGGER statement, never ALTER TABLE ADD CONSTRAINT.
        if constraint['type'] == 't':
            continue
        definition = constraint['definition']
        if not constraint['validated'] and 'NOT VALID' not in definition:
            definition += ' NOT VALID'
        constraints.append('DO $constraint$ DECLARE actual text; BEGIN SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint WHERE conrelid='
            + q(name) + '::regclass AND conname=' + q(constraint['name']) + '; IF actual IS NULL THEN EXECUTE '
            + q('ALTER TABLE ' + name + ' ADD CONSTRAINT ' + ident(constraint['name']) + ' ' + definition)
            + '; ELSIF actual IS DISTINCT FROM ' + q(definition) + ' THEN RAISE EXCEPTION '
            + q('AUTHENTIC_CORE_PROVIDER_CONSTRAINT_CHANGED: ' + name + '.' + constraint['name'])
            + '; END IF; END $constraint$;')
    # Reconstitute the actual captured trigger set, never disable it for tests.
    triggers.append('DO $remove_old$ DECLARE r record; BEGIN FOR r IN SELECT tgname FROM pg_trigger WHERE tgrelid='
                    + q(name) + "::regclass AND NOT tgisinternal LOOP EXECUTE format('DROP TRIGGER %I ON "
                    + name + "',r.tgname); END LOOP; END $remove_old$;")

for function in captured['functions']:
    definition = function['definition']
    schema, function_name = re.search(r'FUNCTION ([a-z_]+)\.([a-z_0-9]+)\(', definition).groups()
    signature = schema + '.' + function_name + '()'
    if not function['identity'].endswith('()'):
        raise ValueError('Expected trigger handler without arguments')
    triggers.append(definition.rstrip() + ';')
    triggers.append('ALTER FUNCTION ' + signature + ' OWNER TO ' + ident(function.get('owner', 'postgres')) + ';')
    triggers.append('REVOKE ALL ON FUNCTION ' + signature + ' FROM PUBLIC,anon,authenticated,service_role;')
    acl = function.get('acl')
    if acl is None:
        # Provider core captures use proacl, older captures use acl.
        acl = function.get('proacl')
    if acl is None:
        raise ValueError('Missing captured function ACL: ' + signature)
    for grant in acl.strip('{}').split(','):
        grantee, permissions = grant.split('=', 1)
        permissions, _grantor = permissions.split('/', 1)
        if permissions != 'X':
            raise ValueError('Unexpected function ACL: ' + grant)
        triggers.append('GRANT EXECUTE ON FUNCTION ' + signature + ' TO ' + (ident(grantee) if grantee else 'PUBLIC') + ';')
    triggers.append("DO $body$ BEGIN IF md5(pg_get_functiondef(" + q(signature) + '::regprocedure)) IS DISTINCT FROM '
                    + q(hashlib.md5(definition.encode()).hexdigest()) + ' THEN RAISE EXCEPTION '
                    + q('AUTHENTIC_CORE_PROVIDER_FUNCTION_CHANGED: ' + signature) + '; END IF; END $body$;')

for relation in captured['catalog']:
    name = relation['nspname'] + '.' + relation['relname']
    for trigger in relation['triggers']:
        triggers.append(trigger['definition'].rstrip(';') + ';')
        mode = {'O': 'ENABLE', 'D': 'DISABLE', 'A': 'ENABLE ALWAYS', 'R': 'ENABLE REPLICA'}[trigger['enabled']]
        triggers.append('ALTER TABLE ' + name + ' ' + mode + ' TRIGGER ' + ident(trigger['name']) + ';')

readback = [BOUNDARY]
for function in captured['functions']:
    schema, function_name = re.search(r'FUNCTION ([a-z_]+)\.([a-z_0-9]+)\(', function['definition']).groups()
    signature = schema + '.' + function_name + '()'
    expected = {'owner': function.get('owner','postgres'),
                'acl': sorted(function.get('acl', function.get('proacl')).strip('{}').split(',')),
                'security_definer': function['prosecdef'], 'configuration': function['proconfig'],
                'full_md5': hashlib.md5(function['definition'].encode()).hexdigest()}
    readback.append("DO $function$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),"
        "'acl',(SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(proacl) a),'security_definer',prosecdef,'configuration',proconfig,'full_md5',md5(pg_get_functiondef(oid))) INTO actual FROM pg_proc WHERE oid="
        + q(signature) + '::regprocedure; IF actual IS DISTINCT FROM ' + q(json.dumps(expected))
        + '::jsonb THEN RAISE EXCEPTION ' + q('AUTHENTIC_CORE_PROVIDER_FUNCTION_AUTHORITY_CHANGED: ' + signature)
        + ' USING DETAIL=actual::text; END IF; END $function$;')
for relation in captured['catalog']:
    name = relation['nspname'] + '.' + relation['relname']
    expected_columns = [{key: c[key] for key in ('name','type','default','notnull','identity','generated')}
                        for c in relation['columns']]
    expected_constraints = sorted([{key: c[key] for key in ('name','definition','validated')}
                                   for c in relation['constraints']], key=lambda c: c['name'])
    expected_triggers = sorted(relation['triggers'], key=lambda t: t['name'])
    readback.append("DO $columns$ DECLARE actual jsonb; BEGIN SELECT jsonb_agg(jsonb_build_object("
        "'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'default',pg_get_expr(d.adbin,d.adrelid),"
        "'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) INTO actual "
        'FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='
        + q(name) + '::regclass AND a.attnum>0 AND NOT a.attisdropped; IF actual IS DISTINCT FROM '
        + q(json.dumps(expected_columns)) + '::jsonb THEN RAISE EXCEPTION '
        + q('AUTHENTIC_CORE_PROVIDER_FULL_COLUMNS_CHANGED: ' + name) + '; END IF; END $columns$;')
    readback.append("DO $constraints$ DECLARE actual jsonb; BEGIN SELECT coalesce(jsonb_agg(jsonb_build_object("
        "'name',conname,'definition',pg_get_constraintdef(oid),'validated',convalidated) ORDER BY conname),'[]') INTO actual "
        'FROM pg_constraint WHERE conrelid=' + q(name) + '::regclass; IF actual IS DISTINCT FROM '
        + q(json.dumps(expected_constraints)) + '::jsonb THEN RAISE EXCEPTION '
        + q('AUTHENTIC_CORE_PROVIDER_FULL_CONSTRAINTS_CHANGED: ' + name) + '; END IF; END $constraints$;')
    readback.append("DO $triggers$ DECLARE actual jsonb; BEGIN SELECT coalesce(jsonb_agg(jsonb_build_object("
        "'name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled,'function',tgfoid::regprocedure::text) ORDER BY tgname),'[]') INTO actual "
        'FROM pg_trigger WHERE tgrelid=' + q(name) + '::regclass AND NOT tgisinternal; IF actual IS DISTINCT FROM '
        + q(json.dumps(expected_triggers)) + '::jsonb THEN RAISE EXCEPTION '
        + q('AUTHENTIC_CORE_PROVIDER_FULL_TRIGGERS_CHANGED: ' + name) + '; END IF; END $triggers$;')
for filename, blocks in [('columns.sql', columns), ('constraints.sql', constraints), ('triggers.sql', triggers), ('readback.sql', readback)]:
    (BASE / filename).write_text('\n\n'.join(blocks) + '\nCOMMIT;\n')
print(json.dumps({'relations': len(captured['catalog']), 'trigger_functions': len(captured['functions']),
                  'triggers': sum(len(r['triggers']) for r in captured['catalog']), 'financial_qualified': False}))
