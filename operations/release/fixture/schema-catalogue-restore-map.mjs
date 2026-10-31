// Private original-source mapping only. Never pass an observed native catalogue
// as originalPayload or upload mapping.changed_rows / literal catalogue text.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 33554432;
const RULE = 'public-live-column-rank/v1';
const KEYS = ['access', 'roles', 'memberships', 'functions', 'columns',
  'policies', 'constraints', 'triggers', 'indexes', 'rls'].sort();
// No catalogue tables, observer input, identifiers or configurable namespace.
const RESTORE_SQL = `WITH original AS (SELECT $1::text::jsonb AS body),
  ranked AS (
    SELECT item, position,
      row_number() OVER (PARTITION BY item->>0, item->>1 ORDER BY position) AS rank
    FROM original, pg_catalog.jsonb_array_elements(body->'columns')
      WITH ORDINALITY AS columns(item, position)
  ), mapped AS (
    SELECT pg_catalog.jsonb_set(body, '{columns}',
      COALESCE((SELECT pg_catalog.jsonb_agg(
        CASE WHEN item->>0 = 'public'
          THEN pg_catalog.jsonb_set(item, '{8}', pg_catalog.to_jsonb(rank), false)
          ELSE item END ORDER BY position) FROM ranked), '[]'::jsonb), false) AS body,
      body::text = $1::text AS original_is_canonical
    FROM original
  ) SELECT CASE WHEN pg_catalog.octet_length(body::text) <= 33554432
      THEN body::text END AS expected_catalogue_text, original_is_canonical FROM mapped`;

function validate(payload) {
  assert.equal(payload?.version, 1, 'RESTORE_MAP_VERSION');
  assert.equal(payload.scope, 'complete-schema-catalogue', 'RESTORE_MAP_SCOPE');
  assert.equal(payload.encoding, 'postgres-jsonb-text-sha256/v1', 'RESTORE_MAP_ENCODING');
  assert.equal(typeof payload.catalogue_text, 'string', 'RESTORE_MAP_TEXT');
  assert.ok(Buffer.byteLength(payload.catalogue_text) <= MAX_BYTES, 'RESTORE_MAP_BYTES');
  assert.match(payload.catalogue_digest, /^[a-f0-9]{64}$/, 'RESTORE_MAP_DIGEST');
  assert.equal(digest(payload.catalogue_text), payload.catalogue_digest, 'RESTORE_MAP_HASH');
  const body = JSON.parse(payload.catalogue_text);
  assert.ok(body && !Array.isArray(body) && typeof body === 'object', 'RESTORE_MAP_OBJECT');
  assert.deepEqual(Object.keys(body).sort(), KEYS, 'RESTORE_MAP_KEYS');
  for (const key of KEYS) assert.ok(Array.isArray(body[key]), 'RESTORE_MAP_ARRAYS');
  const groups = new Set();
  let group;
  let ordinal = 0;
  let names = new Set();
  for (const row of body.columns) {
    assert.ok(Array.isArray(row) && row.length === 12, 'RESTORE_MAP_COLUMN_SHAPE');
    assert.ok(['public', 'auth'].includes(row[0]), 'RESTORE_MAP_COLUMN_SCHEMA');
    for (const index of [0, 1, 2, 3, 4, 5])
      assert.ok(typeof row[index] === 'string' && row[index].length > 0, 'RESTORE_MAP_COLUMN_STRING');
    assert.equal(typeof row[6], 'boolean', 'RESTORE_MAP_NULLABLE');
    assert.ok(row[7] === null || typeof row[7] === 'string', 'RESTORE_MAP_DEFAULT');
    assert.ok(Number.isInteger(row[8]) && row[8] > 0 && row[8] <= 32767, 'RESTORE_MAP_ORDINAL');
    assert.ok(Number.isInteger(row[9]) && row[9] >= -1 && row[9] <= 2147483647, 'RESTORE_MAP_TYPEMOD');
    assert.ok(['b', 'c', 'd', 'e', 'p', 'r', 'm'].includes(row[10]), 'RESTORE_MAP_TYPE_KIND');
    assert.ok(row[10] === 'd' ? typeof row[11] === 'string' && row[11].length > 0 : row[11] === null,
      'RESTORE_MAP_DOMAIN');
    const next = JSON.stringify(row.slice(0, 2));
    if (next !== group) {
      assert.ok(!groups.has(next), 'RESTORE_MAP_NONCONTIGUOUS_RELATION');
      groups.add(next); group = next; ordinal = 0; names = new Set();
    }
    assert.ok(row[8] > ordinal, 'RESTORE_MAP_COLUMN_ORDER');
    assert.ok(!names.has(row[2]), 'RESTORE_MAP_DUPLICATE_COLUMN');
    ordinal = row[8]; names.add(row[2]);
  }
  return body;
}

async function buildPlan(db, originalPayload) {
  const original = validate(originalPayload);
  const expected = structuredClone(original);
  const changed = [];
  let group;
  let rank = 0;
  let publicCount = 0;
  for (const row of expected.columns) {
    const next = JSON.stringify(row.slice(0, 2));
    rank = next === group ? rank + 1 : 1;
    group = next;
    if (row[0] !== 'public') continue;
    publicCount++;
    if (row[8] !== rank) changed.push({ schema: row[0], relation: row[1], column: row[2],
      original_attnum: row[8], restored_attnum: rank });
    row[8] = rank;
  }
  // PostgreSQL, not JSON.stringify, owns the canonical whole-catalogue bytes.
  // The caller supplies its existing exclusive bounded read-only connection.
  const result = await db.query({ text: RESTORE_SQL, values: [originalPayload.catalogue_text],
    query_timeout: 5000 });
  assert.ok(result?.rows?.length === 1, 'RESTORE_MAP_RESULT');
  const row = result.rows[0];
  assert.equal(row.original_is_canonical, true, 'RESTORE_MAP_NONCANONICAL_ORIGINAL');
  assert.equal(typeof row.expected_catalogue_text, 'string', 'RESTORE_MAP_EXPECTED_TEXT');
  assert.ok(Buffer.byteLength(row.expected_catalogue_text) <= MAX_BYTES, 'RESTORE_MAP_EXPECTED_BYTES');
  // Also refuse a SQL/transport result changing any non-mapped field or Auth ordinal.
  assert.deepEqual(JSON.parse(row.expected_catalogue_text), expected, 'RESTORE_MAP_UNEXPECTED_CHANGE');
  const restoredDigest = digest(row.expected_catalogue_text);
  const summary = { version: 1, rule: RULE, original_digest: originalPayload.catalogue_digest,
    restored_digest: restoredDigest, columns_count: original.columns.length,
    public_columns_count: publicCount, changed_rows_count: changed.length,
    changed_rows_digest_encoding: 'utf8-json-stringify-ordered-object-array/v1',
    changed_rows_digest: digest(JSON.stringify(changed)) };
  return { expected_catalogue_text: row.expected_catalogue_text,
    expected_catalogue_digest: restoredDigest,
    mapping: { ...summary, changed_rows: changed, public_receipt: { ...summary } } };
}

// Refusal must never expose literal definitions, column names or provider text.
export async function buildCatalogueRestorePlan(db, originalPayload) {
  try {
    return await buildPlan(db, originalPayload);
  } catch {
    throw new Error('SCHEMA_CATALOGUE_RESTORE_MAP_REFUSED');
  }
}
