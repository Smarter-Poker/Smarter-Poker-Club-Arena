"""The offline fixture must not widen a captured privilege to PUBLIC."""
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('cashier_bootstrap',Path(__file__).with_name('bootstrap.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Privileges(unittest.TestCase):
 def test_owner_privileges_do_not_become_public(self):
  original=m.records
  def rows(name):
   data=original(name)
   if name=='tables':
    data=[dict(data[0],name='acl_probe',policies=[],constraints=[],indexes=[],rls=False,force_rls=False,acl='{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=rw/postgres,service_role=arwdDxt/postgres}')]
   if name=='triggers':data=[]
   return data
  m.records=rows
  try:
   sql=m.schema();self.assertIn('GRANT SELECT ON "public"."acl_probe" TO "anon";',sql)
   self.assertNotIn('ON "public"."acl_probe" TO PUBLIC;',sql)
  finally:m.records=original
if __name__=='__main__':unittest.main()
