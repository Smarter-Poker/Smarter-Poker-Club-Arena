import assert from 'node:assert/strict';

export function requireSchemaSourceContract(contract) {
  assert.ok(
    contract && typeof contract === 'object' && !Array.isArray(contract),
    'schema source contract required'
  );
  assert.deepEqual(Object.keys(contract).sort(), [
    'current_database_contract_ready',
    'exclusions',
    'source_sha',
    'version',
  ]);
  assert.equal(contract.version, 1);
  assert.match(contract.source_sha, /^[0-9a-f]{40}$/);
  assert.equal(
    contract.current_database_contract_ready,
    true,
    'current database contract is not ready'
  );
  assert.deepEqual(contract.exclusions, [], 'schema exclusions prevent qualification');
  // This is the reviewed schema input revision, not a demanded engine revision.
  // Before and intermediate tuples can intentionally use different engine SHAs.
  return contract.source_sha;
}
