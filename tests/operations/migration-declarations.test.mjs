import assert from 'node:assert/strict';
import test from 'node:test';
import { declaredObjects, droppedObjects } from '../../scripts/ci/check-migrations-applied.mjs';

test('the actual migration gate preserves private table, view, function and column namespaces', () => {
  assert.deepEqual(
    declaredObjects(`
    CREATE TABLE release_ops.targets (id int);
    CREATE OR REPLACE FUNCTION release_ops.inspect() RETURNS jsonb;
    CREATE VIEW release_ops.pending AS SELECT 1;
    ALTER TABLE release_ops.targets ADD COLUMN generation bigint;
    CREATE TABLE public.targets (id int);
  `),
    {
      fns: ['release_ops.inspect'],
      tables: ['release_ops.targets', 'targets', 'release_ops.pending'],
      columns: [['release_ops.targets', 'generation']],
    }
  );
});

test('quoted identifiers, schema spacing and PostgreSQL unquoted folding retain identity', () => {
  assert.deepEqual(
    declaredObjects(`
    CREATE TABLE "release_ops" . "Targets" (id int);
    CREATE TABLE PUBLIC . TARGETS (id int);
    CREATE FUNCTION "release_ops"."Inspect"() RETURNS void;
    ALTER TABLE ONLY "release_ops" . "Targets" ADD COLUMN IF NOT EXISTS "Generation" bigint;
    ALTER TABLE release_ops.targets ADD CONSTRAINT target_key UNIQUE(id);
  `),
    {
      fns: ['release_ops.Inspect'],
      tables: ['release_ops.Targets', 'targets'],
      columns: [['release_ops.Targets', 'Generation']],
    }
  );
});

test('a private drop cannot cancel a newly created public object of the same name', () => {
  const created = declaredObjects(
    'CREATE TABLE targets (id int); CREATE FUNCTION inspect() RETURNS void;'
  );
  const dropped = droppedObjects(
    'DROP TABLE release_ops.targets; DROP FUNCTION release_ops.inspect();'
  );
  assert.equal(dropped.tables.has(created.tables[0]), false);
  assert.equal(dropped.fns.has(created.fns[0]), false);
  assert.deepEqual([...dropped.tables], ['release_ops.targets']);
  assert.deepEqual([...dropped.fns], ['release_ops.inspect']);
});

test('real declarations beside quoted prose survive without inventing declaration names', () => {
  assert.deepEqual(
    declaredObjects(`
    -- Someone's CREATE TABLE ignored (id int);
    /* An owner's CREATE TABLE hidden (id int); */
    CREATE TABLE IF NOT EXISTS public.actual (id int);
    COMMENT ON TABLE public.actual IS 'CREATE TABLE phantom';
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  `),
    { fns: [], tables: ['actual'], columns: [] }
  );
});
