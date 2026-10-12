/**
 * Serves the push opt-in browser harness on one origin, as smarter.poker does:
 *   /hub/club-arena/            the harness page (real Club Arena modules)
 *   /push/sw.js                 a push worker at the shared /push/ scope
 *   /api/push/vapid-public-key  a freshly generated P-256 application key
 *   /api/push/subscribe         records every enrollment request
 *   /__harness/requests         what the page sent, for the spec to assert
 *
 * Usage: node tests/push-browser/harnessServer.mjs <port>
 */
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = Number(process.argv[2] || 5197);

const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
const VAPID_PUBLIC_KEY = raw.toString('base64url');

const bundle = await build({
  entryPoints: [join(HERE, 'harnessEntry.tsx')],
  bundle: true,
  write: false,
  outdir: '/harness-out',
  format: 'esm',
  jsx: 'automatic',
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  plugins: [
    {
      name: 'harness-auth',
      setup(b) {
        b.onResolve({ filter: /hooks\/useAuthUser$/ }, () => ({ path: join(HERE, 'harnessAuth.ts') }));
      },
    },
  ],
  logLevel: 'error',
});
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))?.text || '';

const WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => e.waitUntil(self.registration.showNotification('Harness')));`;

const requests = [];
const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/hub/club-arena/' || url.pathname === '/hub/club-arena/index.html') {
    return send(res, 200, 'text/html', `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Push Harness</title>
<link rel="stylesheet" href="/hub/club-arena/harness.css"></head>
<body><div id="root"></div><script type="module" src="/hub/club-arena/harness.js"></script></body></html>`);
  }
  if (url.pathname === '/hub/club-arena/harness.js') return send(res, 200, 'text/javascript', js);
  if (url.pathname === '/hub/club-arena/harness.css') return send(res, 200, 'text/css', css);
  if (url.pathname === '/push/sw.js') return send(res, 200, 'text/javascript', WORKER);
  if (url.pathname === '/api/push/vapid-public-key') {
    return send(res, 200, 'application/json', JSON.stringify({ key: VAPID_PUBLIC_KEY }));
  }
  if (url.pathname === '/api/push/subscribe') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
      send(res, 200, 'application/json', JSON.stringify({ ok: true, subscribed: req.method === 'POST' }));
    });
    return undefined;
  }
  if (url.pathname === '/__harness/requests') return send(res, 200, 'application/json', JSON.stringify(requests));
  if (url.pathname === '/__harness/key') return send(res, 200, 'application/json', JSON.stringify({ key: VAPID_PUBLIC_KEY }));
  return send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`push harness on http://127.0.0.1:${PORT}/hub/club-arena/`));
