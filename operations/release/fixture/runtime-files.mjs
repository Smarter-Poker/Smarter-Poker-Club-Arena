import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function nativeChildFailure(children) {
  const child = children.find(
    (item) => item.nativeFailed || item.exitCode !== null || item.signalCode !== null
  );
  if (!child) return null;
  const error = new Error('native service exited');
  if (new Set(['postgres', 'auth', 'postgrest', 'realtime']).has(child.nativeName))
    error.native_service = child.nativeName;
  if (Number.isInteger(child.exitCode) && child.exitCode >= 0 && child.exitCode <= 255)
    error.service_exit_code = child.exitCode;
  if (
    new Set(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL']).has(child.signalCode)
  )
    error.service_signal = child.signalCode;
  return error;
}

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
  if (new Set(['postgres', 'auth', 'postgrest', 'realtime']).has(error?.native_service))
    record.native_service = error.native_service;
  if (
    Number.isInteger(error?.service_exit_code) &&
    error.service_exit_code >= 0 &&
    error.service_exit_code <= 255
  )
    record.service_exit_code = error.service_exit_code;
  if (
    new Set(['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL']).has(
      error?.service_signal
    )
  )
    record.service_signal = error.service_signal;
  const frame =
    typeof error?.stack === 'string'
      ? error.stack.match(
          /file:\/\/\/opt\/qualification\/runtime\/native-smoke\.mjs:([1-9][0-9]{0,3}):[0-9]+/
        )
      : null;
  if (frame) record.native_line = Number(frame[1]);
  if (
    new Set(['header', 'row-shape', 'address-shape', 'listener-set']).has(error?.listener_reason)
  ) {
    record.listener_reason = error.listener_reason;
    for (const field of [
      'listener_loopback4',
      'listener_other4',
      'listener_ipv6',
      'listener_rows4',
      'listener_rows6',
      'listener_port4000',
      'listener_http_port',
    ]) {
      if (Number.isInteger(error[field]) && error[field] >= 0 && error[field] <= 65535) {
        record[field] = error[field];
      }
    }
    if (
      new Set([
        'ipv4-loopback',
        'ipv4-wildcard',
        'ipv4-other',
        'ipv6-loopback',
        'ipv6-wildcard',
        'ipv6-other',
        'unknown',
      ]).has(error.listener_http_address)
    )
      record.listener_http_address = error.listener_http_address;
  }
  if (
    new Set([
      'mfa-enroll',
      'mfa-factor-id',
      'mfa-challenge',
      'mfa-challenge-id',
      'mfa-totp',
      'mfa-verify',
      'mfa-session',
    ]).has(error?.auth_stage)
  )
    record.auth_stage = error.auth_stage;
  if (
    Number.isInteger(error?.auth_http_status) &&
    error.auth_http_status >= 100 &&
    error.auth_http_status <= 599
  )
    record.auth_http_status = error.auth_http_status;
  if (
    record.error === 'Error' &&
    Number.isInteger(error?.code) &&
    error.code >= 1 &&
    error.code <= 255
  ) {
    record.exit_code = error.code;
    // GoTrue's pinned migrate command wraps failures with these fixed phases.
    // Keep only a unique reviewed phase and SQLSTATE, never the private log.
    const output = [error.stdout, error.stderr]
      .filter((value) => typeof value === 'string' && value.length <= 8 * 1024 * 1024)
      .join('\n');
    const phases = [
      ['parsing db connection url', 'auth-url'],
      ['opening db connection', 'auth-open'],
      ['checking database connection', 'auth-connect'],
      ['creating db migrator', 'auth-migrator'],
      ['running db migrations', 'auth-migrations'],
    ].filter(([pattern]) => output.includes(pattern));
    if (phases.length === 1) record.command_phase = phases[0][1];
    const states = [
      ...new Set([...output.matchAll(/\(SQLSTATE ([0-9A-Z]{5})\)/g)].map((match) => match[1])),
    ];
    if (states.length === 1) record.command_sqlstate = states[0];
  }
  if (
    record.error === 'error' &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  ) {
    record.sqlstate = error.code;
    // These source-location digests let the controller match the pinned
    // PostgreSQL source offline without serializing arbitrary driver strings.
    for (const field of ['routine', 'file']) {
      if (typeof error[field] === 'string' && error[field].length <= 256) {
        record[`${field}_sha256`] = createHash('sha256').update(error[field]).digest('hex');
      }
    }
    if (typeof error.position === 'string' && /^[1-9][0-9]{0,5}$/.test(error.position)) {
      record.position = Number(error.position);
    }
    if (
      new Set([
        'CheckSlotPermissions',
        'CheckLogicalDecodingRequirements',
        'internal_load_library',
        'CreateSlotOnDisk',
        'SaveSlotToPath',
        'XLogFileRead',
        'XLogFileReadAnyTLI',
        'ReorderBufferRestoreChanges',
        'ReorderBufferSerializeTXN',
        'aclcheck_error',
      ]).has(error.routine)
    )
      record.routine = error.routine;
  }
  return record;
}

// An established pg.Client can emit an error while no query is pending. Own
// that event before connecting, retain only safe fields, and abort dependent
// commands instead of letting EventEmitter print the original driver error.
export class NativeDatabaseOwner {
  #clients = new Map();
  #controller = new AbortController();
  #failure = null;
  #closed = false;
  get signal() {
    return this.#controller.signal;
  }
  get failure() {
    return this.#failure;
  }
  own(client) {
    assert.ok(!this.#closed && !this.#failure, 'native database owner unavailable');
    assert.ok(!this.#clients.has(client), 'native database client already owned');
    client.on('error', (error) => {
      if (this.#failure) return;
      const safe = nativeFailureDiagnostic('postgresql-client-connection', error);
      const failure = new Error('native database connection failed');
      failure.name = safe.error;
      if (safe.sqlstate) failure.code = safe.sqlstate;
      if (safe.position) failure.position = String(safe.position);
      if (safe.routine) failure.routine = safe.routine;
      this.#failure = failure;
      this.#controller.abort(failure);
    });
    this.#clients.set(client, null);
    return client;
  }
  check() {
    if (this.#failure) throw this.#failure;
  }
  async end(client) {
    assert.ok(this.#clients.has(client), 'native database client not owned');
    if (!this.#clients.get(client))
      this.#clients.set(
        client,
        Promise.resolve().then(() => client.end())
      );
    await this.#clients.get(client);
  }
  async close(milliseconds = 10000) {
    this.#closed = true;
    let timer;
    try {
      const results = await Promise.race([
        Promise.allSettled([...this.#clients.keys()].map((client) => this.end(client))),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('native database close timed out')),
            milliseconds
          );
        }),
      ]);
      assert.ok(
        results.every((result) => result.status === 'fulfilled'),
        'native database close failed'
      );
    } finally {
      clearTimeout(timer);
    }
  }
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
