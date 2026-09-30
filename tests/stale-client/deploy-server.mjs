/**
 * A LOCAL ORIGIN THAT CAN BE DEPLOYED TO WHILE A BROWSER HOLDS THE OLD BUILD
 * (Diamond Phase 11, line 7: old service workers and cached bundles).
 *
 * Serves two finished builds of this app (`npm run build:ci`, two different
 * VITE_SUPABASE_ANON_KEY values, so the entry chunk and every chunk that
 * imports it change name the way a real deploy does) under /hub/club-arena,
 * and swaps between them on request. It copies what production does, read on
 * 2026-09-30 from smarter.poker and .github/scripts/publish-origin-activate.sh:
 *
 *   - activation is atomic: one request sees the old shell or the new one;
 *   - the asset pool is APPEND-ONLY: after a deploy the old build's chunks are
 *     still served (pool=keep), and no URL ever changes bytes;
 *   - a chunk that does not exist is a real 404, never the HTML shell;
 *   - hashed assets are `public, max-age=31536000, immutable`, the shell and
 *     sw-bus.js are `no-cache, must-revalidate`, sw-bus.js carries
 *     `Service-Worker-Allowed: /hub/club-arena`, and the slash form of the base
 *     308s to the bare one.
 *
 * `pool=prune` is the case production never runs (old chunks gone): it proves
 * the client recovers rather than dying if that ever happens. `shellDelayMs`
 * slows the shell document so the service worker's 300ms freshness race is
 * lost and the cached old shell boots, which is the only way an old build can
 * start after a deploy.
 *
 * Control: GET /__deploy?to=a|b&pool=keep|prune&shellDelayMs=N, GET /__state,
 * GET /__log (asset requests since the last reset), GET /__log?reset=1.
 * Outside the base it stands in for the World Hub: /auth/login is a stub
 * sign-in page and every other path is a 404, as the six retired Diamond
 * pages are on production.
 *
 * Usage: node tests/stale-client/deploy-server.mjs <distA> <distB> [port]
 * (the port defaults to this runner's portFor(4610), as the config's does)
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { portFor } from '../../scripts/ci/e2e-port.mjs';

const [distA, distB, portArg] = process.argv.slice(2);
if (!distA || !distB) {
  console.error('usage: node deploy-server.mjs <distA> <distB> [port]');
  process.exit(2);
}
const PORT = Number(portArg) || portFor(4610);
const BASE = '/hub/club-arena';
const DIST = { a: distA, b: distB };
const state = { current: 'a', pool: ['a'], shellDelayMs: 0 };
let log = [];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function fileIn(dir, rel) {
  const full = normalize(join(dir, rel));
  if (!full.startsWith(normalize(dir))) return null;
  try {
    return existsSync(full) && statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendFile(res, path, cacheControl, extra = {}) {
  const type = TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
  send(res, 200, readFileSync(path), {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    ...extra,
  });
}

function shell(res) {
  const index = join(DIST[state.current], 'index.html');
  const go = () => sendFile(res, index, 'no-cache, must-revalidate');
  if (state.shellDelayMs > 0) setTimeout(go, state.shellDelayMs);
  else go();
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);

  if (path === '/__deploy') {
    const to = url.searchParams.get('to');
    if (to !== 'a' && to !== 'b') return send(res, 400, 'to must be a or b');
    const prune = url.searchParams.get('pool') === 'prune';
    state.pool = prune ? [to] : [...new Set([...state.pool, to])];
    state.current = to;
    state.shellDelayMs = Number(url.searchParams.get('shellDelayMs') || 0);
    return send(res, 200, JSON.stringify(state), { 'Content-Type': 'application/json' });
  }
  if (path === '/__state')
    return send(res, 200, JSON.stringify(state), { 'Content-Type': 'application/json' });
  if (path === '/__log') {
    const body = JSON.stringify(log);
    if (url.searchParams.get('reset') === '1') log = [];
    return send(res, 200, body, { 'Content-Type': 'application/json' });
  }

  if (path === `${BASE}/`) return send(res, 308, '', { Location: BASE + url.search });

  if (path === BASE || path.startsWith(`${BASE}/`)) {
    const rel = path.slice(BASE.length).replace(/^\/+/, '');
    if (rel === 'sw-bus.js') {
      const file = fileIn(DIST[state.current], rel);
      return sendFile(res, file, 'no-cache, must-revalidate', {
        'Service-Worker-Allowed': BASE,
      });
    }
    if (rel.startsWith('assets/') || rel.startsWith('fonts/')) {
      // Newest release first, then the append-only pool.
      for (const build of [state.current, ...state.pool.filter((b) => b !== state.current)]) {
        const file = fileIn(DIST[build], rel);
        if (file) {
          log.push({ path: rel, from: build, at: Date.now() });
          return sendFile(res, file, 'public, max-age=31536000, immutable');
        }
      }
      log.push({ path: rel, from: null, at: Date.now() });
      return send(res, 404, '404 Not Found', {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    }
    if (rel === '' || rel === 'index.html') return shell(res);
    const file = fileIn(DIST[state.current], rel);
    if (file) {
      const html = /\.(html|json|webmanifest|xml|txt)$/.test(rel);
      return sendFile(res, file, html ? 'no-cache, must-revalidate' : 'public, max-age=2592000');
    }
    return shell(res); // the SPA fallback every /hub/club-arena/* route gets
  }

  if (path === '/auth/login') {
    return send(
      res,
      200,
      '<!doctype html><title>Sign In</title><h1 data-stub="world-hub-login">World Hub Sign In (stub)</h1>',
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    );
  }
  return send(res, 404, '<!doctype html><title>404</title><h1 data-stub="world-hub-404">404</h1>', {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `stale-client deploy server on http://127.0.0.1:${PORT}${BASE} (a=${distA} b=${distB})`
  );
});
