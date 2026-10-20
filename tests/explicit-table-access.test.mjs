import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMigration } from '../scripts/ci/check-explicit-table-access.mjs';
const boundary = `REVOKE ALL ON TABLE public.example FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.example ENABLE ROW LEVEL SECURITY;`;
test('implicit grants fail even when an RLS policy exists', () => {
  assert.equal(auditMigration('CREATE TABLE public.example(id integer); CREATE POLICY own ON public.example USING (true);').length, 5);
});
test('explicit service-only, browser-read-only and RPC-only boundaries pass', () => {
  for (const grant of ['', 'GRANT INSERT ON public.example TO service_role;', 'GRANT SELECT(id) ON public.example TO authenticated;'])
    assert.deepEqual(auditMigration(`CREATE TABLE public.example(id integer); ${boundary} ${grant}`), []);
});
test('PUBLIC revoke alone never substitutes for the three named roles', () => {
  assert.equal(auditMigration('CREATE TABLE example(id integer); REVOKE ALL ON example FROM PUBLIC; ALTER TABLE example ENABLE ROW LEVEL SECURITY;').length, 3);
});
test('comments, strings and temporary tables cannot create false findings', () => {
  assert.deepEqual(auditMigration(`-- CREATE TABLE public.fake(id int);
/* nested /* CREATE TABLE public.fake2(id int); */ ignored */
SELECT 'CREATE TABLE public.fake3(id int);';

CREATE TEMP TABLE public.temporary(id int); CREATE TABLE private.hidden(id int);`), []);
});
test('quoted names, multiple relations and split revoke statements are recognized', () => {
  assert.deepEqual(auditMigration(`CREATE TABLE "public"."example"(id int);
REVOKE ALL PRIVILEGES ON TABLE public.other, "public"."example" FROM PUBLIC;
REVOKE ALL ON example FROM anon, authenticated, service_role;
ALTER TABLE "public"."example" ENABLE ROW LEVEL SECURITY;`), []);
});
test('every created table needs its own boundary', () => {
  assert.equal(auditMigration(`CREATE TABLE example(id int); CREATE TABLE missed(id int); ${boundary}`).length, 5);
});

test('executable table DDL inside DO bodies is checked', () => {
  assert.equal(auditMigration('DO $body$ BEGIN CREATE TABLE public.dynamic(id int); END $body$;').length, 5);
});

test('an uncalled stored function cannot supply a table boundary', () => {
  assert.equal(auditMigration(`CREATE TABLE public.example(id int);
CREATE FUNCTION later() RETURNS void LANGUAGE sql AS $$ ${boundary} $$;`).length, 5);
});
