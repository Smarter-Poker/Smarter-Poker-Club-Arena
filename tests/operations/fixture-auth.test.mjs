import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFixtureAuthVersion,
  browserStorage,
  fixtureAuth,
  fixtureSecrets,
  issueFixtureToken,
  totp,
  verifyFixtureToken,
} from '../../operations/release/fixture/auth-fixture.mjs';

test('accepts the pinned native GoTrue version output and refuses changed binaries', () => {
  // Captured from the actual successful Linux image build at 799eebf49d.
  const nativeVersion = 'v2.196.0\n';
  assert.equal(/\b2\.196\.0\b/.test(nativeVersion), false);
  assert.doesNotThrow(() => assertFixtureAuthVersion(nativeVersion));
  for (const changed of ['v2.196.1', 'v2.196.01', 'v2.196.0-dev', 'v2.196.0\nv2.197.0', '']) {
    assert.throws(() => assertFixtureAuthVersion(changed));
  }
});

test('synthetic service/anonymous tokens are isolated per fixture and cryptographically bound', () => {
  const one = fixtureSecrets(),
    two = fixtureSecrets();
  assert.notEqual(one.jwtSecret, two.jwtSecret);
  assert.equal(verifyFixtureToken(one.serviceKey, one.jwtSecret).role, 'service_role');
  assert.equal(verifyFixtureToken(one.anonKey, one.jwtSecret).role, 'anon');
  assert.throws(() => verifyFixtureToken(one.serviceKey, two.jwtSecret));
  assert.throws(() => issueFixtureToken(one.jwtSecret, 'authenticated'));
  const expired = issueFixtureToken(one.jwtSecret, 'anon', Date.now() - 7200000);
  assert.throws(() => verifyFixtureToken(expired, one.jwtSecret));
});

test('local auth client refuses remote hosts, credentials, path prefixes and a non-service token', () => {
  const secret = fixtureSecrets();
  for (const endpoint of [
    'https://127.0.0.1:9999',
    'http://localhost:9999',
    'http://example.com:9999',
    'http://user:password@127.0.0.1:9999',
    'http://127.0.0.1:9999/auth/',
  ]) {
    assert.throws(() =>
      fixtureAuth({ endpoint, serviceKey: secret.serviceKey, jwtSecret: secret.jwtSecret })
    );
  }
  assert.throws(() => fixtureAuth({ serviceKey: secret.anonKey, jwtSecret: secret.jwtSecret }));
});

test('TOTP matches independently published RFC6238 SHA1 vectors truncated to six digits', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [seconds, expected] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]) {
    assert.equal(totp(secret, seconds * 1000), expected);
  }
});

test('browser storage uses the compiled project namespace without adding unrelated origins', () => {
  const session = {
    user: { id: '10000000-0000-4000-8000-000000000001' },
    access_token: 'synthetic-only',
  };
  const state = browserStorage(session, 'abcdefghijklmnopqrst.supabase.co');
  assert.deepEqual(state.cookies, []);
  assert.equal(state.origins.length, 1);
  assert.equal(state.origins[0].origin, 'https://smarter.poker');
  assert.equal(state.origins[0].localStorage[0].name, 'sb-abcdefghijklmnopqrst-auth-token');
  assert.deepEqual(JSON.parse(state.origins[0].localStorage[0].value), session);
});
