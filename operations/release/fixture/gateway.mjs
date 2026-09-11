import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const publicHosts = new Set(['smarter.poker', 'ca-static.smarter.poker', 'engine.smarter.poker']);
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export function validateSupabaseHost(host) {
  assert.equal(typeof host, 'string');
  assert.match(host, /^[a-z0-9]{20}\.supabase\.co$/);
  return host;
}

// The compiled public anonymous key is a routing input, never a fixture
// credential. Only that exact public key can map to the disposable anonymous
// role. Authenticated bearer tokens still pass to real local GoTrue/PostgREST.
export function findPublicAnonKey(buffers, host) {
  validateSupabaseHost(host);
  assert.ok(
    buffers.some((buffer) => buffer.includes(host)),
    'compiled Supabase hostname is required'
  );
  const matches = new Set();
  for (const buffer of buffers) {
    assert.ok(
      !/sb_secret_[A-Za-z0-9_-]+/.test(buffer.toString('utf8')),
      'secret keys cannot be bundle inputs'
    );
    for (const token of buffer.toString('utf8').matchAll(/sb_publishable_[A-Za-z0-9_-]{20,200}/g)) {
      matches.add(token[0]);
    }
    for (const token of buffer
      .toString('utf8')
      .matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
      try {
        const claims = JSON.parse(
          Buffer.from(token[0].split('.')[1], 'base64url').toString('utf8')
        );
        if (
          claims.role === 'anon' &&
          claims.iss === 'supabase' &&
          claims.ref === host.split('.')[0]
        ) {
          matches.add(token[0]);
        }
      } catch {
        /* An arbitrary asset string is not an anonymous JWT. */
      }
    }
  }
  assert.equal(matches.size, 1, 'one compiled anonymous project key is required');
  return [...matches][0];
}

export async function loadStaticManifest(root) {
  const manifest = await readFile(path.join(root, '.release-manifest.sha256'), 'utf8');
  const files = new Map();
  for (const line of manifest.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  (?:\.\/)?(.+)$/.exec(line);
    assert.ok(match, 'invalid static manifest');
    const [, digest, name] = match;
    assert.ok(
      name &&
        !name.startsWith('/') &&
        !name.includes('\\') &&
        !name.split('/').some((part) => !part || part === '.' || part === '..')
    );
    assert.ok(!files.has(name));
    // Extraction is separately confined by the native driver. Reject symlinks
    // again here and retain the checked bytes, so a later rename cannot swap
    // the payload between verification and serving.
    const absolute = path.join(root, name);
    assert.ok((await lstat(absolute)).isFile());
    const bytes = await readFile(absolute);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    files.set(name, bytes);
  }
  assert.ok(files.has('index.html') && files.has('build-info.json'));
  return files;
}

function requestHost(value, secure) {
  if (typeof value !== 'string' || value.length > 150) return null;
  const match = /^([a-z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match || (match[2] && match[2] !== (secure ? '443' : '8000'))) return null;
  return match[1];
}

function reject(res, code) {
  res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end('Fixture request refused');
}

function cleanHeaders(original, publicAnonKey, localAnonKey, websocket = false) {
  const headers = Object.fromEntries(
    Object.entries(original).filter(
      ([name]) => !hopHeaders.has(name) && name !== 'forwarded' && !name.startsWith('x-forwarded-')
    )
  );
  // Never forward an external API key to a disposable service. The local
  // gateway does not authenticate users; the actual signed bearer does.
  delete headers.apikey;
  if (headers.authorization === `Bearer ${publicAnonKey}`)
    headers.authorization = `Bearer ${localAnonKey}`;
  if (!headers.authorization) headers.authorization = `Bearer ${localAnonKey}`;
  if (websocket) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  return headers;
}

export function createFixtureGateway({
  supabaseHost,
  publicAnonKey,
  localAnonKey,
  files,
  tls,
  onFailure = () => {},
  ports = { auth: 9999, rest: 3000, realtime: 4000, engine: 8080 },
  engineHost = 'engine',
}) {
  validateSupabaseHost(supabaseHost);
  assert.ok(typeof publicAnonKey === 'string' && typeof localAnonKey === 'string');
  assert.ok(files instanceof Map && files.has('index.html') && files.has('build-info.json'));
  assert.deepEqual(Object.keys(ports).sort(), ['auth', 'engine', 'realtime', 'rest']);
  for (const port of Object.values(ports))
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  // The loopback variant supports native boundary tests. No user supplied
  // origin, URL, port redirect, Host header or DNS answer selects a backend.
  assert.ok(engineHost === 'engine' || engineHost === '127.0.0.1');

  function route(req, secure) {
    const host = requestHost(req.headers.host, secure);
    if (
      !host ||
      !(publicHosts.has(host) || host === supabaseHost || (!secure && host === 'fixture'))
    )
      return null;
    if (secure && req.socket.servername && req.socket.servername !== host) return null;
    if (
      !req.url?.startsWith('/') ||
      req.url.startsWith('//') ||
      req.url.includes('\\') ||
      req.url.length > 8192
    )
      return null;
    let url;
    try {
      url = new URL(req.url, 'http://fixture');
    } catch {
      return null;
    }
    if (host === 'engine.smarter.poker') return { backend: 'engine', url: req.url };
    if (host === supabaseHost || host === 'fixture') {
      const prefixes = [
        ['/auth/v1/', 'auth'],
        ['/rest/v1/', 'rest'],
        ['/realtime/v1/', 'realtime'],
      ];
      for (const [prefix, backend] of prefixes) {
        if (url.pathname.startsWith(prefix)) {
          let suffix = url.pathname.slice(prefix.length - 1);
          // Supabase Realtime receives the local API key as a query parameter;
          // only the exact compiled public key is translated. Real user JWTs
          // in the wire protocol are handled by the actual realtime service.
          if (backend === 'realtime' && url.searchParams.get('apikey') === publicAnonKey) {
            url.searchParams.set('apikey', localAnonKey);
          }
          if (backend === 'realtime') {
            // Match the genuine Supabase gateway contract: websocket traffic
            // goes to Phoenix /socket/*; public HTTP API retains /api/*.
            // Tenant administration exposes service material and is not a
            // player API. Do not forward it, even with an anonymous JWT.
            if (suffix.includes('%')) return null;
            if (/^\/api\/(tenants|openapi)(?:\/|$)/.test(suffix)) return { refused: 403 };
            if (suffix === '/websocket' || suffix === '/longpoll') suffix = '/socket' + suffix;
            else if (!suffix.startsWith('/api/')) return null;
          }
          return { backend, url: suffix + url.search };
        }
      }
      return null;
    }
    let name;
    try {
      name = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    const prefix = '/hub/club-arena/';
    if (host === 'smarter.poker') {
      if (!name.startsWith(prefix)) return null;
      name = name.slice(prefix.length);
    } else name = name.slice(1);
    if (
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => part === '..' || part === '.')
    )
      return null;
    if (!name) name = 'index.html';
    if (!files.has(name)) {
      // Only real application route navigation gets the SPA document. Missing
      // chunks, images and data never receive an HTML success response.
      if (
        !req.headers.accept?.includes('text/html') ||
        path.extname(name) ||
        name.startsWith('assets/')
      )
        return null;
      name = 'index.html';
    }
    return { file: name };
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== 'https://smarter.poker' &&
      origin !== 'https://ca-static.smarter.poker'
    )
      return false;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader(
        'access-control-allow-headers',
        'authorization,apikey,content-type,x-client-info,prefer,range,x-supabase-api-version,x-supabase-client-platform,x-supabase-client-platform-version'
      );
      res.setHeader('access-control-expose-headers', 'content-range');
    }
    return true;
  }

  function handle(secure) {
    return (req, res) => {
      const selected = route(req, secure);
      if (!selected || !cors(req, res)) return reject(res, 421);
      if (selected.refused) return reject(res, selected.refused);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (selected.file) {
        if (!['GET', 'HEAD'].includes(req.method)) return reject(res, 405);
        const bytes = files.get(selected.file);
        res.writeHead(200, {
          'content-type': contentTypes[path.extname(selected.file)] || 'application/octet-stream',
          'content-length': bytes.length,
          'cache-control': 'no-store',
        });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const proxy = http.request(
        {
          hostname: selected.backend === 'engine' ? engineHost : '127.0.0.1',
          port: ports[selected.backend],
          path: selected.url,
          method: req.method,
          headers: {
            ...cleanHeaders(req.headers, publicAnonKey, localAnonKey),
            ...(selected.backend === 'realtime' ? { host: 'realtime-dev.supabase-realtime' } : {}),
          },
          timeout: 15000,
        },
        (upstream) => {
          const headers = Object.fromEntries(
            Object.entries(upstream.headers).filter(
              ([name]) => !hopHeaders.has(name) && !name.startsWith('access-control-')
            )
          );
          res.writeHead(upstream.statusCode, headers);
          upstream.pipe(res);
        }
      );
      proxy.on('timeout', () => proxy.destroy());
      proxy.on('error', () => {
        if (!res.headersSent) reject(res, 502);
        else res.destroy();
      });
      req.on('aborted', () => proxy.destroy());
      res.on('close', () => {
        if (!res.writableFinished) proxy.destroy();
      });
      req.pipe(proxy);
    };
  }

  function upgrade(secure) {
    return (req, socket, head) => {
      const selected = route(req, secure);
      if (
        !selected?.backend ||
        !['engine', 'realtime'].includes(selected.backend) ||
        (req.headers.origin &&
          !['https://smarter.poker', 'https://ca-static.smarter.poker'].includes(
            req.headers.origin
          )) ||
        req.headers.upgrade?.toLowerCase() !== 'websocket'
      )
        return socket.destroy();
      const proxy = http.request({
        hostname: selected.backend === 'engine' ? engineHost : '127.0.0.1',
        port: ports[selected.backend],
        path: selected.url,
        method: 'GET',
        headers: {
          ...cleanHeaders(req.headers, publicAnonKey, localAnonKey, true),
          ...(selected.backend === 'realtime' ? { host: 'realtime-dev.supabase-realtime' } : {}),
        },
        timeout: 15000,
      });
      proxy.on('upgrade', (response, upstream, upstreamHead) => {
        let headers = `HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`;
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          headers += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
        socket.write(headers + '\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstream.write(head);
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        socket.pipe(upstream).pipe(socket);
      });
      proxy.on('response', (response) => {
        response.resume();
        socket.destroy();
      });
      proxy.on('timeout', () => proxy.destroy());
      proxy.on('error', () => socket.destroy());
      socket.on('close', () => proxy.destroy());
      proxy.end();
    };
  }

  const api = http.createServer(handle(false));
  api.on('upgrade', upgrade(false));
  const web = https.createServer(tls, handle(true));
  web.on('upgrade', upgrade(true));
  const sockets = new Set();
  for (const server of [api, web]) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('error', onFailure);
  }
  return {
    api,
    web,
    async listen() {
      for (const [server, port] of [
        [api, 8000],
        [web, 443],
      ]) {
        await new Promise((resolve, reject) => {
          const failed = (error) => {
            server.removeListener('listening', ready);
            reject(error);
          };
          const ready = () => {
            server.removeListener('error', failed);
            resolve();
          };
          server.once('error', failed);
          server.once('listening', ready);
          server.listen(port, '0.0.0.0');
        });
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [api, web].map((server) => new Promise((resolve) => server.close(() => resolve())))
      );
    },
  };
}
