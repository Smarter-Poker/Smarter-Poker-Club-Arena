import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildCatalogueRestorePlan } from '../schema-catalogue-restore-map.mjs';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const column = (schema, table, name, ordinal) =>
  [schema, table, name, 'integer', 'pg_catalog', 'int4', true, null, ordinal, -1, 'b', null];
const original = () => ({ access: [['literal', 'retained']], roles: [], memberships: [],
  functions: [['auth', 'f', '', 'literal definition']], columns: [column('auth', 'users', 'id', 1),
    column('auth', 'users', 'gap', 4), column('public', 'a', 'id', 1),
    column('public', 'a', 'gap', 3), column('public', 'b', 'first', 7)],
  policies: [], constraints: [], triggers: [], indexes: [], rls: [] });
function payload(body = original()) {
  const text = JSON.stringify(body);
  return { version: 1, scope: 'complete-schema-catalogue', encoding: 'postgres-jsonb-text-sha256/v1',
    catalogue_text: text, catalogue_digest: sha(text) };
}
// These doubles verify boundaries only. They are NOT a PostgreSQL canonical-text
// or native restore qualification; that real proof belongs to the existing job.
function dbFor(body, inspect = () => {}) {
  return { query: async (query) => {
    inspect(query);
    return { rows: [{ original_is_canonical: true, expected_catalogue_text: JSON.stringify(body) }] };
  } };
}
function mapped(body) {
  const result = structuredClone(body);
  const ranks = new Map();
  for (const row of result.columns) {
    const key = JSON.stringify(row.slice(0, 2));
    const rank = (ranks.get(key) ?? 0) + 1; ranks.set(key, rank);
    if (row[0] === 'public') row[8] = rank;
  }
  return result;
}

test('fixed original-bound map compacts public only, preserves Auth, all metadata and input bytes', async () => {
  const body = original(); const input = payload(body); const before = structuredClone(input);
  const plan = await buildCatalogueRestorePlan(dbFor(mapped(body), (q) => {
    assert.deepEqual(q.values, [input.catalogue_text]); assert.equal(q.query_timeout, 5000);
    assert.match(q.text, /\$1::text::jsonb/); assert.match(q.text, /WITH ORDINALITY/);
    assert.match(q.text, /row_number\(\) OVER/); assert.match(q.text, /item->>0 = 'public'/);
    assert.match(q.text, /jsonb_set\(item, '\{8\}'/); assert.match(q.text, /ORDER BY position/);
    assert.ok(!/pg_attribute|pg_class|UPDATE|INSERT|DELETE|CREATE|ALTER|DROP/.test(q.text));
  }), input);
  assert.deepEqual(JSON.parse(plan.expected_catalogue_text), mapped(body));
  assert.equal(plan.expected_catalogue_digest, sha(plan.expected_catalogue_text));
  assert.deepEqual(input, before); assert.equal(plan.mapping.changed_rows_count, 2);
  assert.equal(plan.mapping.columns_count, 5); assert.equal(plan.mapping.public_columns_count, 3);
  assert.deepEqual(plan.mapping.changed_rows.map((r) => [r.original_attnum, r.restored_attnum]), [[3, 2], [7, 1]]);
  assert.equal(plan.mapping.changed_rows_digest, sha(JSON.stringify(plan.mapping.changed_rows)));
  assert.ok(!JSON.stringify(plan.mapping.public_receipt).includes('literal'));
  assert.ok(!('changed_rows' in plan.mapping.public_receipt));
  assert.equal(plan.mapping.public_receipt.original_digest, input.catalogue_digest);
});

test('contiguous public columns, Auth gaps and empty catalogue require no mapped changes', async () => {
  for (const cols of [[], [column('auth', 'a', 'x', 5)], [column('public', 'a', 'x', 1), column('public', 'a', 'y', 2)]]) {
    const body = original(); body.columns = cols;
    const plan = await buildCatalogueRestorePlan(dbFor(body), payload(body));
    assert.equal(plan.mapping.changed_rows_count, 0);
  }
});

test('invalid provenance/hash/encoding and closed catalogue/column shapes refuse before SQL', async () => {
  const cases = [];
  for (const change of [{ version: 2 }, { scope: 'observed' }, { encoding: 'json' },
    { catalogue_digest: 'a'.repeat(64) }, { catalogue_text: null }]) cases.push({ ...payload(), ...change });
  const mutations = [b => { b.extra = []; }, b => { delete b.rls; }, b => { b.access = {}; },
    b => b.columns[0].push('extra'), b => { b.columns[0][8] = 0; }, b => { b.columns[0][8] = '1'; },
    b => { b.columns[0][8] = 1.5; }, b => { b.columns[0][8] = 32768; },
    b => { b.columns[0][0] = 'other'; }, b => { b.columns[0][6] = null; },
    b => { b.columns[0][7] = {}; }, b => { b.columns[0][9] = -2; },
    b => { b.columns[0][10] = 'unknown'; }, b => { b.columns[0][11] = 'bad'; },
    b => { b.columns[1][8] = 1; }, b => { b.columns[1][2] = b.columns[0][2]; },
    b => { b.columns.push(column('auth', 'users', 'later', 10)); }];
  for (const mutate of mutations) { const body = original(); mutate(body); cases.push(payload(body)); }
  for (const input of cases) await assert.rejects(buildCatalogueRestorePlan({ query: () => assert.fail('must not query') }, input));
});

test('unexpected SQL/native-shaped changes, noncanonical original and partial replies refuse', async () => {
  const body = original();
  for (const mutate of [b => { b.columns[1][8] = 2; }, b => { b.access = []; },
    b => { b.columns[2][3] = 'text'; }, b => { b.columns.reverse(); }, b => { b.columns.pop(); }]) {
    const expected = mapped(body); mutate(expected);
    await assert.rejects(buildCatalogueRestorePlan(dbFor(expected), payload(body)), /SCHEMA_CATALOGUE_RESTORE_MAP_REFUSED/);
  }
  for (const result of [{ rows: [] }, { rows: [{ original_is_canonical: false, expected_catalogue_text: '{}' }] },
    { rows: [{ original_is_canonical: true, expected_catalogue_text: null }] }]) {
    await assert.rejects(buildCatalogueRestorePlan({ query: async () => result }, payload(body)));
  }
});

test('fixed source uses original PostgreSQL encoding and has no observed-catalogue/namespace option', async () => {
  const source = await readFile(new URL('../schema-catalogue-restore-map.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildCatalogueRestorePlan\(db, originalPayload\)/);
  assert.match(source, /body::text = \$1::text/);
  assert.match(source, /digest\(row.expected_catalogue_text\)/);
  assert.ok(!/schemaCataloguePayload\(|process\.env|fetch\(|child_process/.test(source));
});

test('provider and literal-bearing validation errors expose only fixed refusal text', async () => {
  for (const db of [{ query: async () => { throw new Error('private-provider-secret'); } },
    dbFor({ private: 'literal-body' })]) {
    await assert.rejects(buildCatalogueRestorePlan(db, payload()), error => {
      assert.equal(error.message, 'SCHEMA_CATALOGUE_RESTORE_MAP_REFUSED');
      assert.equal(error.cause, undefined); return true;
    });
  }
});
