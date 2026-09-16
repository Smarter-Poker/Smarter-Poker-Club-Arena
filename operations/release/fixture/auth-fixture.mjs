import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

// Canonical fn_club_members_ledger_writer uses this attribution key when a
// service JWT has no subject. It references auth.users, not public.users.
export const LEDGER_ATTRIBUTION_ID = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
const LEDGER_EMAIL = 'fixture-ledger@smarter-poker.invalid';
const LEDGER_PURPOSE = 'source-defined-ledger-attribution';

// The pinned GoTrue binary's version command includes a literal v prefix.
// A word-boundary before the first digit rejects that genuine output.
export function assertFixtureAuthVersion(output) {
  assert.equal(output.trim(), 'v2.196.0', 'unexpected fixture Auth version');
}

// Exact sorted migration filenames from pinned GoTrue v2.196.0, including 00.
// A positive row count alone would accept a partially migrated service.
export function assertFixtureAuthMigrations(versions) {
  assert.ok(
    Array.isArray(versions) && versions.length === 70,
    'FIXTURE_AUTH_MIGRATIONS_INCOMPLETE'
  );
  assert.ok(
    versions.every((value) => typeof value === 'string' && /^(?:00|[0-9]{14})$/.test(value))
  );
  assert.equal(new Set(versions).size, 70);
  assert.equal(
    createHash('sha256')
      .update([...versions].sort().join('\n') + '\n')
      .digest('hex'),
    'eef970cca83c2c0954e0f1a9b28757d38f4fa6067a86677b5caed4e44997ec4d',
    'FIXTURE_AUTH_MIGRATIONS_CHANGED'
  );
}

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
  async function request(route, body, token = serviceKey, expectUserBanned = false) {
    const response = await fetch(origin + route, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (expectUserBanned && response.status !== 400) {
      await response.body?.cancel();
      throw new Error('FIXTURE_LEDGER_AUTH_BAN_REQUIRED');
    }
    if (!response.ok && !expectUserBanned) {
      await response.body?.cancel();
      const failure = new Error('fixture Auth request refused');
      failure.auth_http_status = response.status;
      throw failure;
    }
    // Genuine TOTP enrollment includes an SVG QR image. Bound that one route
    // separately and enforce byte limits while reading, before buffering it all.
    const limit = expectUserBanned ? 4096 : route === '/factors' ? 1024 * 1024 : 128 * 1024;
    const reader = response.body?.getReader();
    assert.ok(reader, 'local auth response body absent');
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        assert.ok(bytes <= limit, 'local auth response too large');
        chunks.push(value);
      }
      const result = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      );
      if (expectUserBanned) {
        assert.ok(result.error_code === 'user_banned', 'FIXTURE_LEDGER_AUTH_BAN_REQUIRED');
        return;
      }
      return result;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  function validateSession(session, expectedId, minimumAal = 'aal1') {
    const claims = verifyFixtureToken(session.access_token, jwtSecret);
    assert.equal(claims.sub, expectedId);
    assert.equal(claims.role, 'authenticated');
    assert.equal(claims.aal, minimumAal);
    assert.match(claims.session_id, uuid);
    assert.equal(session.user.id, expectedId);
    assert.ok(typeof session.refresh_token === 'string' && session.refresh_token.length > 0);
    return { ...session, expires_at: claims.exp };
  }
  return {
    async createLedgerAttributionIdentity() {
      // Real GoTrue admin creation runs the canonical signup triggers. GoTrue
      // generates an unknown password when omitted; no password/session is
      // retained. The 100-year ban covers this disposable fixture's lifetime.
      const user = await request('/admin/users', {
        id: LEDGER_ATTRIBUTION_ID,
        email: LEDGER_EMAIL,
        role: 'authenticated',
        email_confirm: true,
        ban_duration: '876000h',
        user_metadata: {
          component_qualification: true,
          fixture_purpose: LEDGER_PURPOSE,
          poker_alias: 'FixtureLedger',
        },
      });
      assert.ok(
        user.id === LEDGER_ATTRIBUTION_ID &&
          user.email === LEDGER_EMAIL &&
          user.role === 'authenticated' &&
          user.user_metadata?.component_qualification === true &&
          user.user_metadata?.fixture_purpose === LEDGER_PURPOSE &&
          Date.parse(user.banned_until) > Date.now() + 86400000 &&
          !user.last_sign_in_at,
        'FIXTURE_LEDGER_ATTRIBUTION_IDENTITY_REQUIRED'
      );
      // Pinned GoTrue checks the ban before password comparison. An arbitrary
      // wrong password alone is not evidence: require its exact user_banned
      // refusal, then read back zero persisted sessions in the owned database.
      await request(
        '/token?grant_type=password',
        { email: LEDGER_EMAIL, password: randomBytes(32).toString('base64url') },
        serviceKey,
        true
      );
      return LEDGER_ATTRIBUTION_ID;
    },
    async createUsers() {
      const users = [];
      for (const name of ['actor-one', 'actor-two', 'spectator']) {
        const email = `component-${name}@smarter-poker.invalid`;
        const password = randomBytes(32).toString('base64url');
        const user = await request('/admin/users', {
          email,
          password,
          email_confirm: true,
          user_metadata: {
            component_qualification: true,
            username: `component_${name.replaceAll('-', '_')}`,
            // The real signup trigger reads poker_alias and truncates to 15
            // characters. Shared email prefixes would collide without it.
            poker_alias: name.replaceAll('-', '_'),
          },
        });
        assert.match(user.id, uuid);
        assert.equal(user.email, email);
        const session = validateSession(
          await request('/token?grant_type=password', { email, password }),
          user.id
        );
        users.push({
          id: user.id,
          email,
          session,
          sessionId: verifyFixtureToken(session.access_token, jwtSecret).session_id,
        });
      }
      assert.equal(new Set(users.map((user) => user.id)).size, 3);
      return users;
    },
    async enrollMfa(user) {
      const token = user.session.access_token;
      let stage = 'mfa-enroll';
      try {
        const factor = await request(
          '/factors',
          { factor_type: 'totp', friendly_name: 'component-fixture', issuer: 'component-fixture' },
          token
        );
        stage = 'mfa-factor-id';
        assert.match(factor.id, uuid);
        stage = 'mfa-challenge';
        const challenge = await request(`/factors/${factor.id}/challenge`, {}, token);
        stage = 'mfa-challenge-id';
        assert.match(challenge.id, uuid);
        stage = 'mfa-totp';
        const code = totp(factor.totp.secret);
        stage = 'mfa-verify';
        const session = await request(
          `/factors/${factor.id}/verify`,
          { challenge_id: challenge.id, code },
          token
        );
        stage = 'mfa-session';
        const validated = validateSession(session, user.id, 'aal2');
        return {
          ...user,
          session: validated,
          sessionId: verifyFixtureToken(validated.access_token, jwtSecret).session_id,
        };
      } catch (error) {
        const failure = new Error('fixture MFA refused');
        failure.auth_stage = stage;
        if (Number.isInteger(error?.auth_http_status))
          failure.auth_http_status = error.auth_http_status;
        throw failure;
      }
    },
  };
}

export async function assertLedgerAttributionIdentity(db) {
  const identity = await db.query(
    `SELECT current_database() = 'club_arena_qualification' AS owned_database,
      inet_server_addr() IS NULL AS local_socket, current_user = 'postgres' AS owner,
      (SELECT count(*)::integer FROM auth.users) AS users,
      (SELECT count(*)::integer FROM auth.users WHERE id=$1 AND email=$2
        AND role='authenticated' AND banned_until>now()+interval '1 day'
        AND last_sign_in_at IS NULL
        AND raw_user_meta_data->'component_qualification'='true'::jsonb
        AND raw_user_meta_data->>'fixture_purpose'=$3) AS attribution_users,
      (SELECT count(*)::integer FROM auth.sessions WHERE user_id=$1) AS sessions,
      (SELECT count(*)::integer FROM auth.refresh_tokens WHERE user_id=$1::text) AS refresh_tokens`,
    [LEDGER_ATTRIBUTION_ID, LEDGER_EMAIL, LEDGER_PURPOSE]
  );
  assert.deepEqual(
    identity.rows[0],
    {
      owned_database: true,
      local_socket: true,
      owner: true,
      users: 4,
      attribution_users: 1,
      sessions: 0,
      refresh_tokens: 0,
    },
    'FIXTURE_LEDGER_ATTRIBUTION_PERSISTENCE_REQUIRED'
  );
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
