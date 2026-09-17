"""Source-bounded DDL audit evidence; never calls a business helper or changes audit state.

The installer owns the surrounding transaction; failure readers are root-owned.
No failed/rolled-back/uncertain attempt can be accepted by the success comparator.
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDIT = 'public.ca_ddl_events'
LOCKS = 'public.privileged_function_lock'
SEQUENCE = 'public.ca_ddl_events_id_seq'
MAX_ROWS = 4096
MAX_BYTES = 1048576
MAX_COMMAND_ROWS = 25
MAX_INT = 9223372036854775807


def require(value, message):
    if not value:
        raise AssertionError(message)


def exact(a, b):
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return set(a) == set(b) and all(exact(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(exact(x, y) for x, y in zip(a, b))
    return a == b


def integer(value, minimum=1, maximum=MAX_INT):
    require(type(value) is str and re.fullmatch('0|[1-9][0-9]*', value) is not None,
            'Exact canonical audit integer text required')
    result = int(value)
    require(minimum <= result <= maximum, 'Audit integer outside source domain')
    return result


def literal(value):
    return "'" + value.replace("'", "''") + "'"


ALL_SEQUENCES = """SELECT COALESCE(jsonb_agg(jsonb_build_object(
'schema',schemaname,'name',sequencename,'owner',sequenceowner,'type',data_type::text,
'start',start_value::text,'minimum',min_value::text,'maximum',max_value::text,
'increment',increment_by::text,'cache',cache_size::text,'cycle',cycle,'last_value',last_value::text)
ORDER BY schemaname,sequencename),'[]'::jsonb) FROM pg_sequences
WHERE schemaname IN ('public','smarter_private')"""
STATE = "SELECT jsonb_build_object('last_value',last_value::text,'is_called',is_called,'log_cnt',log_cnt::text) FROM public.ca_ddl_events_id_seq"
CONTEXT = """SELECT jsonb_build_object('transaction_id',pg_current_xact_id()::text,
'transaction_timestamp',transaction_timestamp()::text,'application_name',current_setting('application_name'),
'role',current_user,'session_role',session_user,'replication_role',current_setting('session_replication_role'))"""
NO_NESTED_SWEEP = """SELECT jsonb_build_object('eligible_grant_sweep',(
SELECT count(*) FROM public.privileged_function_lock l WHERE to_regprocedure(l.function_signature) IS NOT NULL
AND (has_function_privilege('anon',to_regprocedure(l.function_signature)::oid,'EXECUTE')
OR has_function_privilege('public',to_regprocedure(l.function_signature)::oid,'EXECUTE'))),
'graphql_oid_collision',(SELECT count(*) FROM pg_extension WHERE extname='pg_graphql'
AND oid=to_regprocedure('public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text)')::oid))"""


def table_metadata(name):
    return """SELECT COALESCE((SELECT jsonb_build_object('raw_class',to_jsonb(c),
'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'kind',c.relkind,'rls',c.relrowsecurity,
'forced',c.relforcerowsecurity,'columns',(SELECT jsonb_agg(jsonb_build_object(
'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,
'identity',a.attidentity,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
'raw_attributes',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid),
'raw_defaults',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_attrdef d WHERE d.adrelid=c.oid),'[]'::jsonb),
'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'raw',to_jsonb(k)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid OR k.confrelid=c.oid),'[]'::jsonb),
'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'raw_index',to_jsonb(i),'raw_class',to_jsonb(ic)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]'::jsonb),
'triggers',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid),'[]'::jsonb),
'rules',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
'policies',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb))
FROM pg_class c WHERE c.oid=to_regclass(""" + literal(name) + ")),'null'::jsonb)"


def helper_query(names):
    return """SELECT COALESCE(jsonb_agg(jsonb_build_object('identity',n.nspname||'.'||p.proname||'()',
'source',p.prosrc,'owner',pg_get_userbyid(p.proowner),'language',l.lanname,
'settings',p.proconfig,'security_definer',p.prosecdef,'result',p.prorettype::regtype::text,
'nargs',p.pronargs,'kind',p.prokind,'volatility',p.provolatile,'parallel',p.proparallel,
'strict',p.proisstrict,'leakproof',p.proleakproof,'raw',to_jsonb(p)) ORDER BY n.nspname,p.proname),'[]'::jsonb)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
WHERE p.oid IN (""" + ','.join('to_regprocedure(' + literal(n) + ')' for n in names) + ')'


def capture(conn, report, sequence_query):
    """Retain each attempted raw read; callers must reject errors before acceptance.

    Even after a previous query fails, later reads are attempted. An aborted
    transaction therefore retains explicit refusals rather than empty evidence.
    """
    require(type(report) is dict and not report, 'Fresh audit report required')
    model = json.loads((HERE / 'AUDIT-EXPECTED.json').read_text())
    report.update(errors=[], raw={}, sizes={}, metadata={})
    def attempt(container, key, sql):
        try:
            container[key] = conn.one(sql)
        except Exception as exc:
            report['errors'].append({'part':key, 'type':type(exc).__name__, 'error':str(exc)})
    for name in (AUDIT, LOCKS):
        attempt(report['metadata'], name, table_metadata(name))
        payload = "to_jsonb(t)||jsonb_build_object('_xmin',t.xmin::text)"
        if name == AUDIT:
            payload += "||jsonb_build_object('id',t.id::text,'occurred_at',t.occurred_at::text)"
        else:
            payload += "||jsonb_build_object('locked_at',t.locked_at::text)"
        attempt(report['sizes'], name, 'SELECT jsonb_build_object(\'count\',count(*),\'bytes\',COALESCE(sum(octet_length((' + payload + ')::text)),0)) FROM ' + name + ' t')
        bound = report['sizes'].get(name)
        if (type(bound) is dict and type(bound.get('count')) is int and
                type(bound.get('bytes')) is int and 0 <= bound['count'] <= MAX_ROWS and
                0 <= bound['bytes'] <= MAX_BYTES):
            order = 't.id' if name == AUDIT else 't.function_signature'
            attempt(report['raw'], name, 'SELECT COALESCE(jsonb_agg(' + payload + ' ORDER BY ' + order + "),'[]'::jsonb) FROM " + name + ' t')
        else:
            report['errors'].append({'part':name, 'error':'Bound missing or exceeded; no raw extraction'})
    attempt(report, 'sequence_catalog', sequence_query(SEQUENCE))
    attempt(report, 'sequence_state', STATE)
    attempt(report, 'sequence_count', "SELECT to_jsonb(count(*)) FROM pg_sequences WHERE schemaname IN ('public','smarter_private')")
    if type(report.get('sequence_count')) is int and 0 < report['sequence_count'] <= 256:
        attempt(report, 'all_sequences', ALL_SEQUENCES)
    else:
        report['errors'].append({'part':'all_sequences','error':'Complete sequence count missing or exceeds 256; no extraction'})
    attempt(report, 'helpers', helper_query([h['identity'] for h in model['helpers']]))
    attempt(report, 'event_triggers_raw', "SELECT COALESCE(jsonb_agg(jsonb_build_object('raw',to_jsonb(e),'function',n.nspname||'.'||p.proname||'()') ORDER BY e.evtname),'[]'::jsonb) FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace")
    attempt(report, 'nested_guard', NO_NESTED_SWEEP)
    # A read-only failure reader does not allocate a transaction ID.
    attempt(report, 'context', CONTEXT.replace('pg_current_xact_id()::text', 'pg_current_xact_id_if_assigned()::text'))
    return report


def validate_capture(value):
    model = json.loads((HERE / 'AUDIT-EXPECTED.json').read_text())
    require(value.get('errors') == [], 'Incomplete audit capture')
    for name in (AUDIT, LOCKS):
        rows = value['raw'][name]
        require(type(rows) is list and len(rows) == value['sizes'][name]['count'], 'Audit bound/extraction mismatch')
        require(len(json.dumps(rows, ensure_ascii=False).encode()) <= MAX_BYTES + MAX_ROWS * 4, 'Audit retained-byte bound exceeded')
        actual = value['metadata'][name]
        expected = model['tables'][name]
        for key in ('owner','acl','kind','rls','forced','columns','triggers','rules','policies'):
            require(exact(actual[key], expected[key]), 'Original audit table metadata differs: ' + name + ':' + key)
        require([{'name':r['name'],'definition':r['definition']} for r in actual['constraints']] == expected['constraints'], 'Original audit constraints differ')
        require([{'name':r['name'],'definition':r['definition']} for r in actual['indexes']] == expected['indexes'], 'Original audit index expressions differ')
    catalog = value['sequence_catalog']
    require(exact(catalog['model'], model['sequence']), 'Original audit sequence configuration/attachment differs')
    helpers = [{k:v for k,v in row.items() if k != 'raw'} for row in value['helpers']]
    require(exact(helpers, model['helpers']), 'Original reachable DDL helper source/metadata differs')
    events = value['event_triggers_raw']
    require(type(events) is list and 0 < len(events) <= 32 and len({e['raw']['evtname'] for e in events}) == len(events), 'Complete bounded original event attachments required')
    watchdog = [e for e in events if e['raw']['evtname'] == 'ca_ddl_watchdog_log']
    require(len(watchdog) == 1 and watchdog[0]['function'] == 'public.ca_log_ddl_event()' and
            watchdog[0]['raw']['evtevent'] == 'ddl_command_end' and watchdog[0]['raw']['evtenabled'] == 'O' and
            watchdog[0]['raw']['evttags'] is None, 'Original audit attachment differs')
    require(value['nested_guard'] == {'eligible_grant_sweep':0,'graphql_oid_collision':0}, 'Unmodeled nested DDL branch is eligible')
    state = value['sequence_state']
    require(set(state) == {'last_value','is_called','log_cnt'} and type(state['is_called']) is bool, 'Complete sequence state required')
    require(integer(state['last_value']) <= MAX_INT-MAX_COMMAND_ROWS-32,
            'Original audit sequence lacks capacity for finite dispatch and WAL prelogging')
    integer(state['log_cnt'],0,32)
    require(value['context']['role'] == value['context']['session_role'] == 'postgres' and value['context']['replication_role'] == 'origin', 'Original audit actor differs')


def planned_events(models, choice):
    """Select only sealed source commands after complete before/after model selection."""
    source = json.loads((HERE / 'AUDIT-EXPECTED.json').read_text())
    events = []
    dispatches = []
    for kind in ('functions','tables','sequences'):
        require(len(models[kind]) == len(choice[kind]), 'Complete preimage selection required')
        for item, phase in zip(models[kind], choice[kind]):
            require(phase in ('before','after'), 'Unknown original preimage')
            if phase == 'after':
                continue
            for sql in item['statements']:
                match = [r for r in source['dispatches'] if r['sql'] == sql]
                require(len(match) == 1, 'Unmodeled DDL dispatch')
                dispatches.append(sql)
                events.extend(match[0]['events'])
    require(len(dispatches) <= 23 and len(events) <= MAX_COMMAND_ROWS, 'Finite source DDL envelope exceeded')
    return {'dispatches':dispatches, 'events':events,
            'move_replaced':any(e['command_tag'] == 'CREATE FUNCTION' for e in events)}


def keyed(rows, key):
    result = {}
    for row in rows:
        require(type(row) is dict and row.get(key) is not None and row[key] not in result, 'Duplicate/missing audit identity')
        integer(row.get('_xmin'),1,4294967295)
        result[row[key]] = row
    return result


def assert_transition(before, after, plan, statements, context):
    """Success only. Consumed values with missing rows are an explicit failure."""
    validate_capture(before); validate_capture(after)
    require([r['sql'] for r in statements] == plan['dispatches'] and all(r['status'] == 'RETURNED' for r in statements), 'Exact returned dispatch provenance required')
    require(exact(before['metadata'],after['metadata']) and exact(before['helpers'],after['helpers']) and exact(before['event_triggers_raw'],after['event_triggers_raw']) and
            exact(before['sequence_catalog'],after['sequence_catalog']), 'Audit attachment/configuration/OID changed')
    require(exact(before['context'], after['context']) and exact(context, before['context']), 'Original installer transaction/context changed')
    integer(context['transaction_id'])
    old = keyed(before['raw'][AUDIT], 'id'); new = keyed(after['raw'][AUDIT], 'id')
    require(all(exact(new.get(k),v) for k,v in old.items()), 'Original audit row/body/xmin changed')
    added = [r for k,r in new.items() if k not in old]
    require(len(added) == len(plan['events']) <= MAX_COMMAND_ROWS, 'Source-derived audit record count differs (including swallowed logger failure)')
    bs = before['sequence_state']; es = after['sequence_state']; start = integer(bs['last_value']) + int(bs['is_called'])
    require(start + len(added) - 1 <= MAX_INT, 'Audit sequence would exhaust its original domain')
    require([integer(r['id']) for r in added] == list(range(start,start + len(added))), 'Audit identities do not exactly account for sequence allocations')
    for row, event in zip(added, plan['events']):
        require(set(row) == {'id','occurred_at','command_tag','object_type','object_identity','schema_name','triggers_pgrst_reload','role_name','application_name','query_snippet','_xmin'}, 'Unexpected audit row shape')
        for key in ('command_tag','object_type','object_identity','schema_name','triggers_pgrst_reload'):
            require(exact(row[key],event[key]), 'Audit command/object provenance differs: ' + key)
        # Psql's top-level query buffer retains the source statement, not the nested EXECUTE text.
        require(row['query_snippet'] in event['query_snippets'], 'Audit query does not match original dispatched source')
        require(row['role_name'] == 'postgres' and row['application_name'] == context['application_name'] and
                row['occurred_at'] == context['transaction_timestamp'], 'Audit transaction/default provenance differs')
        # The unchanged EXCEPTION block uses a subtransaction. Its physical
        # xmin is retained and validated, never equated to the top-level xid.
        integer(row['_xmin'],1,4294967295)
    if added:
        require(es['last_value'] == str(start + len(added) - 1) and es['is_called'] is True, 'Audit sequence transition does not match exact rows')
        # PG17.11 prelogs 32 values. Checkpoint/WAL decisions can replenish that
        # counter during allocation; this is bounded physical WAL metadata only.
        remaining = integer(bs['log_cnt'],0,32) - len(added)
        allowed = set(range(max(0,33-len(added)),33))
        if bs['is_called'] and remaining >= 0:
            allowed.add(remaining)
        require(integer(es['log_cnt'],0,32) in allowed, 'Audit WAL prelog counter outside possible bounded allocations')
    else:
        require(exact(bs,es), 'No-op changed audit sequence state')
    for snapshot in (before,after):
        seqs = snapshot['all_sequences']
        require(type(seqs) is list and len(seqs) == snapshot['sequence_count'] <= 256, 'Bounded complete sequence inventory required')
        require(len({(r['schema'],r['name']) for r in seqs}) == len(seqs), 'Duplicate sequence inventory')
    bseq = {(r['schema'],r['name']):r for r in before['all_sequences']}
    aseq = {(r['schema'],r['name']):r for r in after['all_sequences']}
    require(set(bseq) == set(aseq) and ('public','ca_ddl_events_id_seq') in bseq, 'Sequence inventory changed')
    for key, row in bseq.items():
        other = aseq[key]
        if key == ('public','ca_ddl_events_id_seq'):
            require(exact({k:v for k,v in row.items() if k!='last_value'}, {k:v for k,v in other.items() if k!='last_value'}), 'Audit sequence configuration changed')
            for observed, state in ((row,bs),(other,es)):
                require(observed['last_value'] == (state['last_value'] if state['is_called'] else None), 'Sequence view/direct-state mismatch')
        else:
            require(exact(row,other), 'Unrelated sequence changed: ' + '.'.join(key))
    oldlock = keyed(before['raw'][LOCKS], 'function_signature'); newlock = keyed(after['raw'][LOCKS], 'function_signature')
    require(all(exact(newlock.get(k),v) for k,v in oldlock.items()), 'Original privilege lock row changed')
    addedlocks = [r for k,r in newlock.items() if k not in oldlock]
    source = json.loads((HERE/'AUDIT-EXPECTED.json').read_text())
    sig = source['move_lock']['function_signature']
    count = int(plan['move_replaced'] and sig not in oldlock)
    require(len(addedlocks) == count, 'Unmodeled original privilege-lock side effect')
    if count:
        r = addedlocks[0]
        require(set(r) == {'function_signature','security_definer','reason','locked_at','_xmin'} and
                all(exact(r.get(k),v) for k,v in source['move_lock'].items()) and
                r['locked_at'] == context['transaction_timestamp'], 'Original move privilege-lock provenance differs')
        integer(r['_xmin'],1,4294967295)
    return {'status':'EXACT_SOURCE_AUDIT_TRANSITION','audit_rows_added':len(added),'lock_rows_added':count,
            'all_sequence_count':len(bseq),'no_swallowed_insert_gap':True,'financial_durability_claimed':False}


def assert_legacy_sequences(raw_before, raw_after, audit_before, audit_after):
    """Keep the original case's entire sequence capture; cross-bind its audit row."""
    rows = []
    for raw, audit in ((raw_before,audit_before),(raw_after,audit_after)):
        observed = raw['sequences']
        expected = [{k:r[k] for k in ('schema','name','last_value','increment','cache')} for r in audit['all_sequences']]
        require(exact(observed, expected), 'Original case sequence inventory differs from full audit capture')
        rows.append({(r['schema'],r['name']):r for r in observed})
    require(set(rows[0]) == set(rows[1]), 'Original sequence inventory changed')
    for key in rows[0]:
        if key != ('public','ca_ddl_events_id_seq'):
            require(exact(rows[0][key],rows[1][key]), 'Unrelated original case sequence changed')


def assert_persisted(expected, actual):
    """Same accepted afterimage on a later owned reader; no inference from failure."""
    validate_capture(expected); validate_capture(actual)
    for key in ('raw','metadata','helpers','event_triggers_raw','sequence_catalog','sequence_state','all_sequences','sequence_count'):
        require(exact(expected[key],actual[key]), 'Committed audit afterimage differs: ' + key)
    return {'status':'EXACT_COMMITTED_AUDIT_AFTERIMAGE','financial_durability_claimed':False}
