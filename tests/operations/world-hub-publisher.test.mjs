import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, assertHealth, deploymentArgs, cacheKey, resolveBuildEnvironment, REPOSITORY, TEAM } from '../../.github/scripts/publish-world-hub.mjs';
import { parseEnv } from 'node:util';

const sha = 'a'.repeat(40);
const event = { action: 'publish-world-hub', client_payload: { repository: REPOSITORY, sha } };
test('accepts a bound full SHA and rejects foreign or injected requests', () => {
  assert.doesNotThrow(() => validateRequest(event, sha));
  for (const invalid of ['', 'main', `${sha};echo bad`, sha.slice(0, 7)]) {
    assert.throws(() => validateRequest(event, invalid));
  }
  assert.throws(() => validateRequest({ ...event, action: 'push' }, sha));
  assert.throws(() => validateRequest({ ...event, client_payload: { repository: 'untrusted/repo', sha } }, sha));
  assert.throws(() => validateRequest(event, 'b'.repeat(40)));
});
test('publication requires exact SHA, healthy application and database', () => {
  const healthy = { status: 'ok', version: sha, checks: { db: { status: 'ok' } } };
  assert.doesNotThrow(() => assertHealth(healthy, sha));
  assert.throws(() => assertHealth({ ...healthy, version: sha.slice(0, 7) }, sha));
  assert.throws(() => assertHealth({ ...healthy, version: 'b'.repeat(40) }, sha));
  assert.throws(() => assertHealth({ ...healthy, checks: { db: { status: 'error' } } }, sha));
  assert.throws(() => assertHealth({ ...healthy, status: 'error' }, sha));
});
test('upload is always prebuilt and cannot assign production before verification', () => {
  const args = deploymentArgs();
  assert.equal(args[0], 'deploy');
  assert.ok(args.includes('--prebuilt'));
  assert.ok(args.includes('--skip-domain'));
  assert.ok(args.includes('--prod'));
  assert.equal(args[args.indexOf('--scope') + 1], TEAM);
});
test('build caches change with dependencies, environment or build configuration', () => {
  const baseline = cacheKey('lock', 'environment', 'configuration');
  assert.equal(baseline, cacheKey('lock', 'environment', 'configuration'));
  assert.notEqual(baseline, cacheKey('new lock', 'environment', 'configuration'));
  assert.notEqual(baseline, cacheKey('lock', 'new environment', 'configuration'));
  assert.notEqual(baseline, cacheKey('lock', 'environment', 'new configuration'));
});
test('redacted settings use qualified inputs without overriding visible provider settings', () => {
  const result = parseEnv(resolveBuildEnvironment('A="[SENSITIVE]"\nB="current"\n', 'A="qualified"\nB="older"\n'));
  assert.equal(result.A, 'qualified');
  assert.equal(result.B, 'current');
  assert.throws(() => resolveBuildEnvironment('A="[SENSITIVE]"', ''), /missing: A/);
  assert.throws(() => resolveBuildEnvironment('A="[SENSITIVE]"', 'A="[SENSITIVE]"'), /missing: A/);
});
