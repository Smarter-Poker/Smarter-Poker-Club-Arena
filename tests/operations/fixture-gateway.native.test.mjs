import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import {
  createFixtureGateway,
  findPublicAnonKey,
  loadStaticManifest,
  validateSupabaseHost,
} from '../../operations/release/fixture/gateway.mjs';

const supabaseHost = 'abcdefghijklmnopqrst.supabase.co';
const publicAnonKey = [
  'eyJhbGciOiJIUzI1NiJ9',
  Buffer.from(
    JSON.stringify({
      role: 'anon',
      iss: 'supabase',
      ref: 'abcdefghijklmnopqrst',
    })
  ).toString('base64url'),
  'synthetic-public-signature',
].join('.');
const localAnonKey = 'synthetic-local-anon';
let directory, gateway, backend, ports, webPort, apiPort;
const requests = [];
const files = new Map([
  ['index.html', Buffer.from('<html>exact fixture</html>')],
  ['build-info.json', Buffer.from('{"ca_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')],
  ['assets/current.js', Buffer.from('window.exact = true;')],
]);

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'fixture-gateway-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=isolated-fixture.invalid',
      '-keyout',
      path.join(directory, 'key.pem'),
      '-out',
      path.join(directory, 'cert.pem'),
    ],
    { stdio: 'ignore', timeout: 15000 }
  );
  backend = http.createServer(async (req, res) => {
    const body = [];
    for await (const part of req) body.push(part);
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      apikey: req.headers.apikey,
      body: Buffer.concat(body).toString(),
    });
    res.writeHead(207, { 'content-type': 'application/json' });
    res.end('{"actual_local_service":true}');
  });
  backend.on('upgrade', (req, socket, head) => {
    requests.push({ path: req.url, authorization: req.headers.authorization, websocket: true });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
    if (head.length) socket.write(head);
    socket.on('data', (data) => socket.write(data));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  ports = Object.fromEntries(
    ['auth', 'rest', 'realtime', 'engine'].map((name) => [name, backend.address().port])
  );
  gateway = createFixtureGateway({
    supabaseHost,
    publicAnonKey,
    localAnonKey,
    files,
    ports,
    engineHost: '127.0.0.1',
    tls: {
      key: await readFile(path.join(directory, 'key.pem')),
      cert: await readFile(path.join(directory, 'cert.pem')),
    },
  });
  gateway.api.listen(0, '127.0.0.1');
  gateway.web.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.api, 'listening'), once(gateway.web, 'listening')]);
  apiPort = gateway.api.address().port;
  webPort = gateway.web.address().port;
});

after(async () => {
  for (const server of [gateway?.api, gateway?.web, backend]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
});

function request({
  host = supabaseHost,
  url = '/rest/v1/table_seats',
  secure = true,
  method = 'GET',
  headers = {},
  body = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        hostname: '127.0.0.1',
        port: secure ? webPort : apiPort,
        method,
        path: url,
        rejectUnauthorized: false,
        headers: { host, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (data) => chunks.push(data));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('hostname declaration refuses URLs, IPs, credentials, ports, paths and unrelated domains', () => {
  assert.equal(validateSupabaseHost(supabaseHost), supabaseHost);
  for (const input of [
    '127.0.0.1',
    `https://${supabaseHost}`,
    `${supabaseHost}:443`,
    `user@${supabaseHost}`,
    `${supabaseHost}/`,
    'metadata.internal',
    'A'.repeat(20) + '.supabase.co',
  ]) {
    assert.throws(() => validateSupabaseHost(input));
  }
});

test('only one exact public anonymous key for the declared project is accepted', () => {
  assert.equal(
    findPublicAnonKey([Buffer.from(`url=${supabaseHost};key=${publicAnonKey}`)], supabaseHost),
    publicAnonKey
  );
  assert.throws(() =>
    findPublicAnonKey(
      [Buffer.from(publicAnonKey.replace('synthetic-public-signature', ''))],
      supabaseHost
    )
  );
  assert.throws(() =>
    findPublicAnonKey([Buffer.from(publicAnonKey)], 'zzzzzzzzzzzzzzzzzzzz.supabase.co')
  );
  assert.throws(() =>
    findPublicAnonKey(
      [Buffer.from(supabaseHost + ' ' + publicAnonKey + ' ' + publicAnonKey + 'other')],
      supabaseHost
    )
  );
  const opaque = 'sb_publishable_synthetic_public_abcdefghijklmnopqrst';
  assert.equal(findPublicAnonKey([Buffer.from(supabaseHost + ' ' + opaque)], supabaseHost), opaque);
  assert.throws(() =>
    findPublicAnonKey(
      [Buffer.from(supabaseHost + ' ' + opaque + ' sb_secret_test_gateway')],
      supabaseHost
    )
  );
  assert.throws(() =>
    findPublicAnonKey(
      [Buffer.from(supabaseHost + ' ' + opaque + ' ' + publicAnonKey)],
      supabaseHost
    )
  );
});

test('HTTP proxy preserves the actual service status, body, method and query', async () => {
  const response = await request({
    url: '/rest/v1/table_seats?table_id=eq.fixture',
    method: 'POST',
    body: '{"fixture":true}',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(response.status, 207);
  assert.equal(response.body, '{"actual_local_service":true}');
  assert.equal(requests.at(-1).path, '/table_seats?table_id=eq.fixture');
  assert.equal(requests.at(-1).body, '{"fixture":true}');
});

test('only the compiled anonymous bearer maps to local anon; a user bearer is unchanged', async () => {
  await request({ headers: { authorization: `Bearer ${publicAnonKey}`, apikey: publicAnonKey } });
  assert.equal(requests.at(-1).authorization, `Bearer ${localAnonKey}`);
  assert.equal(requests.at(-1).apikey, undefined);
  await request({
    headers: { authorization: 'Bearer actual-local-user-token', apikey: publicAnonKey },
  });
  assert.equal(requests.at(-1).authorization, 'Bearer actual-local-user-token');
});

test('unknown hosts, external origins and proxy-form URLs cannot reach a backend', async () => {
  const count = requests.length;
  for (const options of [
    { host: 'example.com' },
    { host: '127.0.0.1' },
    { host: `${supabaseHost}:9999` },
    { url: 'http://example.com/rest/v1/seats' },
    { url: '//example.com/rest/v1/seats' },
    { headers: { origin: 'https://example.com' } },
  ]) {
    assert.equal((await request(options)).status, 421);
  }
  assert.equal(requests.length, count);
});

test('internal engine API still reaches real local auth and has no general proxy route', async () => {
  assert.equal(
    (await request({ host: 'fixture:8000', secure: false, url: '/auth/v1/user' })).status,
    207
  );
  assert.equal(requests.at(-1).path, '/user');
  assert.equal(
    (await request({ host: 'fixture:8000', secure: false, url: '/arbitrary' })).status,
    421
  );
});

test('exact frontend bytes and application navigation are served without a rebuild', async () => {
  assert.equal(
    (await request({ host: 'smarter.poker', url: '/hub/club-arena/assets/current.js' })).body,
    files.get('assets/current.js').toString()
  );
  const page = await request({
    host: 'smarter.poker',
    url: '/hub/club-arena/table/synthetic',
    headers: { accept: 'text/html' },
  });
  assert.equal(page.body, files.get('index.html').toString());
  assert.equal(
    (await request({ host: 'ca-static.smarter.poker', url: '/build-info.json' })).body,
    files.get('build-info.json').toString()
  );
});

test('missing chunks, traversal, arbitrary site routes and writes do not become HTML successes', async () => {
  for (const url of [
    '/hub/club-arena/assets/missing.js',
    '/hub/club-arena/missing.json',
    '/hub/club-arena/%2e%2e/private',
    '/hub/club-arena/..%2fsecret',
    '/hub/club-arena/%00',
    '/account',
  ]) {
    assert.equal(
      (await request({ host: 'smarter.poker', url, headers: { accept: 'text/html' } })).status,
      421
    );
  }
  assert.equal(
    (await request({ host: 'smarter.poker', url: '/hub/club-arena/index.html', method: 'POST' }))
      .status,
    405
  );
});

test('cross-origin browser preflight is local and preserves only the declared site', async () => {
  const count = requests.length;
  const response = await request({
    method: 'OPTIONS',
    headers: { origin: 'https://smarter.poker' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'https://smarter.poker');
  assert.equal(requests.length, count);
});

test('native engine websocket bytes cross the actual upgraded connection', async () => {
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port: webPort,
      path: '/ws/table/synthetic',
      rejectUnauthorized: false,
      headers: { host: 'engine.smarter.poker', connection: 'Upgrade', upgrade: 'websocket' },
    });
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      socket.on('error', reject);
      socket.once('data', (data) => {
        assert.equal(data.toString(), 'actual-wire-bytes');
        socket.destroy();
        resolve();
      });
      socket.write('actual-wire-bytes');
    });
    req.end();
  });
  assert.equal(requests.at(-1).path, '/ws/table/synthetic');
  assert.equal(requests.at(-1).websocket, true);
});

test('Supabase websocket route reaches the real Phoenix path and local anonymous key', async () => {
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port: webPort,
      path: '/realtime/v1/websocket?vsn=1.0.0&apikey=' + encodeURIComponent(publicAnonKey),
      rejectUnauthorized: false,
      headers: { host: supabaseHost, connection: 'Upgrade', upgrade: 'websocket' },
    });
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      socket.on('error', reject);
      socket.once('data', (data) => {
        assert.equal(data.toString(), 'phoenix-wire');
        socket.destroy();
        resolve();
      });
      socket.write('phoenix-wire');
    });
    req.end();
  });
  assert.equal(requests.at(-1).path, '/socket/websocket?vsn=1.0.0&apikey=' + localAnonKey);
});

test('public realtime HTTP preserves API path but never exposes tenant administration', async () => {
  assert.equal(
    (await request({ url: '/realtime/v1/api/broadcast', method: 'POST', body: '{}' })).status,
    207
  );
  assert.equal(requests.at(-1).path, '/api/broadcast');
  const count = requests.length;
  for (const url of [
    '/realtime/v1/api/tenants',
    '/realtime/v1/api/tenants/realtime-dev',
    '/realtime/v1/api/openapi',
  ]) {
    assert.equal((await request({ url })).status, 403);
  }
  assert.equal((await request({ url: '/realtime/v1/api/%74enants' })).status, 421);
  assert.equal(requests.length, count);
});

test('static manifest verification refuses changed bytes and symlinks', async () => {
  const root = path.join(directory, 'static');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  const documents = new Map([
    ['index.html', Buffer.from('exact')],
    ['build-info.json', Buffer.from('{}')],
  ]);
  for (const [name, body] of documents) await writeFile(path.join(root, name), body);
  const manifest =
    [...documents]
      .map(([name, body]) => `${createHash('sha256').update(body).digest('hex')}  ${name}`)
      .join('\n') + '\n';
  await writeFile(path.join(root, '.release-manifest.sha256'), manifest);
  assert.deepEqual(await loadStaticManifest(root), documents);
  await writeFile(path.join(root, 'index.html'), 'changed');
  await assert.rejects(loadStaticManifest(root));
  await rm(path.join(root, 'index.html'));
  await writeFile(path.join(directory, 'outside.html'), 'exact');
  await symlink(path.join(directory, 'outside.html'), path.join(root, 'index.html'));
  await assert.rejects(loadStaticManifest(root));
});
