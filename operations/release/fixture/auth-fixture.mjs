import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function issueFixtureToken(secret, role, now = Date.now()) {
  assert.ok(secret.length >= 32);
  assert.ok(['anon', 'service_role'].includes(role));
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    role,
    iss: 'supabase',
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyFixtureToken(token, secret, now = Date.now()) {
  assert.equal(typeof token, 'string');
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  assert.equal(header.alg, 'HS256');
  const actual = Buffer.from(parts[2], 'base64url');
  const expected = createHmac('sha256', secret).update(parts.slice(0, 2).join('.')).digest();
  assert.equal(actual.length, expected.length);
  assert.ok(timingSafeEqual(actual, expected), 'fixture token signature differs');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.ok(Number.isSafeInteger(claims.exp) && claims.exp > Math.floor(now / 1000));
  return claims;
}

export function fixtureSecrets() {
  const jwtSecret = randomBytes(48).toString('base64url');
  return {
    jwtSecret,
    anonKey: issueFixtureToken(jwtSecret, 'anon'),
    serviceKey: issueFixtureToken(jwtSecret, 'service_role'),
    databasePassword: randomBytes(32).toString('hex'),
    realtimeSecret: randomBytes(64).toString('base64'),
    realtimeEncryptionKey: randomBytes(8).toString('hex'),
  };
}

// GoTrue uses RFC6238 TOTP. The secret exists only in this disposable fixture;
// it is never printed, attached to a receipt or copied from an existing user.
export function totp(secret, now = Date.now()) {
  assert.match(secret, /^[A-Z2-7]+=*$/);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const hash = createHmac('sha1', bytes).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function authEndpoint(endpoint) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(
    url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
  );
  return url.origin;
}

export function fixtureAuth({ endpoint = 'http://127.0.0.1:9999', serviceKey, jwtSecret }) {
  const origin = authEndpoint(endpoint);
  assert.equal(verifyFixtureToken(serviceKey, jwtSecret).role, 'service_role');
  async function request(route, body, token = serviceKey) {
    const response = await fetch(origin + route, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    assert.ok(response.ok, `local auth refused HTTP ${response.status}`);
    const text = await response.text();
    assert.ok(text.length <= 128 * 1024, 'local auth response too large');
    return JSON.parse(text);
  }
  function validateSession(session, expectedId, minimumAal = 'aal1') {
    const claims = verifyFixtureToken(session.access_token, jwtSecret);
    assert.equal(claims.sub, expectedId);
    assert.equal(claims.role, 'authenticated');
    assert.equal(claims.aal, minimumAal);
    assert.equal(session.user.id, expectedId);
    assert.ok(typeof session.refresh_token === 'string' && session.refresh_token.length > 0);
    return { ...session, expires_at: claims.exp };
  }
  return {
    async createUsers() {
      const users = [];
      for (const name of ['actor-one', 'actor-two', 'spectator']) {
        const email = `${name}@component-fixture.invalid`;
        const password = randomBytes(32).toString('base64url');
        const user = await request('/admin/users', {
          email,
          password,
          email_confirm: true,
          user_metadata: {
            component_qualification: true,
            username: `component_${name.replaceAll('-', '_')}`,
          },
        });
        assert.match(user.id, uuid);
        assert.equal(user.email, email);
        const session = validateSession(
          await request('/token?grant_type=password', { email, password }),
          user.id
        );
        users.push({ id: user.id, email, session });
      }
      assert.equal(new Set(users.map((user) => user.id)).size, 3);
      return users;
    },
    async enrollMfa(user) {
      const token = user.session.access_token;
      const factor = await request(
        '/factors',
        { factor_type: 'totp', friendly_name: 'component-fixture', issuer: 'component-fixture' },
        token
      );
      assert.match(factor.id, uuid);
      const challenge = await request(`/factors/${factor.id}/challenge`, {}, token);
      assert.match(challenge.id, uuid);
      const session = await request(
        `/factors/${factor.id}/verify`,
        { challenge_id: challenge.id, code: totp(factor.totp.secret) },
        token
      );
      return { ...user, session: validateSession(session, user.id, 'aal2') };
    },
  };
}

export function browserStorage(session, supabaseHost) {
  assert.match(supabaseHost, /^[a-z0-9]{20}\.supabase\.co$/);
  assert.match(session.user.id, uuid);
  const name = `sb-${supabaseHost.split('.')[0]}-auth-token`;
  return {
    cookies: [],
    origins: [
      { origin: 'https://smarter.poker', localStorage: [{ name, value: JSON.stringify(session) }] },
    ],
  };
}
