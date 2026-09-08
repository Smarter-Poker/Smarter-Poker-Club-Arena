#!/usr/bin/env python3
"""Focused adversarial tests for the migration function-history scanner."""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


SOURCE=Path(__file__).with_name("test_atomicity.py")
PREFIX=SOURCE.read_text().split("\npg=os.environ",1)[0]
PARSER={"__name__":"chip_journal_atomicity_parser"}
exec(compile(PREFIX,str(SOURCE),"exec"),PARSER)
authoritative_function_closure=PARSER["authoritative_function_closure"]


def function(name,arguments="",body="BEGIN RETURN; END",returns="void"):
 return f"""
CREATE OR REPLACE FUNCTION public.{name}({arguments}) RETURNS {returns}
LANGUAGE plpgsql AS $body$
{body};
$body$;
"""


class FunctionHistoryScannerTest(unittest.TestCase):
 def closure(self,migrations,roots,fixture=""):
  with TemporaryDirectory() as temporary:
   root=Path(temporary)
   directory=root/"supabase"/"migrations"
   directory.mkdir(parents=True)
   for index,sql in enumerate(migrations,1):
    (directory/f"{index:03d}.sql").write_text(sql)
   return authoritative_function_closure(root,fixture,set(roots))

 def test_comments_and_quoted_text_cannot_declare_functions_or_fixture_stubs(self):
  migration="""
-- CREATE FUNCTION public.ghost() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;
/* CREATE FUNCTION public.ghost() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql; */
SELECT 'CREATE FUNCTION public.ghost() RETURNS void';
DO $outer$
BEGIN
  PERFORM $inner$CREATE FUNCTION public.ghost() RETURNS void$inner$;
END;
$outer$;
"""
  migration+=function(
   "carrier",
   body="BEGIN PERFORM $sql$CREATE FUNCTION public.ghost() RETURNS void$sql$; END",
  )
  with self.assertRaisesRegex(RuntimeError,"Unresolved.*public.ghost"):
   self.closure([migration],{"ghost"})

  root=function("root",body="BEGIN PERFORM public.fixture_only(); END")
  fake_fixture="-- CREATE FUNCTION fixture_only() RETURNS void AS $$ BEGIN END $$;"
  with self.assertRaisesRegex(RuntimeError,"public.fixture_only"):
   self.closure([root],{"root"},fake_fixture)

 def test_dynamic_sql_and_nested_dollar_text_are_not_dependencies(self):
  helper=function("real_helper")
  root=function(
   "root",
   body="""
BEGIN
  -- PERFORM public.comment_fake();
  PERFORM 'SELECT public.string_fake()';
  PERFORM $dynamic$SELECT public.dollar_fake()$dynamic$;
  PERFORM public.real_helper();
END""",
  )
  closure=self.closure([helper+root],{"root"})
  self.assertEqual([name for name,_ in closure],["real_helper","root"])

 def test_drop_removes_only_the_named_overload_and_never_revives_it(self):
  old_integer=function("target","p_value integer",body="BEGIN /* OLD INTEGER */ RETURN; END")
  text_overload=function("target","p_value text",body="BEGIN /* TEXT OVERLOAD */ RETURN; END")
  drop_text="DROP FUNCTION IF EXISTS public.target(text);"
  replacement_integer=function("target","p_value integer",body="BEGIN /* NEW INTEGER */ RETURN; END")
  root=function("root",body="BEGIN PERFORM public.target(1); END")
  closure=self.closure(
   [old_integer,text_overload,drop_text,
    "DROP FUNCTION IF EXISTS public.target(integer);",replacement_integer,root],
   {"root"},
  )
  declaration=dict(closure)["target"]
  self.assertIn("NEW INTEGER",declaration)
  self.assertNotIn("OLD INTEGER",declaration)
  self.assertNotIn("TEXT OVERLOAD",declaration)

 def test_live_overloads_fail_closed_instead_of_selecting_a_wrong_body(self):
  migrations=[
   function("target","p_value integer"),
   function("target","p_value text"),
  ]
  with self.assertRaisesRegex(RuntimeError,"Ambiguous.*live overloads"):
   self.closure(migrations,{"target"})

 def test_static_do_rename_preserves_body_but_dynamic_renames_are_ignored(self):
  helper=function("real_helper")
  original=function(
   "door","p_id uuid",body="BEGIN PERFORM public.real_helper(); END"
  )
  rename="""
DO $rename$
BEGIN
  PERFORM 'ALTER FUNCTION public.door(uuid) RENAME TO wrong_name';
  PERFORM $dynamic$ALTER FUNCTION public.door(uuid) RENAME TO also_wrong$dynamic$;
  ALTER FUNCTION public.door(uuid) RENAME TO door_before_wrapper;
END;
$rename$;
"""
  wrapper=function(
   "door","p_id uuid",body="BEGIN PERFORM public.door_before_wrapper(p_id); END"
  )
  closure=self.closure([helper+original,rename,wrapper],{"door"})
  self.assertEqual(
   [name for name,_ in closure],
   ["real_helper","door_before_wrapper","door"],
  )
  declarations=dict(closure)
  self.assertIn("FUNCTION public.door_before_wrapper",declarations["door_before_wrapper"])
  self.assertNotIn("wrong_name",declarations["door_before_wrapper"])


if __name__=="__main__":
 unittest.main()
