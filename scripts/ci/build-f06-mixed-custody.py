"""Bind mixed custody transfer to the same installed canonical F06 dependencies."""
from pathlib import Path
import sys, re, hashlib
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
ROOT=Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20260918232558_mixed_f06_custody_transfer_retains_original_operations.sql'
AUTHORITY='scripts/ci/probes/f06-mixed-custody-authority.sql'
MOVEMENT_AUTHORITY='scripts/ci/probes/f06-mixed-movement-authority.sql'
MOVEMENT='supabase/migrations/20260918095135_parked_tournament_movement_requires_canonical_custody.sql'
def movement(root):
 original=re.search(r'CREATE FUNCTION smarter_private.f06_assert_movement\(.*?END \$\$;', (root/MOVEMENT).read_text(), re.S)[0]
 body=original.split('AS $$',1)[1].rsplit('$$;',1)[0]
 pin="DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure AND md5(prosrc)='"+hashlib.md5(body.encode()).hexdigest()+"' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_GUARD_DRIFT'; END IF; END $$;\n"
 result=original
 for before,after in [
  ('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'),
  ('remaining integer:=0;', 'remaining integer:=0; mixed_generation uuid;'),
  ('BEGIN\n IF NOT EXISTS', 'BEGIN\n mixed_generation:=smarter_private.f06_mixed_movement_generation(p_break);\n IF NOT EXISTS'),
  ('OR g IS DISTINCT FROM a.lease_generation', 'OR (g IS DISTINCT FROM a.lease_generation AND g IS DISTINCT FROM mixed_generation)'),
  ('f06_authority(a.tournament_id,a.lease_generation,false)', 'f06_authority(a.tournament_id,COALESCE(mixed_generation,a.lease_generation),false)')]:
  if result.count(before)!=1:raise ValueError('mixed movement composition anchor drift: '+before)
  result=result.replace(before,after,1)
 return pin+(root/MOVEMENT_AUTHORITY).read_text()+ '\n'+result+'\n'

def render(root=ROOT):
 b=module(root/'scripts/ci/build-f06-drained-custody.py','mixed_custody_dependencies')
 return '-- Original custody transfer and finite receipt-bound canonical recovery. Preparation appends custody only.\nBEGIN;\nSET LOCAL lock_timeout=\'1s\';\nSET LOCAL statement_timeout=\'8s\';\n'+b.preflight(root)+'\n'+(root/AUTHORITY).read_text().strip()+'\n'+movement(root)+'COMMIT;\n'
if __name__=='__main__':(ROOT/MIGRATION).write_text(render())
