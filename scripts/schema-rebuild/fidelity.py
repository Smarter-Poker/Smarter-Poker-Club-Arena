"""Restore independently captured metadata only inside the owned empty cluster."""
import copy,json,re

def q(value):return '"'+value.replace('"','""')+'"'
def lit(value):return "'"+value.replace("'","''")+"'"
def restore_provider_metadata(sql,reference):
 # No supported ALTER EXTENSION OWNER exists in PG17. This exact guarded
 # catalog restoration is confined to verify.py's newly created Unix cluster.
 allowed={'pg_stat_statements','pgcrypto','uuid-ossp'}
 for extension in reference['extensions']:
  name=extension['name']
  state="SELECT jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion,'owner',pg_get_userbyid(e.extowner),'owner_dependencies',coalesce((SELECT jsonb_agg(pg_get_userbyid(d.refobjid) ORDER BY pg_get_userbyid(d.refobjid)) FROM pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.classid='pg_extension'::regclass AND d.objid=e.oid AND d.objsubid=0 AND d.refclassid='pg_authid'::regclass AND d.deptype='o'),'[]'::jsonb)) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname="+lit(name)+';'
  actual=json.loads(sql(state,phase='extension-owner-read',extension=name))
  if actual==extension:continue
  if name not in allowed or extension['owner']!='postgres' or extension['owner_dependencies']!=['postgres'] or actual!=dict(extension,owner='supabase_admin',owner_dependencies=[]):raise ValueError('Unrecognized provider extension ownership/dependency difference: '+name)
  guard="extname="+lit(name)+" AND extversion="+lit(extension['version'])+" AND extnamespace="+lit(extension['schema'])+"::regnamespace AND extowner='supabase_admin'::regrole"
  sql("BEGIN;DO $$ BEGIN IF (SELECT count(*) FROM pg_extension e WHERE "+guard+")<>1 OR EXISTS(SELECT FROM pg_shdepend d JOIN pg_extension e ON e.oid=d.objid WHERE e.extname="+lit(name)+" AND d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.classid='pg_extension'::regclass AND d.deptype='o') THEN RAISE EXCEPTION 'extension_owner_dependency_preimage_changed';END IF;END $$;UPDATE pg_catalog.pg_extension SET extowner='postgres'::regrole WHERE "+guard+";INSERT INTO pg_catalog.pg_shdepend(dbid,classid,objid,objsubid,refclassid,refobjid,deptype) SELECT (SELECT oid FROM pg_database WHERE datname=current_database()),'pg_extension'::regclass,oid,0,'pg_authid'::regclass,'postgres'::regrole,'o' FROM pg_extension WHERE extname="+lit(name)+";COMMIT;",phase='extension-owner-restore',extension=name)
  if json.loads(sql(state,phase='extension-owner-readback',extension=name))!=extension:raise ValueError('Local extension owner/dependency readback differs')
 # pg_dump omits these provider-initial schema ACLs via pg_init_privs. Keep
 # grantor/options exact; this is observed restore fidelity, not desired rights.
 for schema in reference['schemas']:
  if schema['name'] not in {'graphql','graphql_public'}:continue
  if any(a['grantor']!=schema['owner'] or a['privilege'] not in {'CREATE','USAGE'} for a in schema['acl']):raise ValueError('Unreviewed provider schema ACL shape')
  current=sql('SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='+lit(schema['name'])+';',phase='schema-owner-read',schema=schema['name'])
  if current!=schema['owner']:raise ValueError('Provider schema owner differs')
  grantees={a['grantee'] for a in schema['acl']}|{'PUBLIC'}
  statements=['SET ROLE '+q(schema['owner'])+';']
  for role in sorted(grantees):statements.append('REVOKE ALL ON SCHEMA '+q(schema['name'])+' FROM '+('PUBLIC' if role=='PUBLIC' else q(role))+';')
  for acl in schema['acl']:statements.append('GRANT '+acl['privilege']+' ON SCHEMA '+q(schema['name'])+' TO '+('PUBLIC' if acl['grantee']=='PUBLIC' else q(acl['grantee']))+(' WITH GRANT OPTION' if acl['grantable'] else '')+';')
  statements.append('RESET ROLE;');sql('\n'.join(statements),phase='schema-initial-acl-restore',schema=schema['name'])

def normalize_expressions(sql,reference,actual):
 # Independent captured definitions are parsed by real PostgreSQL in pg_temp,
 # never inferred from the restored expression. Each pair shares one session.
 expected=copy.deepcopy(reference);observed=copy.deepcopy(actual);changed=0
 actual_rel={(r['schema'],r['name']):r for r in observed['relations']}
 for relation in expected['relations']:
  key=(relation['schema'],relation['name']);other=actual_rel.get(key)
  if other is None:continue
  source=q(relation['schema'])+'.'+q(relation['name']);temp='pg_temp.'+q(relation['name'])
  for field in ['constraints','triggers']:
   targets={x['name']:x for x in other.get(field) or []}
   for value in relation.get(field) or []:
    counterpart=targets.get(value['name'])
    if counterpart is None or value['definition']==counterpart['definition']:continue
    if field=='constraints' and not value['definition'].startswith('CHECK '):continue
    statements=['CREATE TEMP TABLE '+q(relation['name'])+' (LIKE '+source+');']
    for definition in [value['definition'],counterpart['definition']]:
     if field=='constraints':
      statements+=['ALTER TABLE '+temp+' ADD CONSTRAINT '+q(value['name'])+' '+definition+';',
       'SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='+lit(temp)+'::regclass AND conname='+lit(value['name'])+';',
       'ALTER TABLE '+temp+' DROP CONSTRAINT '+q(value['name'])+';']
     else:
      anchors=[' ON '+source+' ',' ON '+relation['schema']+'.'+relation['name']+' ']
      if sum(definition.count(a) for a in anchors)!=1:raise ValueError('Trigger parser target anchor differs')
      rendered=definition
      for anchor in anchors:rendered=rendered.replace(anchor,' ON '+temp+' ')
      statements += [rendered+';',
       'SELECT to_jsonb(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgrelid='+lit(temp)+'::regclass AND tgname='+lit(value['name'])+';',
       'DROP TRIGGER '+q(value['name'])+' ON '+temp+';']
    statements.append('DROP TABLE '+temp+';')
    normalized=[json.loads(line) for line in sql('\n'.join(statements),phase='semantic-expression-parse',relation='.'.join(key),object=value['name']).splitlines()]
    if len(normalized)!=2:raise ValueError('Native expression parser did not return an exact pair')
    value['definition'],counterpart['definition']=normalized;changed+=1
  if relation['view'] is not None and relation['view']!=other['view']:
   statements=[]
   for definition in [relation['view'],other['view']]:
    statements += ['CREATE TEMP VIEW __schema_parser_view AS '+definition,
     "SELECT to_jsonb(pg_get_viewdef('pg_temp.__schema_parser_view'::regclass));",'DROP VIEW pg_temp.__schema_parser_view;']
   normalized=[json.loads(line) for line in sql('\n'.join(statements),phase='semantic-view-parse',relation='.'.join(key)).splitlines()]
   if len(normalized)!=2:raise ValueError('Native view parser did not return an exact pair')
   relation['view'],other['view']=normalized;changed+=1
 return expected,observed,changed

def restore_inherited_primary_keys(sql,reference,actual):
 # PG17's native dump creates standalone child PKs before attaching indexes;
 # this flips connoinherit. Supported detach/drop/attach recreates the genuine
 # inherited constraint. Every remaining index/constraint field is compared.
 observed={(r['schema'],r['name']):r for r in actual['relations']};changed=0
 for relation in reference['relations']:
  other=observed.get((relation['schema'],relation['name']))
  if not other or len(relation['parents'])!=1 or not relation['partition_bound']:continue
  targets={c['name']:c for c in other.get('constraints') or []}
  for constraint in relation.get('constraints') or []:
   current=targets.get(constraint['name'])
   if not constraint['definition'].startswith('PRIMARY KEY ') or constraint['no_inherit'] or not current or current==constraint:continue
   if current!=dict(constraint,no_inherit=True):raise ValueError('Unreviewed inherited PK difference')
   index=next(i for i in relation['indexes'] if i['name']==constraint['name'])
   if index['options'] or index['tablespace'] or index['clustered'] or index['replica_identity']:raise ValueError('Nondefault inherited PK metadata requires explicit restoration')
   child=q(relation['schema'])+'.'+q(relation['name']);parent=relation['parents'][0]
   if not re.fullmatch(r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*',parent):raise ValueError('Partition parent identifier requires review')
   sql('BEGIN;ALTER TABLE '+parent+' DETACH PARTITION '+child+';ALTER TABLE '+child+' DROP CONSTRAINT '+q(constraint['name'])+';ALTER TABLE '+parent+' ATTACH PARTITION '+child+' '+relation['partition_bound']+';COMMIT;',phase='inherited-primary-key-restore',relation=relation['schema']+'.'+relation['name'])
   changed+=1
 return changed

def restore_omitted_invalid_index(sql,reference,actual):
 # Native pg_dump deliberately omits invalid indexes. Preserve this one
 # captured planner-denied, write-maintained index only in the owned cluster.
 name='idx_chip_tx_bbj_promo_sweep_amount';table='chip_transactions'
 definition="CREATE INDEX idx_chip_tx_bbj_promo_sweep_amount ON public.chip_transactions USING btree (transaction_type) INCLUDE (amount) WHERE (transaction_type = 'bbj_promo_sweep'::text)"
 relation=next(r for r in reference['relations'] if r['schema']=='public' and r['name']==table)
 indexes=[i for i in relation['indexes'] if i['name']==name]
 if len(indexes)!=1:raise ValueError('Captured invalid index contract is absent or ambiguous')
 expected=dict(name=name,definition=definition,valid=False,ready=True,clustered=False,replica_identity=False,options=[],tablespace=None)
 if indexes[0]!=expected or relation['owner']!='postgres' or relation['kind']!='r':raise ValueError('Unreviewed invalid index source descriptor')
 target=next(r for r in actual['relations'] if r['schema']=='public' and r['name']==table)
 existing=[i for i in target['indexes'] or [] if i['name']==name]
 if existing:
  if existing!=[expected]:raise ValueError('Existing invalid index descriptor differs')
  return 0
 if target['owner']!='postgres' or target['kind']!='r':raise ValueError('Invalid index target table differs')
 if sql("SELECT to_regclass('public."+name+"') IS NULL;",phase='invalid-index-absence')!='t':raise ValueError('Invalid index name is already occupied')
 descriptor="jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'clustered',i.indisclustered,'replica_identity',i.indisreplident,'options',ARRAY(SELECT x FROM unnest(ic.reloptions) x ORDER BY x),'tablespace',CASE WHEN ic.reltablespace=0 THEN NULL ELSE (SELECT spcname FROM pg_tablespace WHERE oid=ic.reltablespace) END)"
 sql("BEGIN;SET LOCAL ROLE postgres;"+definition+";RESET ROLE;DO $index_restore$ DECLARE v_oid oid;v_rows int;v_descriptor jsonb;BEGIN v_oid:='public."+name+"'::regclass;SELECT "+descriptor+" INTO v_descriptor FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indexrelid=v_oid AND i.indrelid='public.chip_transactions'::regclass AND ic.relowner='postgres'::regrole;IF v_descriptor IS DISTINCT FROM "+lit(json.dumps(dict(expected,valid=True)))+"::jsonb OR EXISTS(SELECT FROM pg_constraint WHERE conindid=v_oid) THEN RAISE EXCEPTION 'invalid_index_restore_descriptor_changed';END IF;UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid=v_oid AND indrelid='public.chip_transactions'::regclass AND indisvalid AND indisready AND indislive AND NOT(indisunique OR indisprimary OR indisexclusion);GET DIAGNOSTICS v_rows=ROW_COUNT;IF v_rows<>1 THEN RAISE EXCEPTION 'invalid_index_restore_state_changed';END IF;END $index_restore$;COMMIT;",phase='invalid-index-exact-restore',index=name)
 return 1
