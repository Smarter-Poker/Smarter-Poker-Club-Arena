import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('preflight compares the full expected PG catalogue and every role/settings/default ACL fact', () => {
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

// Wiring enforcement only: actual PostgreSQL canonical mapping and full restore
// remain required in the protected native operation, never supplied by doubles.
test('preflight derives public-only expected restoration before reading native state and exports no private rows', async () => {
  const source = await readFile(new URL('../../native/schema-preflight.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("../fixture/schema-catalogue-restore-map.mjs"));
  assert.ok(source.indexOf('await buildCatalogueRestorePlan(db, expected)') < source.indexOf('await schemaCataloguePayload(db)'));
  assert.ok(source.includes('expected: restoredExpected'));
  assert.ok(source.includes('catalogue_text: restoration.expected_catalogue_text'));
  assert.ok(source.includes('catalogue_digest: restoration.expected_catalogue_digest'));
  assert.ok(source.includes('original_catalogue_digest: expected.catalogue_digest'));
  assert.ok(source.includes('catalogue_restore_mapping: restoration.mapping.public_receipt'));
  assert.ok(!source.includes('catalogue_restore_mapping: restoration.mapping,'));
  const controller = await readFile(new URL('../../native/observe-connected-ui.py', import.meta.url), 'utf8');
  assert.ok(controller.includes("'operations/release/fixture/schema-catalogue-restore-map.mjs'"));
  assert.ok(controller.includes("'catalogue_digest': restored_digest"));
  assert.ok(controller.includes("report['catalogue_restore_mapping'] = restore_mapping"));
});
