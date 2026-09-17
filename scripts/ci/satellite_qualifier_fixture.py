"""Task-local current satellite dependency composition; never connects to production.

Reuses the retained, real, empty financial catalog and the existing native
Execution owner. Captured current successors replace only that content-bound
fixture. The seven new accounting relations come from their exact catalog,
including guards and access. No financial function is stubbed.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import re
import sys

DATA = Path("scripts/ci/fixtures/satellite-qualifiers")
sys.dont_write_bytecode = True

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def lit(value):
    return "'" + value.replace("'", "''") + "'"

def ident(value):
    return '"' + value.replace('"', '""') + '"'

def jsonsql(value):
    return lit(json.dumps(value, separators=(',', ':'))) + '::jsonb'

def module(path, name):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

def table_sql(row):
    name = 'public.' + ident(row['name'])
    result = ["DO $absent$ BEGIN IF to_regclass(" + lit(name) + ") IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;"]
    columns = []
    for c in row['columns']:
        if c['identity']:
            raise ValueError('unexpected generated identity requiring sequence capture')
        value = ident(c['name']) + ' ' + c['type']
        if c['generated']:
            if c['generated'] != 's':
                raise ValueError('unknown generated column')
            value += ' GENERATED ALWAYS AS (' + c['default'] + ') STORED'
        elif c['default'] is not None:
            value += ' DEFAULT ' + c['default']
        if c['notnull']:
            value += ' NOT NULL'
        columns.append(value)
    result.append('CREATE TABLE ' + name + '(' + ','.join(columns) + ');')
    for c in row['constraints'] or []:
        if c['type'] == 'f':
            continue  # All seven relations must exist before their exact FKs.
        if not c['validated']:
            raise ValueError('unexpected unvalidated constraint')
        result.append('ALTER TABLE ' + name + ' ADD CONSTRAINT ' + ident(c['name']) + ' ' + c['definition'] + ';')
    for i in row['indexes'] or []:
        if not i['constraint']:
            result.append(i['definition'] + ';')
    result.append('ALTER TABLE ' + name + ' OWNER TO ' + ident(row['owner']) + ';')
    result.append('REVOKE ALL ON TABLE ' + name + ' FROM PUBLIC,anon,authenticated,service_role,postgres;')
    for g in row['grants'] or []:
        if g['privilege'] not in {'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'}:
            raise ValueError('unknown table privilege')
        result.append('GRANT ' + g['privilege'] + ' ON TABLE ' + name + ' TO ' + ('PUBLIC' if g['role'] == 'PUBLIC' else ident(g['role'])) + (' WITH GRANT OPTION' if g['grantable'] else '') + ';')
    commands = {'*':'ALL','r':'SELECT','a':'INSERT','w':'UPDATE','d':'DELETE'}
    for p in row['policies'] or []:
        result.append('CREATE POLICY ' + ident(p['name']) + ' ON ' + name + (' AS PERMISSIVE' if p['permissive'] else ' AS RESTRICTIVE') + ' FOR ' + commands[p['command']] + ' TO ' + ','.join('PUBLIC' if r == 'public' else ident(r) for r in p['roles']) + (' USING (' + p['qual'] + ')' if p['qual'] else '') + (' WITH CHECK (' + p['check'] + ')' if p['check'] else '') + ';')
    if row['rls']:
        result.append('ALTER TABLE ' + name + ' ENABLE ROW LEVEL SECURITY;')
    if row['force_rls']:
        result.append('ALTER TABLE ' + name + ' FORCE ROW LEVEL SECURITY;')
    return '\n'.join(result)

def function_sql(row):
    definition = row['definition']
    tag = re.search(r'\bAS\s+(\$[A-Za-z_0-9]*\$)', definition, re.I)
    body = definition[tag.end():definition.index(tag[1], tag.end())]
    if hashlib.md5(body.encode()).hexdigest() != row['source_md5'] or hashlib.md5(definition.encode()).hexdigest() != row['definition_md5']:
        raise ValueError('capture changed: ' + row['signature'])
    signature = 'public.' + row['signature']
    roles = {'PUBLIC','anon','authenticated','service_role','postgres'} | {g['role'] for g in row['grants']}
    result = [definition.rstrip().rstrip(';') + ';', 'ALTER FUNCTION ' + signature + ' OWNER TO ' + ident(row['owner']) + ';', 'REVOKE ALL ON FUNCTION ' + signature + ' FROM ' + ','.join('PUBLIC' if r == 'PUBLIC' else ident(r) for r in sorted(roles)) + ';']
    for g in row['grants']:
        if g['privilege'] != 'EXECUTE':
            raise ValueError('unexpected function privilege')
        result.append('GRANT EXECUTE ON FUNCTION ' + signature + ' TO ' + ('PUBLIC' if g['role'] == 'PUBLIC' else ident(g['role'])) + (' WITH GRANT OPTION' if g['grantable'] else '') + ';')
    expected = sorted(row['grants'], key=lambda g: (g['role'],g['privilege']))
    result.append("DO $exact_function$ DECLARE actual jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=" + lit(signature) + "::regprocedure AND md5(p.prosrc)=" + lit(row['source_md5']) + " AND md5(pg_get_functiondef(p.oid))=" + lit(row['definition_md5']) + " AND pg_get_userbyid(p.proowner)=" + lit(row['owner']) + ") THEN RAISE EXCEPTION 'current captured function differs: %'," + lit(signature) + "; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) INTO actual FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=" + lit(signature) + "::regprocedure; IF actual IS DISTINCT FROM " + jsonsql(expected) + " THEN RAISE EXCEPTION 'current function ACL differs: %'," + lit(signature) + "; END IF; END $exact_function$;")
    return '\n'.join(result)

def exact_table_sql(row):
    # Compare semantic catalog state, not OIDs or incidental pg_dump order.
    expected = dict(row)
    for key in ['constraints','indexes','policies','triggers']:
        if expected[key] is not None:
            expected[key] = sorted(expected[key], key=lambda x:x['name'])
    expected['grants'] = sorted(expected['grants'],key=lambda x:(x['role'],x['privilege']))
    query = r"""SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid=""" + lit('public.'+row['name']) + '::regclass;'
    return 'DO $exact_table$ DECLARE actual jsonb; BEGIN '+query+' IF actual IS DISTINCT FROM '+jsonsql(expected)+" THEN RAISE EXCEPTION 'captured table differs: %',"+lit(row['name'])+" USING DETAIL=actual::text; END IF; END $exact_table$;\n"

def compose(root):
    root = root.resolve()
    loader = root/'scripts/ci/satellite_qualifier_fixture.py'
    if sha(Path(__file__)) != sha(loader):
        raise ValueError('executed satellite fixture loader differs from recorded source')
    HERE = root / DATA
    ROOT_CAPTURE = HERE
    binding_path = HERE / 'source-binding.json'
    binding = json.loads(binding_path.read_text())
    required = {'current-rank-survivors-20260917.json', 'current-entry-close-table-20260917.json', 'current-rake-triggers-20260917.json', 'current-entry-close-functions-20260917.json', 'current-dependencies-level3.json', 'current-dependencies-level4.json', 'current-dependencies-level2.json', 'current-committed-terms-20260917.json', 'current-satellite-dependencies.json', 'financial-foundation-supplement.sql', 'current-satellite-settlement.json', 'current-dependent-guards-20260917.json', 'current-terminal-triggers-20260917.json', 'current-dependencies-level5.json', 'current-tables-20260917.json', 'current-fee-cutover-20260917.json'}
    if set(binding['files']) != required:
        raise ValueError('exact satellite fixture input set differs')
    for name, digest in binding['files'].items():
        if Path(name).name != name or sha(HERE / name) != digest:
            raise ValueError('satellite fixture source binding differs: ' + name)
    base = module(root/'scripts/ci/mtt_unlimited_fixture.py', 'satellite_canonical_fixture').compose(root)
    if hashlib.sha256(base['sql'].encode()).hexdigest() != binding['base_sql_sha256']:
        raise ValueError('satellite canonical base differs')
    foundation = base['sql'] + (HERE/'financial-foundation-supplement.sql').read_text()
    if hashlib.sha256(foundation.encode()).hexdigest() != binding['financial_foundation_sha256']:
        raise ValueError('satellite financial foundation differs')
    inputs = [binding_path,HERE/'financial-foundation-supplement.sql',loader,HERE/'current-tables-20260917.json',HERE/'current-terminal-triggers-20260917.json',HERE/'current-rake-triggers-20260917.json',HERE/'current-fee-cutover-20260917.json',ROOT_CAPTURE/'current-satellite-dependencies.json',ROOT_CAPTURE/'current-satellite-settlement.json']
    captures = [ROOT_CAPTURE/'current-satellite-dependencies.json'] + [HERE/f'current-dependencies-level{i}.json' for i in range(2,6)] + [HERE/'current-dependent-guards-20260917.json',HERE/'current-rank-survivors-20260917.json']
    inputs += captures
    rows = {}
    for path in captures:
        for row in json.loads(path.read_text())['rows']:
            row = dict(row)
            row['grants'] = [g if 'role' in g else {'role':g['grantee'],'grantor':g['grantor'],'privilege':g['privilege_type'],'grantable':g['is_grantable']} for g in row['grants']]
            if row['signature'] in rows and rows[row['signature']]['definition_md5'] != row['definition_md5']:
                raise ValueError('conflicting contemporaneous capture: ' + row['signature'])
            rows[row['signature']] = row
    trigger_capture = json.loads((HERE/'current-rake-triggers-20260917.json').read_text())['rows']
    terminal_triggers = json.loads((HERE/'current-terminal-triggers-20260917.json').read_text())['triggers']
    overlay = [t for t in terminal_triggers if t['function']=='fn_ca_fund_overlay_on_lock()']
    if len(overlay)!=1:
        raise ValueError('current overlay owner capture differs')
    t=overlay[0]
    rows[t['function']]={**t,'signature':t['function'],'definition':t['function_definition']}
    # Current fee guards are genuine new dependencies, with their enabled
    # deferred trigger. Other trigger functions are authenticated below.
    for t in trigger_capture:
        row = {k:t[k] for k in ['source_md5','definition_md5','owner','proconfig','grants']}
        row.update(signature=t['function'],definition=t['function_definition'],proname=t['function'].split('(')[0])
        if row['signature'] in rows and rows[row['signature']]['definition_md5'] != row['definition_md5']:
            raise ValueError('trigger/function capture conflict')
        rows[row['signature']] = row
    core = json.loads((ROOT_CAPTURE/'current-satellite-settlement.json').read_text())
    # Root's retained core ACL is the actual postgres/service_role pair.
    core.update(signature='fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',proname='fn_settle_satellite_tournament_pre_money_path_gate',grants=[{'role':r,'grantor':'postgres','privilege':'EXECUTE','grantable':False} for r in ['postgres','service_role']])
    rows[core['signature']] = core
    tables = [r for r in json.loads((HERE/'current-tables-20260917.json').read_text())['tables'] if r['name'].startswith('accounting_')]
    if len(tables) != 7:
        raise ValueError('exact new accounting table set changed')
    result = foundation + '\nBEGIN;\n'
    result += "DO $local_only$ BEGIN IF current_database() !~ '^r46_mtt_isolation_' OR current_user<>'postgres' OR inet_server_addr() IS NOT NULL OR (SELECT count(*) FROM auth.users)<>1 OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id='46460000-0000-4000-8000-000000000001') OR EXISTS(SELECT 1 FROM public.tournaments) THEN RAISE EXCEPTION 'current satellite composition requires its exact retained fixture opening'; END IF; END $local_only$;\n"
    result += '\n'.join(table_sql(t) for t in tables) + '\n'
    for t in tables:
        for c in t['constraints'] or []:
            if c['type'] == 'f':
                result += 'ALTER TABLE public.' + ident(t['name']) + ' ADD CONSTRAINT ' + ident(c['name']) + ' ' + c['definition'] + ';\n'
    result += '\n'.join(function_sql(r) for r in rows.values()) + '\n'
    # Every current tournament/seat trigger remains in its captured enabled
    # state; no proposed Stage-B activation is silently mixed into this proof.
    for t in terminal_triggers:
        sig=t['function'] if '.' in t['function'].split('(')[0] else 'public.'+t['function']
        result += "DO $current_terminal_guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid="+lit('public.'+t['relation'])+"::regclass AND tgname="+lit(t['name'])+" AND tgenabled="+lit(t['enabled'])+" AND pg_get_triggerdef(oid,true)="+lit(t['definition'])+") OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid="+lit(sig)+"::regprocedure AND md5(prosrc)="+lit(t['source_md5'])+" AND md5(pg_get_functiondef(oid))="+lit(t['definition_md5'])+" AND pg_get_userbyid(proowner)="+lit(t['owner'])+") THEN RAISE EXCEPTION 'captured current terminal guard differs: %',"+lit(t['name'])+"; END IF; END $current_terminal_guard$;\n"
    for t in tables:
        for trigger in t['triggers'] or []:
            if trigger['enabled'] != 'O':
                raise ValueError('non-origin capture trigger')
            result += trigger['definition'] + ';\n'
        result += exact_table_sql(t)
    for t in trigger_capture:
        # These four current guards are absent from the retained catalog.
        if t['trigger'] in {'accounting_cash_source_immutable','accounting_tournament_fee_commit_capture','accounting_tournament_fee_source_immutable','accounting_tournament_recognized_evidence_immutable'}:
            result += "DO $absent_trigger$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.rake_records'::regclass AND tgname=" + lit(t['trigger']) + ") THEN RAISE EXCEPTION 'new fee trigger unexpectedly present'; END IF; END $absent_trigger$;\n" + t['definition'] + ';\n'
        result += "DO $exact_trigger$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=" + lit('public.'+t['table']) + "::regclass AND tgname=" + lit(t['trigger']) + " AND tgenabled=" + lit(t['enabled']) + " AND pg_get_triggerdef(oid)=" + lit(t['definition']) + ") THEN RAISE EXCEPTION 'current rake trigger differs: %'," + lit(t['trigger']) + "; END IF; END $exact_trigger$;\n"
    cutover = json.loads((HERE/'current-fee-cutover-20260917.json').read_text())
    if cutover['table'] != 'public.accounting_tournament_fee_cutover' or len(cutover['rows']) != 1:
        raise ValueError('fee cutover declaration differs')
    result += 'INSERT INTO public.accounting_tournament_fee_cutover SELECT * FROM jsonb_populate_recordset(NULL::public.accounting_tournament_fee_cutover,' + jsonsql(cutover['rows']) + ');\nCOMMIT;\n'
    hashes = dict(base['source_sha256'])
    hashes.update({str(p.relative_to(root)):sha(p) for p in set(inputs)})
    entry_table = json.loads((HERE/'current-entry-close-table-20260917.json').read_text())['tables'][0]
    entry = 'BEGIN;\n' + table_sql(entry_table) + '\n'
    for c in entry_table['constraints']:
        if c['type'] == 'f':
            entry += 'ALTER TABLE public.'+ident(entry_table['name'])+' ADD CONSTRAINT '+ident(c['name'])+' '+c['definition']+';\n'
    for name in ['current-entry-close-functions-20260917.json','current-committed-terms-20260917.json']:
        entry += '\n'.join(function_sql(row) for row in json.loads((HERE/name).read_text())['rows'])+'\n'
    for t in entry_table['triggers']:
        if t['enabled'] != 'O': raise ValueError('entry-close trigger state differs')
        entry += t['definition']+';\n'
    entry += exact_table_sql(entry_table)+'\nCOMMIT;\n'
    hashes.update({str(DATA/name):sha(HERE/name) for name in required})
    return {'sql':result, 'entry_sql':entry, 'source_sha256':hashes,
            'function_count':len(rows), 'new_tables':[t['name'] for t in tables],
            'limits':['Current captured financial closure; historical full_stage1 not recreated.',
                      'Private synthetic opening; no production mutation or R46 activation.']}
