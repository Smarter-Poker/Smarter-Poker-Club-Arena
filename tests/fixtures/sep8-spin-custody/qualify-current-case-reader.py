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
CREATE TABLE sep8_spin_fixture.reader_background_tables(id uuid PRIMARY KEY);
-- Keep the existing 30000-row history proof, but give unrelated histories real
-- unrelated closed-cash parents. A one-hot background over only five table IDs
-- makes the table join estimate thousands of target rows although each original
-- event has one hand. No original event/table or planner setting is changed.
WITH template AS (
 SELECT t.* FROM public.tables t
 WHERE t.tournament_id IS NOT NULL
 AND t.tournament_id<>'199a71a9-f364-4e90-a3ba-3cdcfb7755bc'
 ORDER BY t.id LIMIT 1
), rows AS (
 SELECT r.* FROM template t,generate_series(1,64) n,
 jsonb_populate_record(NULL::public.tables,to_jsonb(t)||jsonb_build_object(
  'id',md5('spin-reader-background-table:'||n)::uuid,
  'club_id',null,'union_id',null,'created_by',null,'cluster_id',null,'tournament_id',null,
  'game_type','cash','status','closed','lifecycle','closed','current_players',0,
  'seat_game_scope','table:'||md5('spin-reader-background-table:'||n)::uuid::text,
  'seat_admission_key','closed','terminal_closed_at',null)) r
), inserted AS (INSERT INTO public.tables(__reader_insertable_columns__) SELECT __reader_insertable_columns__ FROM rows RETURNING id)
INSERT INTO sep8_spin_fixture.reader_background_tables SELECT id FROM inserted;

WITH source AS (
 SELECT h.* FROM public.hand_history h
 WHERE h.tournament_id IS NOT NULL
 AND h.tournament_id<>'199a71a9-f364-4e90-a3ba-3cdcfb7755bc'
 AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id=h.table_id AND t.tournament_id='199a71a9-f364-4e90-a3ba-3cdcfb7755bc')
 ORDER BY h.id LIMIT 1
),
rows AS (
 SELECT r.* FROM source s,generate_series(1,30000) n,
 (SELECT array_agg(id ORDER BY id) ids FROM sep8_spin_fixture.reader_background_tables) b,
 jsonb_populate_record(NULL::public.hand_history,to_jsonb(s)||jsonb_build_object(
  'id',md5('spin-reader-scale:'||n)::uuid,'hand_number',200000000+n,
  'table_id',b.ids[1+((n-1)%64)],'tournament_id',null)) r
), inserted AS (INSERT INTO public.hand_history SELECT * FROM rows RETURNING id)
INSERT INTO sep8_spin_fixture.reader_population SELECT id FROM inserted;
SET LOCAL session_replication_role=origin;
SELECT sep8_spin_fixture.assert(
 (SELECT count(*) FROM sep8_spin_fixture.reader_population)=30000,
 'Reader scale population must contain exactly 30000 inserted rows');
SELECT sep8_spin_fixture.assert(
 (SELECT count(*) FROM sep8_spin_fixture.reader_population p JOIN public.hand_history h ON h.id=p.id
  JOIN sep8_spin_fixture.reader_background_tables b ON b.id=h.table_id
  WHERE h.tournament_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.tables t JOIN sep8_spin_fixture.cases c ON c.tournament_id=t.tournament_id WHERE t.id=h.table_id))=30000,
 'Reader scale population must be disjoint from every original tournament and table history scope');
SELECT sep8_spin_fixture.assert(
 (SELECT count(DISTINCT h.table_id) FROM sep8_spin_fixture.reader_population p JOIN public.hand_history h ON h.id=p.id)=64
 AND (SELECT count(*) FROM sep8_spin_fixture.reader_background_tables)=64,
 'Reader unrelated history has exactly64 real table parents rather than one hot table');
SELECT sep8_spin_fixture.assert(
 (SELECT count(*) FROM sep8_spin_fixture.reader_background_tables b JOIN public.tables t ON t.id=b.id
 WHERE t.club_id IS NULL AND t.union_id IS NULL AND t.created_by IS NULL AND t.cluster_id IS NULL AND t.tournament_id IS NULL
 AND t.status='closed' AND t.lifecycle='closed' AND t.current_players=0
 AND t.seat_game_scope='table:'||t.id::text AND t.seat_admission_key='closed')=64,
 'Reader background parents preserve closed-table checks and all actual nullable foreign-key edges');
COMMIT;
ANALYZE public.hand_history;
ANALYZE public.tables;
"""
    insertable_columns = query("SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.tables'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''")
    setup = setup.replace('__reader_insertable_columns__',insertable_columns)
    actual_target_rows = int(query("SELECT count(*) FROM public.hand_history h WHERE (h.tournament_id='"+event+"' OR h.table_id IN(SELECT id FROM public.tables WHERE tournament_id='"+event+"')) AND h.hand_number >=(SELECT max(hand_number) FROM public.tournament_knockout_candidates WHERE tournament_id='"+event+"')"))
    run(setup,'sep8-reader-plan-population')
    (out/'sep8-reader-population-authority.json').write_text(json.dumps({'actual_target_rows':actual_target_rows,'background_history_rows':30000,'background_real_table_parents':64,'all_original_events':5},indent=2)+'\n')
    if value("SELECT jsonb_object_agg(tournament_id,smarter_private.spin_original_current_case(tournament_id)) FROM sep8_spin_fixture.cases") != originals:
        raise AssertionError('Planner population changed an original five-case document while active')

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
DELETE FROM public.tables t USING sep8_spin_fixture.reader_background_tables b WHERE t.id=b.id;
DROP TABLE sep8_spin_fixture.reader_background_tables;
SET LOCAL session_replication_role=origin;
COMMIT;
ANALYZE public.hand_history;
""",'sep8-reader-population-cleanup')
    if value("SELECT jsonb_object_agg(tournament_id,smarter_private.spin_original_current_case(tournament_id)) FROM sep8_spin_fixture.cases") != originals:
        raise AssertionError('Reader changed original complete five-case evidence')
    result={'status':'passed','before_unscoped_plan_rejected':True,'after_scoped_plan_accepted':True,
      'exact_five_original_json_equal':True,'semantic_before_after':True,'installer_config_acl_refusals':2,
      'unrelated_plan_rows':30000,'unrelated_real_tables':64,'actual_target_history_rows':actual_target_rows,'all_five_documents_equal_during_population':True,'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),
      'full_definition_md5':hashlib.md5(after['definition'].encode()).hexdigest(),'owner_acl_config_preserved':True}
    (out/'sep8-reader-qualified-function.json').write_text(json.dumps(after,indent=2)+'\n')
    (out/'sep8-reader-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
