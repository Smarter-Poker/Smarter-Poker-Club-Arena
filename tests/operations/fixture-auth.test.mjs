import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { nativeFailureDiagnostic } from '../../operations/release/fixture/runtime-files.mjs';
import {
  assertFixtureAuthVersion,
  browserStorage,
  fixtureAuth,
  fixtureSecrets,
  issueFixtureToken,
  LEDGER_ATTRIBUTION_ID,
  totp,
  verifyFixtureToken,
} from '../../operations/release/fixture/auth-fixture.mjs';

for (const fault of ['none', 'missing-ban', 'wrong-id', 'wrong-refusal', 'session-issued']) {
  test(`ledger attribution uses Auth and requires a banned login (${fault})`, async () => {
    let created;
    let loginAttempts = 0;
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      if (request.url === '/admin/users') {
        assert.equal(input.id, LEDGER_ATTRIBUTION_ID);
        assert.ok(input.email.endsWith('@smarter-poker.invalid'));
        assert.equal(Object.hasOwn(input, 'password'), false);
        assert.equal(input.ban_duration, '876000h');
        created = input;
        response.end(
          JSON.stringify({
            ...input,
            id: fault === 'wrong-id' ? randomUUID() : input.id,
            banned_until: fault === 'missing-ban' ? null : '2126-01-01T00:00:00Z',
          })
        );
      } else {
        assert.equal(request.url, '/token?grant_type=password');
        assert.equal(input.email, created.email);
        loginAttempts++;
        response.statusCode = fault === 'session-issued' ? 200 : 400;
        response.end(
          JSON.stringify(
            fault === 'session-issued'
              ? { access_token: 'PRIVATE_UNEXPECTED_TOKEN' }
              : { error_code: fault === 'wrong-refusal' ? 'invalid_credentials' : 'user_banned' }
          )
        );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const api = fixtureAuth({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        ...fixtureSecrets(),
      });
      if (fault === 'none')
        assert.equal(await api.createLedgerAttributionIdentity(), LEDGER_ATTRIBUTION_ID);
      else
        await assert.rejects(api.createLedgerAttributionIdentity(), (error) => {
          assert.match(error.message, /^FIXTURE_LEDGER_/);
          assert.ok(!String(error.stack).includes('PRIVATE_UNEXPECTED_TOKEN'));
          return true;
        });
      assert.equal(loginAttempts, ['missing-ban', 'wrong-id'].includes(fault) ? 0 : 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

for (const missingSession of [false, true]) {
  test(`real HTTP sign-in ${missingSession ? 'refuses an absent' : 'retains the signed'} session identity`, async () => {
    const secrets = fixtureSecrets();
    const users = new Map();
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      if (request.url === '/admin/users') {
        assert.ok(input.user_metadata.poker_alias.length <= 15);
        assert.ok(
          ['actor_one', 'actor_two', 'spectator'].includes(input.user_metadata.poker_alias)
        );
        const user = { id: randomUUID(), email: input.email };
        users.set(input.email, { user, sessionId: randomUUID() });
        response.end(JSON.stringify(user));
      } else {
        const { user, sessionId } = users.get(input.email);
        const claims = {
          sub: user.id,
          role: 'authenticated',
          aal: 'aal1',
          exp: Math.floor(Date.now() / 1000) + 300,
          ...(missingSession ? {} : { session_id: sessionId }),
        };
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
        const token = `${body}.${createHmac('sha256', secrets.jwtSecret).update(body).digest('base64url')}`;
        response.end(JSON.stringify({ user, access_token: token, refresh_token: 'local-probe' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const api = fixtureAuth({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        ...secrets,
      });
      if (missingSession) await assert.rejects(api.createUsers());
      else {
        const actual = await api.createUsers();
        assert.equal(actual.length, 3);
        for (const user of actual) {
          assert.match(
            user.email,
            /^component-(actor-one|actor-two|spectator)@smarter-poker\.invalid$/
          );
          assert.equal(user.sessionId, users.get(user.email).sessionId);
          assert.equal(
            user.sessionId,
            verifyFixtureToken(user.session.access_token, secrets.jwtSecret).session_id
          );
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

for (const [status, payload, expected] of [
  [403, { message: 'PRIVATE SERVICE VALUE' }, { auth_stage: 'mfa-enroll', auth_http_status: 403 }],
  [200, { id: 'PRIVATE FACTOR VALUE' }, { auth_stage: 'mfa-factor-id' }],
]) {
  test(`native HTTP ${status} MFA failure exposes only the fixed step and status`, async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const secret = fixtureSecrets();
      const api = fixtureAuth({ endpoint: `http://127.0.0.1:${server.address().port}`, ...secret });
      await assert.rejects(
        api.enrollMfa({
          id: '90000000-0000-4000-8000-000000000001',
          session: { access_token: 'PRIVATE ACCESS TOKEN' },
        }),
        (error) => {
          assert.deepEqual(nativeFailureDiagnostic('gotrue-real-mfa-enrollment', error), {
            status: 'failed',
            stage: 'gotrue-real-mfa-enrollment',
            error: 'Error',
            ...expected,
          });
          assert.ok(!String(error.stack).includes('PRIVATE'));
          return true;
        }
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('accepts the pinned native GoTrue version output and refuses changed binaries', () => {
  // Captured from the actual successful Linux image build at 799eebf49d.
  const nativeVersion = 'v2.196.0\n';
  assert.equal(/\b2\.196\.0\b/.test(nativeVersion), false);
  assert.doesNotThrow(() => assertFixtureAuthVersion(nativeVersion));
  for (const changed of ['v2.196.1', 'v2.196.01', 'v2.196.0-dev', 'v2.196.0\nv2.197.0', '']) {
    assert.throws(() => assertFixtureAuthVersion(changed));
  }
});

test('a large MFA QR response reaches challenge and verification while other Auth responses stay bounded', async () => {
  const id = '90000000-0000-4000-8000-000000000001';
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    request.resume();
    let status = 200;
    let data;
    if (request.url === '/factors')
      data = {
        id,
        totp: {
          secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          qr_code: '<svg>' + ' '.repeat(200 * 1024) + '</svg>',
        },
      };
    else if (request.url.endsWith('/challenge')) data = { id };
    else if (request.url.endsWith('/verify')) {
      status = 403;
      data = { message: 'PRIVATE' };
    } else data = { padding: ' '.repeat(200 * 1024) };
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = fixtureAuth({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      ...fixtureSecrets(),
    });
    await assert.rejects(api.enrollMfa({ id, session: { access_token: 'PRIVATE' } }), (error) => {
      assert.equal(error.auth_stage, 'mfa-verify');
      assert.equal(error.auth_http_status, 403);
      return true;
    });
    assert.deepEqual(seen, ['/factors', `/factors/${id}/challenge`, `/factors/${id}/verify`]);
    await assert.rejects(api.createUsers(), /local auth response too large/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an oversized chunked enrollment is cancelled before the server finishes sending', async () => {
  let chunks = 0;
  let stopped;
  const closed = new Promise((resolve) => {
    stopped = resolve;
  });
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => {
      chunks++;
      response.write(' '.repeat(32 * 1024));
      if (chunks === 100) {
        clearInterval(timer);
        response.end();
      }
    }, 2);
    response.on('close', () => {
      clearInterval(timer);
      stopped();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = fixtureAuth({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      ...fixtureSecrets(),
    });
    await assert.rejects(
      api.enrollMfa({
        id: '90000000-0000-4000-8000-000000000001',
        session: { access_token: 'PRIVATE' },
      }),
      (error) => error.auth_stage === 'mfa-enroll'
    );
    await closed;
    assert.ok(
      chunks >= 33 && chunks < 100,
      'the bounded reader must cancel an unfinished response'
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a version command keeps its stdout protocol separate from shutdown diagnostics', async () => {
  // Pinned version_cmd.go prints stdout; main.go separately logs cancellation.
  const result = await promisify(execFile)(process.execPath, [
    '-e',
    'process.stdout.write("v2.196.0\\n");process.stderr.write("received graceful shutdown signal\\n")',
  ]);
  assert.doesNotThrow(() => assertFixtureAuthVersion(result.stdout));
  assert.throws(() => assertFixtureAuthVersion(result.stdout + result.stderr));
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
