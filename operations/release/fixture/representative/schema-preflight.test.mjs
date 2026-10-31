import test from 'node:test';
import assert from 'node:assert/strict';
// Import the actual full private-controls dependency closure, not a copied stub.
import { assertPreflightParity } from '../../native/schema-preflight.mjs';
import { requireFixtureSchemaMode } from '../runtime-files.mjs';

const template = {
  source_contract: {
    current_database_contract_ready: false,
    exclusions: ['native-preflight-pending'],
  },
};
const payload = {
  encoding: 'postgres-jsonb-text-sha256/v1',
  catalogue_digest: 'a'.repeat(64),
  catalogue_text: '{"complete": true}',
};
const roles = {
  scope: 'password-free-role-catalogue',
  contains_passwords_or_user_rows: false,
  roles: [{ name: 'ordinary', superuser: false }],
  memberships: [],
  default_acl: [],
  role_settings: [],
};
const valid = {
  expected: payload,
  observed: payload,
  expectedRoles: roles,
  observedRoles: roles,
  template,
};

test('only fixed no-game preflight admits a false schema; ordinary start refuses every incomplete form', () => {
  requireFixtureSchemaMode(template, true);
  assert.throws(() => requireFixtureSchemaMode(template));
  requireFixtureSchemaMode({
    source_contract: { current_database_contract_ready: true, exclusions: [] },
  });
  assert.throws(() =>
    requireFixtureSchemaMode({
      source_contract: { current_database_contract_ready: true, exclusions: ['missing-ACL'] },
    })
  );
  assert.throws(() =>
    requireFixtureSchemaMode(
      { source_contract: { current_database_contract_ready: false, exclusions: [] } },
      true
    )
  );
  assert.throws(() =>
    requireFixtureSchemaMode(
      { source_contract: { current_database_contract_ready: true, exclusions: [] } },
      true
    )
  );
});

test('preflight compares exact original PG catalogue and every role/settings/default ACL fact', () => {
  assertPreflightParity(valid);
  for (const changed of [
    { observed: { ...payload, catalogue_digest: 'b'.repeat(64) } },
    { observed: { ...payload, catalogue_text: '{"omitted": true}' } },
    { observed: { ...payload, encoding: 'other' } },
    { observedRoles: { ...roles, roles: [...roles.roles, { name: 'extra' }] } },
    { observedRoles: { ...roles, memberships: [{ role: 'elevated', member: 'ordinary' }] } },
    { observedRoles: { ...roles, default_acl: [{ creator: 'ordinary', privilege: 'ALL' }] } },
    { observedRoles: { ...roles, role_settings: [{ key: 'statement_timeout', value: '0' }] } },
    { template: { source_contract: { current_database_contract_ready: true, exclusions: [] } } },
  ])
    assert.throws(() => assertPreflightParity({ ...valid, ...changed }));
});
