"""Additional exact registry and bounded seed dependency checks, before any seed."""
import json
from pathlib import Path
from build_registry import acl_entries

HERE = Path(__file__).resolve().parent


def check_registry(pre):
    expected = json.loads((HERE/'REGISTRY-EXPECTED.json').read_text())
    query = (HERE/'REGISTRY-CATALOG-QUERY.sql').read_text().rstrip().rstrip(';')
    actual = pre.one("SELECT to_jsonb(q)-'observed_at'-'server_version'-'capture_search_path' FROM ("+query+") q")
    if not isinstance(actual, dict):
        raise RuntimeError('Exact registry metadata is absent or malformed')
    acl = actual.pop('acl')
    actual['acl_is_null'] = acl is None
    actual['acl_entries'] = [] if acl is None else acl_entries(acl)
    if set(actual) != set(expected['metadata']):
        raise RuntimeError('Registry metadata field set changed')
    comparisons = [{'field':key,'expected':value,'actual':actual[key],
                    'matches':value==actual[key]} for key,value in expected['metadata'].items()]
    declarations = pre.one("SELECT COALESCE(jsonb_agg(jsonb_build_object('store',store,'treatment',treatment,'counted_by',counted_by,'notes',notes) ORDER BY store),'[]'::jsonb) FROM public.ca_chip_store_coverage")
    comparisons.append({'field':'exact_historical_declaration_set','expected':expected['declarations'],
                        'actual':declarations,'matches':declarations==expected['declarations']})
    # Presence only for already installed dependency relations. Their recorded
    # current or historical definition epoch remains in the separate input seal.
    names=json.loads((HERE/'SEED-RELATION-DEPENDENCIES.json').read_text())['required_names']
    values=','.join("('"+name+"')" for name in names)
    presence=pre.one("SELECT jsonb_agg(jsonb_build_object('name',n,'present',to_regclass(n) IS NOT NULL) ORDER BY n) FROM (VALUES "+values+") v(n)")
    present=(type(presence) is list and len(presence)==len(names)
             and all(type(r) is dict and set(r)=={'name','present'} for r in presence)
             and {r.get('name') for r in presence}==set(names)
             and all(r.get('present') is True for r in presence))
    comparisons.append({'field':'seed_relation_presence_only','actual':presence,'matches':present})
    return {'passed':all(c['matches'] for c in comparisons),'comparisons':comparisons,
            'metadata_epoch':'REGISTRY-CATALOG-CAPTURE.json; PostgreSQL17.6',
            'configuration_epoch':'Exact initial25 migration declarations, not current business rows',
            'preserves_base_preflight':True,'financial_function_invoked':False}
