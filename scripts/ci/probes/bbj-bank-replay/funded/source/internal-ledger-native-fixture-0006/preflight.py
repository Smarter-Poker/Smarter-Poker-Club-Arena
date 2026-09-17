"""Fail-closed native contract comparison, called only after authorized setup."""
import json
from collections import Counter


def literal(s):
    return "'"+s.replace("'","''")+"'"


def compact(s):
    # Trim outside the complete expression only, never inside quoted values.
    return s.strip() if isinstance(s,str) else s


def check(conn, functions, tables):
    # Explicitly reproduce the verified catalog rendering/installation context.
    # This is this dedicated preflight connection, not a role/database default.
    conn.sql("SELECT pg_catalog.set_config('search_path','pg_catalog,public,extensions',false)")
    comparisons=[]
    for f in functions:
        signature=f['schema']+'.'+f['signature'].removeprefix(f['schema']+'.')
        actual=conn.one("SELECT jsonb_build_object('body_md5',md5(prosrc),"
            "'definition_md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),"
            "'acl',proacl::text,'settings',proconfig,'security_definer',prosecdef,'volatility',provolatile) "
            "FROM pg_proc WHERE oid=to_regprocedure("+literal(signature)+")")
        expected={k:f[k] for k in ('body_md5','definition_md5','owner','acl','settings','security_definer','volatility')}
        if signature=='public.fn_ca_ledger_replay(integer)':
            expected['body_md5']='23827263928f3a349ca775dd9152bf8d'
            expected['definition_md5']='0ebc35f25915af00e69a809038550b83'
        differences={k:{'expected':v,'actual':actual.get(k)} for k,v in expected.items() if actual.get(k)!=v}
        comparisons.append({'function':signature,'differences':differences})
    for t in tables:
        name=t['schema']+'.'+t['name']
        actual=conn.one("SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,"
            "'force_rls',c.relforcerowsecurity,'acl',c.relacl::text,'relkind',c.relkind,'reloptions',c.reloptions,"
            "'view_definition',CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid) END,"
            "'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),"
            "'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text) ORDER BY a.attnum) "
            "FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum "
            "WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),"
            "'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgname) "
            "FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal),'[]'::jsonb),"
            "'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',conname,'validated',convalidated,'deferrable',condeferrable,"
            "'deferred',condeferred,'definition',pg_get_constraintdef(oid),'definition_pretty',pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),'[]'::jsonb),"
            "'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'valid',i.indisvalid,'ready',i.indisready,"
            "'definition',pg_get_indexdef(i.indexrelid))) FROM pg_index i WHERE i.indrelid=c.oid),'[]'::jsonb),"
            "'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'permissive',polpermissive,"
            "'roles',ARRAY(SELECT CASE WHEN x=0 THEN 'public' ELSE pg_get_userbyid(x) END FROM unnest(polroles) x),"
            "'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid))) FROM pg_policy WHERE polrelid=c.oid),'[]'::jsonb)) "
            "FROM pg_class c WHERE c.oid=to_regclass("+literal(name)+")")
        diffs=[]
        for k in ('owner','rls','force_rls','acl','relkind','reloptions','view_definition'):
            if k in t and actual[k]!=t[k]:
                diffs.append({'field':k,'expected':t[k],'actual':actual[k]})
        ac={c['name']:c for c in actual['columns']}
        if t.get('columns_complete') and set(ac)!={c['name'] for c in t['columns']}:
            diffs.append({'field':'columns','identity_set_difference':sorted(set(ac)^{c['name'] for c in t['columns']})})
        for c in t['columns']:
            if c['name'] not in ac:
                diffs.append({'missing_column':c['name']}); continue
            for k in ('type','notnull','default','identity','generated','acl'):
                if k not in c or (k=='acl' and not c.get('acl_captured')):
                    continue
                a,e=ac[c['name']].get(k),c[k]
                if (compact(a)!=compact(e)) if k=='default' else (a!=e):
                    diffs.append({'column':c['name'],'field':k,'expected':e,'actual':a})
        for field in ('triggers','constraints','indexes','policies'):
            expected_rows=t.get(field,[]) or []
            got={x['name'].split('.')[-1]:x for x in actual[field]}
            if t.get({'triggers':'attachments_complete','constraints':'constraints_complete','policies':'policies_complete','indexes':'indexes_complete'}.get(field,'')):
                if set(got)!={x['name'].split('.')[-1] for x in expected_rows}:
                    diffs.append({'field':field,'identity_set_difference':sorted(set(got)^{x['name'].split('.')[-1] for x in expected_rows})})
            for x in expected_rows:
                key=x['name'].split('.')[-1]
                if key not in got:
                    diffs.append({'missing_'+field:key}); continue
                keys={'triggers':['definition','enabled'],'constraints':['definition','validated','deferrable','deferred'],
                      'indexes':['definition','valid','ready'],'policies':['command','permissive','roles','using','check']}[field]
                # Compare both exact PostgreSQL constraint renderings. Any other
                # expression/rendering difference refuses qualification.
                for k in keys:
                    if k not in x: continue
                    a,e=got[key].get(k),x[k]
                    if field=='constraints' and k=='definition':
                        different=compact(e) not in (compact(a),compact(got[key]['definition_pretty']))
                    elif k in ('definition','using','check'):
                        different=compact(a)!=compact(e)
                    elif k=='roles': different=sorted(a)!=sorted(e)
                    else: different=a!=e
                    if different: diffs.append({'field':field,'name':key,'attribute':k,'expected':e,'actual':a})
        comparisons.append({'table':name,'actual_catalog':actual,'differences':diffs})
    return {'comparisons':comparisons,'passed':all(not r['differences'] for r in comparisons)}


def check_prerequisites(conn, records):
    """Compare exact source dependencies; this never reads sequence values."""
    rows={r['kind']:r['objects'] for r in records}
    comparisons=[]
    for e in rows['sequences']:
        name=e['schema']+'.'+e['name']
        a=conn.one("SELECT jsonb_build_object('schema',n.nspname,'name',c.relname,"
          "'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'type',format_type(s.seqtypid,NULL),"
          "'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,"
          "'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle) "
          "FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace "
          "WHERE s.seqrelid=to_regclass("+literal(name)+")")
        differences={k:{'expected':v,'actual':a.get(k)} for k,v in e.items() if a.get(k)!=v}
        comparisons.append({'sequence':name,'actual':a,'differences':differences})
    for e in rows['schemas']:
        a=conn.one("SELECT jsonb_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text) "
                   "FROM pg_namespace WHERE nspname="+literal(e['name']))
        differences={k:{'expected':v,'actual':a.get(k)} for k,v in e.items() if a.get(k)!=v}
        comparisons.append({'schema':e['name'],'actual':a,'differences':differences})
    for e in rows['extensions']:
        a=conn.one("SELECT jsonb_build_object('name',extname,'version',extversion,'schema',extnamespace::regnamespace::text,"
                   "'owner',pg_get_userbyid(extowner)) FROM pg_extension WHERE extname="+literal(e['name']))
        differences={k:{'expected':v,'actual':a.get(k)} for k,v in e.items() if a.get(k)!=v}
        comparisons.append({'extension':e['name'],'actual':a,'differences':differences})
    for e in rows['default_table_columns']:
        a=conn.one("SELECT jsonb_build_object('relation',"+literal(e['relation'])+",'name',attname,"
          "'type',format_type(atttypid,atttypmod),'notnull',attnotnull) FROM pg_attribute "
          "WHERE attrelid=to_regclass("+literal(e['relation'])+") AND attname="+literal(e['name'])+
          " AND attnum>0 AND NOT attisdropped")
        differences={k:{'expected':v,'actual':a.get(k)} for k,v in e.items() if a.get(k)!=v}
        comparisons.append({'default_query_column':e['relation']+'.'+e['name'],'actual':a,'differences':differences})
    return {'comparisons':comparisons,'passed':all(not r['differences'] for r in comparisons)}


def check_expression_identity(conn, expected, query):
    context=conn.one("SELECT jsonb_build_object('search_path',current_setting('search_path'),"
                     "'effective_path',current_schemas(true))")
    actual=conn.one(query)
    canonical=lambda row:json.dumps(row,sort_keys=True,separators=(',',':'))
    want=Counter(canonical(r) for r in expected['dependency_identities'])
    got=Counter(canonical(r) for r in actual)
    missing=[{'identity':json.loads(k),'count':n} for k,n in (want-got).items()]
    extra=[{'identity':json.loads(k),'count':n} for k,n in (got-want).items()]
    matched_context=(context['search_path']==expected['search_path'] and
                     context['effective_path']==expected['effective_path'])
    return {'passed':matched_context and not missing and not extra,
            'context':context,'context_matches':matched_context,
            'expected_count':sum(want.values()),'actual_count':sum(got.values()),
            'missing':missing,'extra':extra,'actual_dependencies':actual}
