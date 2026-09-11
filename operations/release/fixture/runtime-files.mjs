import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Native smoke diagnostics must not serialize database messages, queries, or
// service output: bootstrap queries contain fixture-only credentials.
export function nativeFailureDiagnostic(stage, error) {
  const names = new Set([
    'Error',
    'AssertionError',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'TimeoutError',
    'AggregateError',
    'error',
  ]);
  const record = { status: 'failed', stage, error: names.has(error?.name) ? error.name : 'Error' };
  if (
    record.error === 'error' &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  ) {
    record.sqlstate = error.code;
    if (typeof error.position === 'string' && /^[1-9][0-9]{0,5}$/.test(error.position)) {
      record.position = Number(error.position);
    }
  }
  return record;
}

// This identity comes from the immutable host-controlled input mount, never
// from the candidate archive, application schema or a runtime environment key.
export function observationControl(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['control_sha', 'version']);
  assert.equal(value.version, 1);
  assert.match(value.control_sha, /^[0-9a-f]{40}$/);
  return Object.freeze({ version: 1, control_sha: value.control_sha });
}

export function archiveNames(text) {
  assert.equal(typeof text, 'string');
  assert.ok(text.endsWith('\n'));
  const names = text.slice(0, -1).split('\n');
  assert.ok(names.length > 0 && names.length <= 20000);
  const seen = new Set();
  for (const name of names) {
    assert.ok(
      name.length > 0 &&
        name.length <= 1024 &&
        !name.startsWith('/') &&
        !name.startsWith('-') &&
        !/[\\*?\[\]\x00-\x1f\x7f]/.test(name),
      'unsafe archive member'
    );
    const parts = name.replace(/\/$/, '').split('/');
    assert.ok(
      parts.every((part) => part && part !== '.' && part !== '..'),
      'unsafe archive path'
    );
    assert.ok(!seen.has(name), 'duplicate archive member');
    seen.add(name);
  }
  // A regular file may not also be a parent directory or alias a directory.
  const files = names.filter((name) => !name.endsWith('/'));
  const fileSet = new Set(files);
  for (const name of names) {
    if (name.endsWith('/')) assert.ok(!fileSet.has(name.slice(0, -1)));
    const parts = name.split('/');
    for (let end = 1; end < parts.length; end++)
      assert.ok(!fileSet.has(parts.slice(0, end).join('/')));
  }
  return files;
}

export async function extractArchive(archive, root, { maxBytes = 256 * 1024 * 1024 } = {}) {
  assert.ok((await lstat(archive)).isFile(), 'archive must be a regular file');
  await mkdir(root, { mode: 0o700 }); // Refuse an existing extraction root.
  const { stdout } = await exec('/usr/bin/unzip', ['-Z', '-1', archive], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10000,
  });
  const files = archiveNames(stdout);
  let total = 0;
  for (const name of files) {
    // Never ask unzip to create a pathname. A ZIP symlink's target is emitted
    // as ordinary bytes and cannot escape this fresh, private extraction root.
    const { stdout: bytes } = await exec('/usr/bin/unzip', ['-p', archive, name], {
      encoding: 'buffer',
      maxBuffer: Math.max(1, maxBytes - total),
      timeout: 15000,
    });
    total += bytes.length;
    assert.ok(total <= maxBytes, 'archive expanded beyond its bound');
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  return { files, bytes: total };
}

export function startArguments(args) {
  assert.equal(args.length, 3);
  const [schema, web, engine] = args;
  assert.equal(schema, '--schema=/inputs/schema.zip');
  assert.match(web, /^--web=\/inputs\/[0-9a-f]{64}\.zip$/);
  assert.equal(engine, '--engine=http://engine:8080');
  return { schema: schema.slice(9), web: web.slice(6) };
}

export function fixtureTemplate(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    'actor_count',
    'auth_user_source',
    'scope',
    'seed_version',
    'source_contract',
    'spectator_count',
    'supabase_host',
    'version',
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.scope, 'isolated-club-arena-fixture');
  assert.equal(value.seed_version, 1);
  assert.equal(value.actor_count, 2);
  assert.equal(value.spectator_count, 1);
  assert.equal(value.auth_user_source, 'local-gotrue-admin-api');
  assert.match(value.supabase_host, /^[a-z0-9]{20}\.supabase\.co$/);
  fixtureSourceContract(value.source_contract);
  return value;
}

export function fixtureSourceContract(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    'current_database_contract_ready',
    'exclusions',
    'source_sha',
    'version',
  ]);
  assert.equal(value.version, 1);
  assert.match(value.source_sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof value.current_database_contract_ready, 'boolean');
  assert.ok(Array.isArray(value.exclusions) && value.exclusions.length <= 32);
  assert.equal(new Set(value.exclusions).size, value.exclusions.length);
  for (const exclusion of value.exclusions) {
    assert.equal(typeof exclusion, 'string');
    assert.match(exclusion, /^[a-z][a-z0-9-]{0,99}$/);
  }
  // A historical/service-only fixture can run a limited native smoke, but it
  // cannot represent itself as the full current database contract. The trusted
  // product qualifier independently refuses any incomplete contract.
  assert.equal(value.current_database_contract_ready, value.exclusions.length === 0);
  return value;
}
