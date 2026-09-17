"""Pure supplemental queries. Every missing scalar is encoded as JSON null."""
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent

def literal(v):return "'"+str(v).replace("'","''")+"'"
def relation_name(oid):
 return "(SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid="+oid+")"
def endpoint_names():
 m=json.loads((HERE/'EXPECTED.json').read_text());return [x['relation'] for x in m['tables']]+['public.bbj_pools']
def endpoint_oids():return ','.join('to_regclass('+literal(x)+')' for x in endpoint_names())

def envelope_query(name):
 return """SELECT COALESCE((SELECT jsonb_build_object(
 'persistence',c.relpersistence,'replident',c.relreplident,'access_method',(SELECT amname FROM pg_am WHERE oid=c.relam),
 'partition',c.relispartition,'typed',c.reloftype::text,'tablespace',c.reltablespace::text,
 'rules',COALESCE((SELECT jsonb_agg(r.rulename ORDER BY r.rulename) FROM pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
 'parents',COALESCE((SELECT jsonb_agg(i.inhparent::regclass::text ORDER BY i.inhseqno) FROM pg_inherits i WHERE i.inhrelid=c.oid),'[]'::jsonb),
 'attributes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'position',a.attnum,'dropped',a.attisdropped,
 'hasdefault',a.atthasdef,'dimensions',a.attndims,'statistics',a.attstattarget,'local',a.attislocal,'inheritance_count',a.attinhcount,
 'collation_is_type_default',a.attcollation=t.typcollation,'storage_is_type_default',a.attstorage=t.typstorage,
 'compression',a.attcompression,'options',a.attoptions,'fdwoptions',a.attfdwoptions,'hasmissing',a.atthasmissing,'missingvalue',a.attmissingval::text) ORDER BY a.attnum)
 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=c.oid AND a.attnum>0),'[]'::jsonb),
 'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'unique',i.indisunique,'primary',i.indisprimary,
 'exclusion',i.indisexclusion,'immediate',i.indimmediate,'clustered',i.indisclustered,'valid',i.indisvalid,'checkxmin',i.indcheckxmin,
 'ready',i.indisready,'live',i.indislive,'replident',i.indisreplident,'nulls_not_distinct',i.indnullsnotdistinct) ORDER BY i.indexrelid::regclass::text)
 FROM pg_index i WHERE i.indrelid=c.oid),'[]'::jsonb)) FROM pg_class c WHERE c.oid=to_regclass("""+literal(name)+")),'null'::jsonb)"

def sequence_query(name):
 return """SELECT COALESCE((SELECT jsonb_build_object('model',jsonb_build_object(
 'name',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'relkind',c.relkind,
 'persistence',c.relpersistence,'replident',c.relreplident,'reloptions',c.reloptions,'type',s.seqtypid::regtype::text,
 'start',s.seqstart::text,'minimum',s.seqmin::text,'maximum',s.seqmax::text,'increment',s.seqincrement::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
 'owned_by',COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',rn.nspname||'.'||r.relname,'column',a.attname,'deptype',d.deptype) ORDER BY rn.nspname,r.relname,a.attname,d.deptype)
 FROM pg_depend d JOIN pg_class r ON r.oid=d.refobjid JOIN pg_namespace rn ON rn.oid=r.relnamespace
 JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=d.refobjsubid
 WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.objsubid=0 AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')),'[]'::jsonb)),
 'raw_pg_class',to_jsonb(c),'raw_pg_sequence',to_jsonb(s)-'seqstart'-'seqmin'-'seqmax'-'seqincrement'-'seqcache'||jsonb_build_object('seqstart',s.seqstart::text,'seqmin',s.seqmin::text,'seqmax',s.seqmax::text,'seqincrement',s.seqincrement::text,'seqcache',s.seqcache::text),
 'dependencies',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.refclassid,d.refobjid,d.refobjsubid,d.deptype) FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid),'[]'::jsonb))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.oid=to_regclass("""+literal(name)+")),'null'::jsonb)"

def foreign_key_query():
 child=relation_name('k.conrelid');parent=relation_name('k.confrelid')
 op="ARRAY(SELECT n.nspname||'.'||o.oprname||'('||format_type(o.oprleft,NULL)||','||format_type(o.oprright,NULL)||')' FROM unnest(k.conpfeqop) WITH ORDINALITY z(oid,ord) JOIN pg_operator o ON o.oid=z.oid JOIN pg_namespace n ON n.oid=o.oprnamespace ORDER BY z.ord)"
 return "SELECT COALESCE(jsonb_agg(jsonb_build_object('model',jsonb_build_object('name',k.conname,'child',"+child+",'parent',"+parent+",'columns',ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY z(num,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=z.num ORDER BY z.ord),'references',ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY z(num,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=z.num ORDER BY z.ord),'match',k.confmatchtype,'update',k.confupdtype,'delete',k.confdeltype,'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,'local',k.conislocal,'inheritance_count',k.coninhcount,'noinherit',k.connoinherit,'parent_constraint',k.conparentid::text,'equality_operators',"+op+"),'all_equality_arrays_equal',k.conpfeqop=k.conppeqop AND k.conpfeqop=k.conffeqop,'raw',to_jsonb(k)) ORDER BY k.conname),'[]'::jsonb) FROM pg_constraint k WHERE k.contype='f' AND (k.conrelid IN ("+endpoint_oids()+") OR k.confrelid IN ("+endpoint_oids()+"))"

def ri_query():
 return "SELECT COALESCE(jsonb_agg(jsonb_build_object('model',jsonb_build_object('constraint',k.conname,'child',"+relation_name('k.conrelid')+",'parent',"+relation_name('k.confrelid')+",'relation',"+relation_name('t.tgrelid')+",'other_relation',"+relation_name('t.tgconstrrelid')+",'function_schema',n.nspname,'function_name',p.proname,'type',t.tgtype,'enabled',t.tgenabled,'internal',t.tgisinternal,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'args',encode(t.tgargs,'hex'),'columns',t.tgattr::smallint[],'nargs',t.tgnargs,'qual',t.tgqual::text,'parent_trigger',t.tgparentid::text,'old_table',t.tgoldtable,'new_table',t.tgnewtable,'index_matches_constraint',t.tgconstrindid=k.conindid),'raw',to_jsonb(t)) ORDER BY t.oid),'[]'::jsonb) FROM pg_trigger t LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint LEFT JOIN pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgisinternal AND (t.tgrelid IN ("+endpoint_oids()+") OR t.tgconstrrelid IN ("+endpoint_oids()+"))"

def overload_query(names):
 return "SELECT COALESCE(jsonb_agg(n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' ORDER BY n.nspname,p.proname,oidvectortypes(p.proargtypes)),'[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+','.join(literal(x) for x in names)+")"

BOUNDARY_QUERY="""SELECT jsonb_build_object('database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),'role',current_user,'session_role',session_user,'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'socket_only',inet_server_addr() IS NULL,'server_version',current_setting('server_version'),'replication_role',current_setting('session_replication_role'),'data_directory',current_setting('data_directory'),'socket_directory',current_setting('unix_socket_directories'),'allow_privileged_anon_grant',current_setting('app.allow_privileged_anon_grant',true),'users',(SELECT count(*) FROM auth.users),'clubs',(SELECT count(*) FROM public.clubs),'legs',(SELECT count(*) FROM public.chip_ledger),'snapshots',(SELECT count(*) FROM public.ca_account_snapshots))"""
