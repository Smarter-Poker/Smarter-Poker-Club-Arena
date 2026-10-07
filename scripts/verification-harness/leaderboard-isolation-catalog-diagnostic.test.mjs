import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { diagnoseCatalog } from './leaderboard-isolation-catalog-diagnostic.mjs';

const names = [
  'database',
  'database_settings',
  'sql_settings',
  'tablespaces',
  'extensions',
  'roles',
  'memberships',
  'schemas',
  'relations',
  'columns',
  'routines',
  'constraints',
  'domain_constraints',
  'indexes',
  'triggers',
  'event_triggers',
  'publications',
  'publication_relations',
  'publication_schemas',
  'policies',
  'types',
  'defaults',
];
function catalog() {
  return {
    ...Object.fromEntries(names.map((name) => [name, null])),
    database: [
      'private_database',
      'private_owner',
      null,
      'UTF8',
      'C',
      'C',
      'c',
      null,
      null,
      -1,
      'private_space',
    ],
  };
}
const encode = JSON.stringify;

test('membership attribute changes pair exact identities and expose only indices', () => {
  const source = catalog();
  const destination = catalog();
  source.memberships = [['SECRET_ROLE', 'SECRET_MEMBER', 'SECRET_GRANTOR', false, true, false]];
  destination.memberships = [['SECRET_ROLE', 'SECRET_MEMBER', 'SECRET_GRANTOR', true, false, true]];
  const result = diagnoseCatalog(encode(source), encode(destination));
  const section = result.sections.find((entry) => entry.section === 'memberships');
  assert.equal(section.matched_identities, 1);
  assert.deepEqual(section.changed_field_indices, [
    { index: 3, count: 1 },
    { index: 4, count: 1 },
    { index: 5, count: 1 },
  ]);
  assert.doesNotMatch(encode(result), /SECRET|private_/);
});

test('null differs from empty rows and database singleton remains a single row', () => {
  const source = catalog();
  const destination = catalog();
  destination.roles = [];
  const result = diagnoseCatalog(encode(source), encode(destination));
  assert.equal(result.sections[0].source_count, 1);
  const roles = result.sections.find((entry) => entry.section === 'roles');
  assert.equal(roles.source_kind, 'null');
  assert.equal(roles.destination_kind, 'rows');
  assert.notEqual(roles.source_hash, roles.destination_hash);
});

test('strict sections, widths, scalar fields and duplicate identities refuse', () => {
  for (const mutate of [
    (value) => {
      value.unknown_secret = 'TOKEN';
    },
    (value) => {
      delete value.roles;
    },
    (value) => {
      value.roles = ['TOKEN'];
    },
    (value) => {
      value.schemas = [['TOKEN', { password: 'TOKEN' }, null]];
    },
    (value) => {
      value.schemas = [
        ['TOKEN', 'owner', null],
        ['TOKEN', 'other', null],
      ];
    },
    (value) => {
      value.memberships = [['role', 'member', 'grantor', 'TOKEN', true, false]];
    },
  ]) {
    const invalid = catalog();
    mutate(invalid);
    assert.throws(
      () => diagnoseCatalog(encode(invalid), encode(catalog())),
      /^Error: CATALOG_DIAGNOSTIC_UNKNOWN$/
    );
  }
  const duplicate = encode(catalog()).replace('"roles":null', '"roles":null,"roles":null');
  assert.throws(() => diagnoseCatalog(duplicate, encode(catalog())), /CATALOG_DIAGNOSTIC_UNKNOWN/);
});

test('multiple indexes use definition identity; renamed definitions are added/removed, never ambiguous', () => {
  const source = catalog();
  const destination = catalog();
  source.indexes = [
    ['SECRET_SCHEMA', 'SECRET_TABLE', 'SECRET_SQL_1', true, true],
    ['SECRET_SCHEMA', 'SECRET_TABLE', 'SECRET_SQL_2', true, true],
  ];
  destination.indexes = [
    ['SECRET_SCHEMA', 'SECRET_TABLE', 'SECRET_SQL_3', true, true],
    ['SECRET_SCHEMA', 'SECRET_TABLE', 'SECRET_SQL_2', false, true],
  ];
  const result = diagnoseCatalog(encode(source), encode(destination));
  const index = result.sections.find((entry) => entry.section === 'indexes');
  assert.equal(index.added_identities, 1);
  assert.equal(index.removed_identities, 1);
  assert.deepEqual(index.changed_field_indices, [{ index: 3, count: 1 }]);
  assert.doesNotMatch(encode(result), /SECRET/);
});

test('actual CLI rejects symlink, malformed/private text and oversized file without raw output', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'leaderboard-catalog-diagnostic-'));
  try {
    const left = join(scratch, 'left.json');
    const right = join(scratch, 'right.json');
    writeFileSync(left, encode(catalog()));
    writeFileSync(right, encode(catalog()));
    const run = (path) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./leaderboard-isolation-catalog-diagnostic.mjs', import.meta.url)),
          path,
          right,
        ],
        { encoding: 'utf8' }
      );
    assert.equal(run(left).status, 0);
    const link = join(scratch, 'link');
    symlinkSync(left, link);
    const symlink = run(link);
    assert.equal(symlink.status, 1);
    assert.equal(symlink.stderr, 'CATALOG_DIAGNOSTIC_UNKNOWN\n');
    assert.equal(symlink.stdout, '');
    writeFileSync(left, '{SECRET_TOKEN_DO_NOT_PRINT');
    const malformed = run(left);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, '');
    assert.equal(malformed.stderr, 'CATALOG_DIAGNOSTIC_UNKNOWN\n');
    writeFileSync(left, Buffer.alloc(64 * 1024 * 1024 + 1));
    const oversized = run(left);
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stdout, '');
    assert.equal(oversized.stderr, 'CATALOG_DIAGNOSTIC_UNKNOWN\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
