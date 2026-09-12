import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSchemaSourceContract } from '../../operations/release/native/component-source-contract.mjs';
const valid = {
  version: 1,
  source_sha: '0bde95ca96aa50720c253e7ff1925ec233fa3039',
  current_database_contract_ready: true,
  exclusions: [],
};
test('reviewed schema revision is independent of before/intermediate engine revisions', () => {
  assert.equal(requireSchemaSourceContract(valid), valid.source_sha);
  assert.notEqual(valid.source_sha, 'a'.repeat(40));
});
test('oracle independently refuses missing, malformed, incomplete and excluded schemas', () => {
  for (const contract of [
    undefined,
    null,
    [],
    {},
    { ...valid, version: '1' },
    { ...valid, source_sha: 'x' },
    { ...valid, current_database_contract_ready: false },
    { ...valid, current_database_contract_ready: 'true' },
    { ...valid, exclusions: ['application-role-acl-baseline'] },
    { ...valid, exclusions: {} },
    { ...valid, other: true },
  ]) {
    assert.throws(() => requireSchemaSourceContract(contract));
  }
});
