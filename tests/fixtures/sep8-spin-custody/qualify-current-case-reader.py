"""Reader successor, exercised inside the existing full-schema Spin phase."""
import hashlib
import json
import re
import subprocess

def qualify(root, fix, out, cmd, run, schema):
    capture = json.loads((fix/'current-case-reader-catalog.json').read_text())
    migration = root/'supabase/migrations/20260918212229_original_spin_reader_preserves_exact_indexed_history_coverag.sql'
    source = migration.read_text()
    def query(sql):
        return subprocess.check_output(cmd+['-At','-c',sql], text=True).strip()
    def value(sql):
        return json.loads(query(sql))
    signature = 'smarter_private.spin_original_current_case(uuid)'
    metadata = "SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a),'config',p.proconfig) FROM pg_proc p WHERE p.oid='"+signature+"'::regprocedure"
    before = value(metadata)
    if before != {k:capture['function'][k] for k in before}:
        raise AssertionError('Reader original function/owner/ACL/config differs')
    # Actual installer must refuse changed authority, with complete schema rollback.
    for mode, drift, restore in [
        ('config', "ALTER FUNCTION "+signature+" SET statement_timeout='7s';", "ALTER FUNCTION "+signature+" RESET statement_timeout;"),
        ('acl', "GRANT EXECUTE ON FUNCTION "+signature+" TO service_role;", "REVOKE EXECUTE ON FUNCTION "+signature+" FROM service_role;"),
    ]:
        run(drift, 'sep8-reader-'+mode+'-drift')
        state = schema()
        p = out/('sep8-reader-'+mode+'-refusal.sql')
        p.write_text(source)
        response = subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True)
        (out/('sep8-reader-'+mode+'-refusal.log')).write_text(response.stdout+response.stderr)
        if not response.returncode or 'SPIN_ORIGINAL_READER_PREIMAGE_CHANGED' not in response.stderr or schema()!=state:
            raise AssertionError('Reader installer accepted '+mode+' drift or changed schema')
        run(restore, 'sep8-reader-'+mode+'-restore')
    # These exact production indexes are context, not new production DDL.
    for index in capture['indexes']:
        present = query("SELECT coalesce(pg_get_indexdef(to_regclass('public."+index['name']+"')),'')")
        if not present:
            run(index['definition']+';', 'sep8-reader-index-'+index['name'])
        elif present != index['definition']:
            raise AssertionError('Reader index definition differs: '+index['name'])
    originals = value("SELECT jsonb_object_agg(tournament_id,smarter_private.spin_original_current_case(tournament_id)) FROM sep8_spin_fixture.cases")
    event = '199a71a9-f364-4e90-a3ba-3cdcfb7755bc'
    # Transaction-local semantic controls independently enumerate included rows.
    semantic = (fix/'current-case-reader-coverage.sql').read_text()
    run(semantic, 'sep8-reader-before-coverage')
    # Large unrelated population exposes the exact OR/IN access path in a real
    # planner, without running EXPLAIN ANALYZE or relying on wall-clock timing.
    setup = """
BEGIN;
SET LOCAL session_replication_role=replica;
CREATE TABLE sep8_spin_fixture.reader_population(id uuid PRIMARY KEY);
WITH source AS (SELECT h.* FROM public.hand_history h WHERE tournament_id<>'199a71a9-f364-4e90-a3ba-3cdcfb7755bc' LIMIT 1),
rows AS (
 SELECT r.* FROM source s,generate_series(1,30000) n,
 jsonb_populate_record(NULL::public.hand_history,to_jsonb(s)||jsonb_build_object('id',md5('spin-reader-scale:'||n)::uuid,'hand_number',200000000+n)) r
), inserted AS (INSERT INTO public.hand_history SELECT * FROM rows RETURNING id)
INSERT INTO sep8_spin_fixture.reader_population SELECT id FROM inserted;
SET LOCAL session_replication_role=origin;
COMMIT;
ANALYZE public.hand_history;
ANALYZE public.tables;
"""
    run(setup,'sep8-reader-plan-population')
    if query('SELECT count(*) FROM sep8_spin_fixture.reader_population')!='30000':
        raise AssertionError('Reader scale population missing')
    boundary = query("SELECT max(hand_number) FROM public.tournament_knockout_candidates WHERE tournament_id='"+event+"'")
    def plan(definition):
        match = re.search(r"\('history','((?:''|[^'])*)'\)", definition)
        if not match:
            raise AssertionError('History query missing from actual installed reader')
        sql = match.group(1).replace("''","'")
        sql = sql.replace('$1',"'"+event+"'::uuid").replace('$2',boundary)
        return value('EXPLAIN (FORMAT JSON) '+sql)
    def scoped(plan):
        scans=[]
        def walk(node):
            if node.get('Relation Name')=='hand_history':
                scans.append(node)
            for child in node.get('Plans',[]): walk(child)
        walk(plan[0]['Plan'])
        def bound(condition):
            return any(column in condition for column in ['tournament_id','table_id'])
        def indexed(node):
            if bound(node.get('Index Cond','')):
                return True
            # PostgreSQL may choose a scoped bitmap heap/index pair at the
            # native population density. Require both the heap recheck and
            # its actual index child; a filtered sequential scan still fails.
            children=node.get('Plans',[])
            return (node.get('Node Type')=='Bitmap Heap Scan'
                and bound(node.get('Recheck Cond','')) and bool(children)
                and all(c.get('Node Type')=='Bitmap Index Scan'
                    and bound(c.get('Index Cond','')) for c in children))
        return bool(scans) and all(indexed(node) for node in scans)
    old_plan=plan(before['definition'])
    (out/'sep8-reader-plan-before.json').write_text(json.dumps(old_plan,indent=2)+'\n')
    if scoped(old_plan):
        raise AssertionError('Original reader no longer reproduces unscoped history access')
    run(source,'sep8-reader-successor')
    after=value(metadata)
    prior=re.search(r'\$prior\$(.*?)\$prior\$',source,re.S).group(1)
    successor=re.search(r'\$successor\$(.*?)\$successor\$',source,re.S).group(1)
    if before['definition'].count(prior)!=1 or after != dict(before,definition=before['definition'].replace(prior,successor)):
        raise AssertionError('Reader successor changed more than the exact history query')
    new_plan=plan(after['definition'])
    (out/'sep8-reader-plan-after.json').write_text(json.dumps(new_plan,indent=2)+'\n')
    if not scoped(new_plan):
        raise AssertionError('Successor must use tournament/table-scoped indexed history access')
    run(semantic,'sep8-reader-after-coverage')
    run("""
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.hand_history h USING sep8_spin_fixture.reader_population p WHERE h.id=p.id;
DROP TABLE sep8_spin_fixture.reader_population;
SET LOCAL session_replication_role=origin;
COMMIT;
ANALYZE public.hand_history;
""",'sep8-reader-population-cleanup')
    if value("SELECT jsonb_object_agg(tournament_id,smarter_private.spin_original_current_case(tournament_id)) FROM sep8_spin_fixture.cases") != originals:
        raise AssertionError('Reader changed original complete five-case evidence')
    result={'status':'passed','before_unscoped_plan_rejected':True,'after_scoped_plan_accepted':True,
      'exact_five_original_json_equal':True,'semantic_before_after':True,'installer_config_acl_refusals':2,
      'unrelated_plan_rows':30000,'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),
      'full_definition_md5':hashlib.md5(after['definition'].encode()).hexdigest(),'owner_acl_config_preserved':True}
    (out/'sep8-reader-qualified-function.json').write_text(json.dumps(after,indent=2)+'\n')
    (out/'sep8-reader-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
