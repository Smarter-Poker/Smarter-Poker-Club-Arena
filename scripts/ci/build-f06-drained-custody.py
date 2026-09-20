"""Bind the new read/assert owner to the existing installed custody dependencies."""
from pathlib import Path
import hashlib, re, sys
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
ROOT=Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20260918161307_drained_tournament_owners_preserve_premanifest_park_custody.sql'
AUTHORITY='scripts/ci/probes/f06-drained-custody-authority.sql'
PREPARED='supabase/migrations/20260918071546_f06_original_preparation_cancellations_survive_maintenance_r.sql'
def preflight(root):
 m=module(root/'scripts/ci/test-f06-movement-admission.py','drained_movement')
 block=m.dependency_preflight(root)
 guards=[]
 source=(root/m.MIGRATION).read_text()
 for name,args,definition in [('f06_movement_prior','uuid,uuid','438d2cbaad05751066393aeadf710228'),('f06_movement_permits','uuid,uuid,bigint','2ddcf96913de8e87b858c1c207f57ed0')]:
  body=re.search(r'CREATE FUNCTION smarter_private\.'+name+r'\(.*?AS \$\$(.*?)\$\$;',source,re.S)[1]
  guards.append("IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private."+name+'('+args+")'::regprocedure AND md5(prosrc)='"+hashlib.md5(body.encode()).hexdigest()+"' AND md5(pg_get_functiondef(oid))='"+definition+"' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_DRAINED_DEPENDENCY_DRIFT: "+name+"'; END IF;")
 guards.append("IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_prepared_hand_cancellations'::regclass AND tgname='f06_prepared_cancellation_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_prepared_cancellation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_prepared_hand_cancellations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_prepared_cancellation_immutable()') THEN RAISE EXCEPTION 'F06_DRAINED_PREPARATION_BINDING'; END IF;")
 body=re.search(r'CREATE FUNCTION smarter_private.f06_prepared_cancellation_immutable\(.*?AS \$\$(.*?)\$\$;', (root/PREPARED).read_text(),re.S)[1]
 guards.append("IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_prepared_cancellation_immutable()'::regprocedure AND md5(prosrc)='"+hashlib.md5(body.encode()).hexdigest()+"' AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'F06_DRAINED_PREPARATION_GUARD'; END IF;")
 guards.append("IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='smarter_private.f06_prepared_hand_cancellations'::regclass AND relrowsecurity AND NOT relforcerowsecurity AND pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres}') OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='smarter_private.f06_prepared_hand_cancellations'::regclass) OR (SELECT array_agg(attname::text||':'||format_type(atttypid,atttypmod)||':'||attnotnull::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='smarter_private.f06_prepared_hand_cancellations'::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['permit_id:uuid:true','tournament_id:uuid:true','generation:uuid:true','table_id:uuid:true','lifecycle:bigint:true','hand_number:bigint:true','custody_id:uuid:true','created_at:timestamp with time zone:true'] OR (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY contype) FROM pg_constraint WHERE conrelid='smarter_private.f06_prepared_hand_cancellations'::regclass) IS DISTINCT FROM ARRAY['PRIMARY KEY (permit_id)','UNIQUE (table_id, hand_number)'] THEN RAISE EXCEPTION 'F06_DRAINED_PREPARATION_RELATION'; END IF;")
 return block+'\nDO $drained_dependencies$ BEGIN\n'+'\n'.join(guards)+'\nEND $drained_dependencies$;'
def render(root=ROOT):
 return '-- Read/assert only. No lease, park, hand, financial or roster mutations.\nBEGIN;\nSET LOCAL lock_timeout=\'1s\';\nSET LOCAL statement_timeout=\'8s\';\n'+preflight(root)+'\n'+(root/AUTHORITY).read_text().strip()+'\nCOMMIT;\n'
if __name__=='__main__':(ROOT/MIGRATION).write_text(render())
