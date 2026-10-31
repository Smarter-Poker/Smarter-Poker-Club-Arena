#!/usr/bin/env python3
"""One physical time index; exact original linked/reducer/witness parity on PG17."""
import argparse,hashlib,json,os,re,subprocess,tempfile,socket
from pathlib import Path
R=Path(__file__).resolve().parents[2]
F=R/'scripts/ci/fixtures/linked-outcome-window-index'
G=R/'scripts/ci/fixtures/native-weekly-hand-parts'
M=R/'supabase/migrations/20261027220709_original_linked_outcomes_follow_the_recognition_window.sql'
p=argparse.ArgumentParser();p.add_argument('--scratch',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
a.scratch.mkdir(parents=True,exist_ok=True);cases=[];index='union_pnl_cash_outcomes_recognition_window'
def lit(s):return "'"+s.replace("'","''")+"'"
with tempfile.TemporaryDirectory(prefix='lw-',dir=a.scratch)as tmp:
 t=Path(tmp);data=t/'d';pg=a.pg_bin
 with socket.socket()as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
 env={**os.environ,'PGHOST':'127.0.0.1','PGPORT':port,'PGUSER':'postgres','PGDATABASE':'postgres','PGSSLMODE':'disable','TMPDIR':str(t)}
 def run(cmd,s=None,error=None):
  r=subprocess.run(list(map(str,cmd)),input=s,text=True,capture_output=True,env=env,timeout=120)
  if error:assert r.returncode and error in r.stderr,(error,r.stdout,r.stderr)
  else:assert r.returncode==0,(r.stdout,r.stderr)
  return r.stdout.strip()
 def q(s,error=None):return run([pg/'psql','-XAtq','-v','ON_ERROR_STOP=1'],s,error)
 assert ' 17.'in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--no-locale','-E','UTF8'])
 with(data/'postgresql.conf').open('a')as f:f.write("\nlisten_addresses='127.0.0.1'\ntimezone='UTC'\nunix_socket_directories=''\nport="+port+"\n")
 run([pg/'pg_ctl','-D',data,'-l',t/'log','-w','start'])
 try:
  setup=(G/'setup.sql').read_text()
  for rel in ['union_pnl_cash_outcomes','union_pnl_cash_outcome_link_resolutions']:
   setup=re.sub(r'CREATE TABLE public\.'+rel+r'\(.*?;\n','',setup,count=1)
  setup=setup.replace('CREATE SCHEMA smarter_private;','CREATE SCHEMA smarter_private;'+(F/'actual-relations.sql').read_text())
  q(setup)
  connected=json.loads((G/'actual-preimages.json').read_text())
  for f in connected['connected']['functions']:q(f['definition']+';')
  q((F/'original-linked.sql').read_text()+';')
  q('SET check_function_bodies=off;'+(F/'original-treasury-cash-outcome.sql').read_text())
  q((F/'original-week-hand-lines.sql').read_text()+';')
  seen=set()
  for row in connected['immutable']:
   if row['fn']not in seen:q(row['fn_definition']+';');seen.add(row['fn'])
   q(row['definition']+';')
  q('CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON union_pnl_cash_outcomes FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();')
  for original in re.findall(r'CREATE OR REPLACE FUNCTION .*?AS \$function\$.*?\$function\$',(F/'original-hand-parts.sql').read_text(),re.S):q('SET check_function_bodies=off;'+original+';')
  catalog=json.loads((F/'actual-catalog.json').read_text())
  for f in catalog['owners']:
   q('REVOKE ALL ON FUNCTION '+f['signature']+' FROM PUBLIC,anon,authenticated,service_role;')
   assert q('SELECT md5(pg_get_functiondef('+lit(f['signature'])+'::regprocedure));')==f['md5'],f
  q("CREATE TABLE install_control(frozen boolean);INSERT INTO install_control VALUES(false);CREATE FUNCTION fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT frozen FROM install_control$$;")
  # Full original companion hand readers/append guards execute. Source65's
  # unrelated financial dependencies are controlled ONLY in this native fixture.
  # The complete actual source65 body is separately loaded and preserved below.
  q("INSERT INTO union_pnl_projection_build(projection,completed_at)VALUES('cash_outcome_touches',now());")
  u='fade0000-0000-0000-0000-000000000001';start='2026-10-19 07:00Z';end='2026-10-19 09:00Z'
  for ix in json.loads((F/'actual-indexes.json').read_text()):
   existing=q("SELECT coalesce(pg_get_indexdef(to_regclass("+lit(ix['schemaname']+'.'+ix['indexname'])+")),'');")
   if existing:
    normalize=lambda text:re.sub(r'\s+','',text.lower().replace('public.',''))
    assert normalize(existing)==normalize(ix['indexdef']),(existing,ix)
   else:q(ix['indexdef'])
  # Original outcomes deliberately carry another scope. The resolution owns the
  # linked union: adding an outcome-union predicate would lose valid rows.
  q("""INSERT INTO union_pnl_cash_outcomes(table_id,hand_number,hand_id,transaction_id,recognized_at,payload_hash,game_scope,evidence)
 SELECT md5('table')::uuid,n,md5('hand-'||n)::uuid,'1'::xid8,
 CASE n WHEN 1 THEN '2026-10-19 07:00Z'::timestamptz WHEN 2 THEN '2026-10-19 09:00Z'::timestamptz WHEN 3 THEN '2026-10-19 08:00Z'::timestamptz ELSE '2026-09-01'::timestamptz+(n%10000)*interval '1 second'END,
 md5('payload-'||n),jsonb_build_object('game_union_id','another-original-scope'),
 jsonb_build_object('accepted_rake','1.25','participants',jsonb_build_array(jsonb_build_object('earning_club_id',md5('club')::uuid,'user_id',md5('player')::uuid,'observed_stack_delta','-1.25')),'native_padding',repeat(md5('payload-'||n),24))
 FROM generate_series(1,80000)n;""")
  # Full actual resolution CHECK constraints remain enabled.
  q("""WITH payload AS(SELECT o.*,jsonb_build_object('game_union_id','"""+u+"""','host_club_id',md5('host')::uuid,'tournament_id',NULL,'is_private',false,'asset','chips','unit_scale',100)gs FROM union_pnl_cash_outcomes o),
 shaped AS(SELECT p.*,jsonb_build_object('provenance_link','resolved','game_scope',gs,'accepted_rake',evidence->'accepted_rake','participants',evidence->'participants')e FROM payload p),
 proof AS(SELECT s.*,jsonb_build_object('status','proven','resolution_kind','cash_outcome_provenance_link','table_id',table_id,'hand_number',hand_number,'hand_id',hand_id,'outcome_payload_hash',payload_hash,'outcome_evidence_md5',md5(evidence::text),'roster_source','seat_inventory','manifest_id',NULL,'game_scope',gs,'evidence',e)pr FROM shaped s)
 INSERT INTO union_pnl_cash_outcome_link_resolutions(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,roster_source,manifest_id,game_scope,evidence,proof,proof_md5,reason)
 SELECT table_id,hand_number,hand_id,payload_hash,md5(evidence::text),'seat_inventory',NULL,gs,e,pr,md5(pr::text),'Native exact immutable link fixture'FROM proof;""")
  q('VACUUM ANALYZE union_pnl_cash_outcomes;VACUUM ANALYZE union_pnl_cash_outcome_link_resolutions;')
  sig='public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'
  call="SELECT *FROM "+sig.split('(')[0]+"('"+u+"','"+start+"','"+end+"')"
  body=(F/'original-linked.sql').read_text().split('AS $function$\n',1)[1].rsplit('$function$',1)[0]
  for k,v in [('p_union_id',lit(u)+'::uuid'),('p_start',lit(start)+'::timestamptz'),('p_end',lit(end)+'::timestamptz')]:body=re.sub(r'\b'+k+r'\b',v,body)
  bag="SELECT jsonb_agg(to_jsonb(r)ORDER BY table_id,hand_number)FROM("+call+")r"
  reducer="SELECT smarter_private.weekly_hand_parts_reduce('"+u+"','"+start+"','"+end+"',true)"
  witness="SELECT smarter_private.weekly_hand_parts_witness('"+u+"','"+start+"','"+end+"',true)"
  pinned=re.findall(r"\('([^']+)','([0-9a-f]{32})'\)",(F/'original-hand-parts.sql').read_text().split('CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_reduce',1)[0])
  for signature,expected in pinned:
   actual=q('SELECT md5(pg_get_functiondef(to_regprocedure('+lit(signature)+')));')
   assert actual==expected,('original witness dependency',signature,actual,expected)
  before=[q(bag),q(reducer),q(witness)];assert len(json.loads(before[0]))==2
  materialized=json.loads(q((F/'materialized-baseline-readonly.sql').read_text()))
  exact_bag=q("SELECT md5(coalesce(string_agg(md5(to_jsonb(r)::text),''ORDER BY table_id,hand_number),''))FROM("+call+")r")
  assert materialized['original_rows']==2 and materialized['full_original_row_bag_md5']==exact_bag
  cases.append('pure_materialization_original_full_row_hash_predicate_parity')
  meta="SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN("+','.join(lit(f['signature'])+'::regprocedure'for f in catalog['owners'])+")"
  metadata=q(meta);old=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+body))
  migration=M.read_text();preamble,installer=migration.split('BEGIN;',1);installer='BEGIN;'+installer
  q(migration);new=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+body))
  def nodes(n):
   yield n
   for c in n.get('Plans',[]):yield from nodes(c)
  access=[n for n in nodes(new[0]['Plan'])if n.get('Index Name')==index]
  assert access,('natural recognition-window index absent',new)
  assert [q(bag),q(reducer),q(witness)]==before
  assert q(meta)==metadata;cases.append('full_original_linked_row_bag_reducer_witness_metadata_unchanged')
  cases.append('natural_window_index_without_planner_forcing_or_outcome_union_filter')
  # Every original condition remains in exact function bytes; actual CHECKs
  # independently refuse corrupt immutable proof and malformed resolution rows.
  q("INSERT INTO union_pnl_cash_outcome_link_resolutions SELECT table_id,999999,hand_id,outcome_payload_hash,outcome_evidence_md5,roster_source,manifest_id,game_scope,evidence,proof,'00000000000000000000000000000000',reason,resolved_by,resolved_at FROM union_pnl_cash_outcome_link_resolutions LIMIT 1;",'violates check constraint')
  cases.append('actual_resolution_full_proof_check_refuses_corruption')
  for mode in ['force_custom_plan','force_generic_plan']:
   assert q('SET plan_cache_mode='+mode+';'+bag)==before[0]
  cases.append('generic_custom_full_row_parity')
  q('UPDATE install_control SET frozen=true');q(installer,'linked_outcome_window_index_install_frozen');q('UPDATE install_control SET frozen=false');cases.append('installer_frozen_refusal')
  q(installer.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_index_rollback';END$$;COMMIT;"),'forced_index_rollback');cases.append('installer_atomic_rollback')
  q(migration);q(migration);cases.append('exact_installer_idempotent_replay')
  q('GRANT EXECUTE ON FUNCTION '+sig+' TO anon;');q(installer,'linked_outcome_window_index_original_authority_changed');q('REVOKE EXECUTE ON FUNCTION '+sig+' FROM anon;');cases.append('installer_original_acl_fault_refused')
  for label,ddl in [('wrong_column','ON union_pnl_cash_outcomes(hand_number)'),('descending','ON union_pnl_cash_outcomes(recognized_at DESC)'),('partial','ON union_pnl_cash_outcomes(recognized_at)WHERE hand_number>0'),('included_payload','ON union_pnl_cash_outcomes(recognized_at)INCLUDE(hand_id)'),('expression','ON union_pnl_cash_outcomes((recognized_at AT TIME ZONE \'UTC\'))'),('wrong_table','ON union_pnl_cash_outcome_touches(recognized_at)')]:
   q('DROP INDEX '+index+';CREATE INDEX '+index+' '+ddl);q(installer,'linked_outcome_window_index_');cases.append('catalog_'+label+'_refused')
  q('DROP INDEX '+index)
  q('CREATE UNIQUE INDEX CONCURRENTLY '+index+' ON union_pnl_cash_outcomes(recognized_at)','could not create unique index')
  q(installer,'linked_outcome_window_index_shape_changed');cases.append('actual_invalid_concurrent_index_refused')
  q('DROP INDEX '+index);q(migration)
  assert [q(bag),q(reducer),q(witness)]==before
  # Load the complete production source65, not a shortened replacement, and
  # prove index-only replay does not edit it or the original four functions.
  q('SET check_function_bodies=off;'+(F/'original-source65.sql').read_text()+';')
  q('REVOKE ALL ON FUNCTION smarter_private.original_inventory_proof_sources_match()FROM PUBLIC,anon,authenticated,service_role;')
  guard=q("SELECT pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)")
  guardmeta=q("SELECT to_jsonb(p)FROM pg_proc p WHERE oid='smarter_private.original_inventory_proof_sources_match()'::regprocedure")
  q(migration)
  assert q("SELECT pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)")==guard
  assert q("SELECT to_jsonb(p)FROM pg_proc p WHERE oid='smarter_private.original_inventory_proof_sources_match()'::regprocedure")==guardmeta
  assert q(meta)==metadata;cases.append('complete_actual_source65_and_original_four_bodies_metadata_unchanged')
  out={'status':'passed','cases':cases,'case_count':len(cases),'migration_sha256':hashlib.sha256(migration.encode()).hexdigest(),'natural_index_nodes':access,'old_plan':old,'new_plan':new,'full_row_bag_md5':hashlib.md5(before[0].encode()).hexdigest(),'reducer':json.loads(before[1]),'witness':json.loads(before[2]),'fixture_rows':80000,'source65_definition_md5':hashlib.md5((guard+'\n').encode()).hexdigest(),'limits':'Actual original linked/reducer/witness/read bodies and full captured relation columns/constraints. Original hand-line/append owners reused unchanged. Unrelated source65 proof collaborators controlled only for functional native calls, then COMPLETE actual source65 loaded and preserved across exact installer replay. No production speed, whole84-window readiness, financial or deployment claim.'}
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'status':'passed','case_count':len(cases),'output':str(a.output)}))
 finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
