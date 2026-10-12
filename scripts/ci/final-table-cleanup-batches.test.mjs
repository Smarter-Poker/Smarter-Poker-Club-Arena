import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchRequest,
  pageIdentity,
  applyFinalTablePages,
  BATCH_MIGRATION,
} from './final-table-cleanup-batches.mjs';
const operation = '90000000-0000-4000-8000-000000000001';
test('only the exact explicit finite operation is admitted', () => {
  assert.equal(batchRequest(BATCH_MIGRATION, null, null, null), null);
  assert.deepEqual(batchRequest(BATCH_MIGRATION, '3', operation, null), { count: 3, operation });
  for (const args of [
    ['wrong', '3', operation, null],
    [BATCH_MIGRATION, '0', operation, null],
    [BATCH_MIGRATION, '3001', operation, null],
    [BATCH_MIGRATION, '3', null, null],
    [BATCH_MIGRATION, '3', operation, {}],
  ])
    assert.throws(() => batchRequest(...args));
  assert.equal(pageIdentity(operation, 0), pageIdentity(operation, 0));
  assert.notEqual(pageIdentity(operation, 0), pageIdentity(operation, 1));
});
test('pages autocommit individually and every outcome is reread before advancing', async () => {
  const calls = [];
  let page = 0;
  const client = {
    async query(sql, args) {
      calls.push([sql, args]);
      if (sql.startsWith('SET')) return {};
      if (sql.includes('schema_migrations')) return { rows: [{ exact: true }] };
      if (sql.includes('fn_advance'))
        return { rows: [{ result: { visited: 200, updated: 200, complete: page === 1 } }] };
      return { rows: [{ result: { visited: 200, updated: 200, complete: page++ === 1 } }] };
    },
  };
  await applyFinalTablePages(client, { count: 5, operation }, 'exact', false, () => {});
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(([sql]) => sql.includes('fn_advance')).length, 2);
  assert.equal(calls.filter(([sql]) => /BEGIN|COMMIT/.test(sql)).length, 0);
  assert.deepEqual(calls[2][1], calls[3][1]);
  assert.deepEqual(calls[4][1], calls[5][1]);
});
test('unknown send or missing durable result stops without retry or next page', async () => {
  for (const mode of ['transport', 'missing']) {
    let sends = 0;
    const client = {
      async query(sql) {
        if (sql.startsWith('SET')) return {};
        if (sql.includes('schema_migrations')) return { rows: [{ exact: true }] };
        if (sql.includes('fn_advance')) {
          sends++;
          if (mode === 'transport') throw Error('lost acknowledgement');
          return { rows: [{ result: { complete: false } }] };
        }
        return { rows: [] };
      },
    };
    await assert.rejects(
      applyFinalTablePages(client, { count: 3, operation }, 'exact', false, () => {})
    );
    assert.equal(sends, 1);
  }
});
test('dry run and mismatched installed bytes never send a page', async () => {
  for (const exact of [true, false]) {
    let sends = 0;
    const client = {
      async query(sql) {
        if (sql.startsWith('SET')) return {};
        if (sql.includes('schema_migrations')) return { rows: [{ exact }] };
        sends++;
      },
    };
    if (exact) await applyFinalTablePages(client, { count: 3, operation }, 'exact', true, () => {});
    else
      await assert.rejects(
        applyFinalTablePages(client, { count: 3, operation }, 'exact', false, () => {})
      );
    assert.equal(sends, 0);
  }
});
