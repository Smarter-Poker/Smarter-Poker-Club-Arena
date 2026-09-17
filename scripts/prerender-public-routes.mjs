/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  prerender-public-routes - the public arena, readable without JavaScript
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO PHASE 1 (2026-09-17). Club Arena is a Vite SPA. The origin serves one
 * index.html whose body is `<div id="root"></div>`; every word of every page
 * exists only after the bundle runs. Googlebot renders JavaScript. The
 * crawlers that decide what ChatGPT, Claude, Perplexity and Meta AI can cite
 * (OAI-SearchBot, Claude-SearchBot, PerplexityBot, meta-webindexer) do not,
 * and Bing does not at scale. To all of them the arena was an empty div.
 *
 * This runs once at the end of build:ci, on the web build only:
 *
 *   1. builds src/prerender/entry-server.tsx with vite.prerender.config.ts
 *      into dist-prerender/ (scratch, gitignored, never published);
 *   2. renders each PUBLIC route (the ones src/lib/seo.ts marks indexable:
 *      landing, Help Center, Legal Center and the four legal documents) to
 *      static HTML with react-dom/server;
 *   3. takes the finished dist/index.html as the shell (after self-host-fonts
 *      and the service-worker precache injection, so every prerendered page
 *      carries the same head as the app), swaps in the route's title,
 *      description, canonical, robots, Open Graph and JSON-LD from seo.ts,
 *      inlines the page CSS, and writes the markup into #root;
 *   4. writes `/` back to dist/index.html and every other route to
 *      dist/<route>/index.html, plus dist/prerender-manifest.json;
 *   5. verifies every output carries its heading and its title, and fails the
 *      build if one does not. A broken prerender is a broken build, not a
 *      silently empty page.
 *
 * WHO SERVES WHAT. The origin's Caddy rewrites every extension-less path to
 * /index.html, so dist/help/index.html is reached only through an explicit
 * World Hub rewrite of /hub/club-arena/help to /help/index.html (World Hub
 * next.config.js, AEO phase 1). Until that rewrite ships the files sit
 * unused, which is the safe order: the rewrite must never point at a file
 * that a release does not contain.
 *
 * THE LANDING PAGE, THE SIGNED-IN PLAYER AND THE DEEP LINK. dist/index.html
 * is the shell for EVERY route, so the landing markup would flash on every
 * cold load of the app before React mounts: for a signed-in player at the
 * root, and for anyone opening a deep route (/health, a shared hand, a
 * table). The prerendered landing is therefore wrapped in a block that one
 * inline script removes before first paint unless the path IS the arena
 * root and no shared Supabase session (localStorage smarter-poker-auth) is
 * present. A signed-out visitor at the root, and every crawler, keeps it;
 * the bundle then replaces it with the real React tree (main.tsx uses
 * createRoot), the same component in the same stylesheet, so nothing moves.
 * Measured: without the path test the /health route scored CLS 0.234 on
 * mobile in scripts/ci/route-performance.mjs; with it, the block is gone
 * before layout.
 *
 * At runtime nothing changes for the app: the prerender is what a reader
 * gets before, or without, JavaScript.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('../', import.meta.url).pathname);
const DIST = path.resolve(ROOT, process.env.CA_DIST || 'dist');
const PRERENDER_OUT = path.resolve(ROOT, 'dist-prerender');
const WEB_BASE = '/hub/club-arena';
const SESSION_STORAGE_KEY = 'smarter-poker-auth';

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace one tag matched by `pattern` with `replacement`; throw if absent. */
function replaceOnce(html, pattern, replacement, what) {
  if (!pattern.test(html)) throw new Error(`prerender: shell index.html has no ${what}`);
  return html.replace(pattern, replacement);
}

function setMeta(html, attr, name, content) {
  const pattern = new RegExp(`<meta\\s+${attr}="${name}"[^>]*>`, 'i');
  const tag = `<meta ${attr}="${name}" content="${escapeAttr(content)}" />`;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace('</head>', `  ${tag}\n</head>`);
}

export function jsonLdDocument(jsonLd) {
  if (Array.isArray(jsonLd)) return { '@context': 'https://schema.org', '@graph': jsonLd };
  return { '@context': 'https://schema.org', ...jsonLd };
}


/**
 * THE FONTS ARE KNOWN AT FIRST PAINT, AND DECLARED ONCE (2026-09-17).
 * fonts-<hash>.css was loaded async (media=print swap trick), so the
 * prerendered words painted in Georgia and system-ui and then jumped when
 * Cinzel and Inter arrived: measured CLS 0.061 on a phone. The first cut
 * inlined only the latin faces and kept the async stylesheet; when that
 * stylesheet landed it declared the same faces a second time, the browser
 * took the later declarations, which were not loaded yet, and every word
 * swapped to a fallback and back: measured CLS 0.121, two shifts, both after
 * the app had drawn. So the whole self-hosted stylesheet is inlined into the
 * head IN PLACE of the async link and its noscript twin, and the latin woff2
 * files of the two families the public pages use are preloaded. One
 * declaration per face, present before first paint, no second request.
 * Best effort: no fonts stylesheet in dist/fonts, no change.
 */
const PRERENDER_FONT_FAMILIES = ['Cinzel', 'Inter'];

/** The woff2 URLs of the latin faces of the families the public pages use. */
export function latinFontUrls(fontsCss) {
  const urls = new Set();
  for (const m of fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const family = /font-family:\s*'?([^;']+)'?/.exec(body)?.[1]?.trim();
    const range = /unicode-range:\s*([^;]+)/.exec(body)?.[1] || '';
    const url = /url\(([^)]+)\)/.exec(body)?.[1];
    if (!family || !url || !PRERENDER_FONT_FAMILIES.includes(family)) continue;
    if (!/U\+0000-00FF/i.test(range)) continue;
    urls.add(url);
  }
  return [...urls];
}

function readFonts() {
  const dir = path.join(DIST, 'fonts');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => /^fonts-[a-f0-9]+\.css$/.test(f));
  if (!file) return null;
  const css = readFileSync(path.join(dir, file), 'utf8');
  return { file, css: css.replace(/\/\*[^*]*\*\//g, '').replace(/\s+/g, ' ').trim(), urls: latinFontUrls(css) };
}

export function fontHeadMarkup(fonts) {
  if (!fonts || !fonts.css) return '';
  const preloads = fonts.urls
    .map((u) => `  <link rel="preload" href="${escapeAttr(u)}" as="font" type="font/woff2" crossorigin />`)
    .join('\n');
  return `${preloads}\n  <style data-prerender="fonts">${fonts.css}</style>\n`;
}

/**
 * Replace the async stylesheet link (and its noscript twin) for `file` with
 * `markup`, at the same place in the head, so the cascade order is unchanged.
 * Throws if the shell does not reference the file: the prerender must never
 * leave the faces declared twice.
 */
export function replaceFontStylesheet(shell, file, markup) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const asyncLink = new RegExp(`<link\\s+href="[^"]*${escaped}"\\s+rel="stylesheet"\\s+media="print"[^>]*>`);
  const noscript = new RegExp(`\\s*<noscript>\\s*<link\\s+href="[^"]*${escaped}"\\s+rel="stylesheet"\\s*/?>\\s*</noscript>`);
  if (!asyncLink.test(shell)) throw new Error(`prerender: shell index.html has no async link to ${file}`);
  return shell.replace(asyncLink, markup.trim()).replace(noscript, '');
}

/** Build one route's HTML document from the shell and the rendered page. */
export function composeDocument({ shell, page, css, fonts = null }) {
  const { seo, html: body, path: route } = page;
  const title = seo.title.includes('Smarter.Poker') ? seo.title : `${seo.title} | Smarter.Poker`;
  const canonical = `https://smarter.poker${WEB_BASE}${route === '/' ? '' : route}`;
  const robots = seo.index
    ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
    : 'noindex, nofollow';

  let doc = shell;
  doc = replaceOnce(doc, /<title>[^<]*<\/title>/i, `<title>${escapeText(title)}</title>`, '<title>');
  doc = setMeta(doc, 'name', 'description', seo.description);
  doc = setMeta(doc, 'name', 'robots', robots);
  doc = replaceOnce(
    doc,
    /<link\s+rel="canonical"[^>]*>/i,
    `<link rel="canonical" href="${escapeAttr(canonical)}" />`,
    'canonical link',
  );
  doc = setMeta(doc, 'property', 'og:title', title);
  doc = setMeta(doc, 'property', 'og:description', seo.description);
  doc = setMeta(doc, 'property', 'og:url', canonical);
  doc = setMeta(doc, 'name', 'twitter:title', title);
  doc = setMeta(doc, 'name', 'twitter:description', seo.description);

  const ld = `<script type="application/ld+json">${JSON.stringify(jsonLdDocument(seo.jsonLd || {}))}</script>`;
  doc = replaceOnce(
    doc,
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/i,
    ld,
    'JSON-LD block',
  );

  const fontMarkup = fontHeadMarkup(fonts);
  if (fontMarkup) {
    doc = replaceFontStylesheet(doc, fonts.file, fontMarkup);
  }
  if (css) {
    doc = doc.replace('</head>', `  <style data-prerender="css">${css}</style>\n</head>`);
  }

  const rootPattern = /<div id="root"><\/div>/;
  if (!rootPattern.test(doc)) throw new Error('prerender: shell index.html has no empty #root');
  if (route === '/') {
    // THE LANDING STAYS ON SCREEN UNTIL THE APP HAS DRAWN ITS OWN (2026-09-17).
    // Inside #root the block was the first thing createRoot threw away, so a
    // signed-out visitor saw the words, then a loading state, then the same
    // words again: measured live, CLS 0.18 on a phone. The block now sits
    // BEFORE #root as a sibling; #root is display:none while the block exists;
    // the inline script removes the block before first paint for a signed-in
    // player or a deep route; otherwise src/main.tsx removes it the moment the
    // React tree has an h1 (the landing page or the lobby), so the swap is
    // between two identical layouts. If the bundle never boots, the words stay.
    const landing =
      `<style data-prerender="landing">body:has(#prerender-landing) #root{display:none}</style>` +
      `<div id="prerender-landing" data-prerender="landing">${body}</div>` +
      `<script>try{var l=location.pathname.replace(/\\/+$/,"");var s=window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)});if(s||(l!==${JSON.stringify(WEB_BASE)}&&l!=="")){var p=document.getElementById("prerender-landing");if(p)p.remove()}}catch(e){}</script>` +
      `<div id="root"></div>`;
    doc = doc.replace(rootPattern, landing);
  } else {
    doc = doc.replace(rootPattern, `<div id="root"><div data-prerender="${escapeAttr(route)}">${body}</div></div>`);
  }
  return doc;
}

function buildPrerenderBundle() {
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build', '--config', 'vite.prerender.config.ts', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_NATIVE: '' },
  });
}

function readPrerenderCss() {
  const assets = path.join(PRERENDER_OUT, 'assets');
  if (!existsSync(assets)) return '';
  return readdirSync(assets)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => readFileSync(path.join(assets, f), 'utf8'))
    .join('\n');
}

function outputPathFor(route) {
  return route === '/' ? path.join(DIST, 'index.html') : path.join(DIST, route.replace(/^\//, ''), 'index.html');
}

/** What a reader must find in each prerendered page for the build to pass. */
export function verifyDocument(route, doc) {
  const problems = [];
  if (!/<h1[\s>]/i.test(doc)) problems.push('no <h1>');
  // The landing block sits before #root; every other route's markup is inside it.
  const landingStart = doc.indexOf('<div id="prerender-landing"');
  const rootStart = doc.indexOf('<div id="root">');
  const bodyStart = landingStart === -1 ? rootStart : Math.min(landingStart, rootStart);
  const text = doc.slice(bodyStart).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 120) problems.push(`only ${words} words of readable text`);
  if (!/<meta name="robots" content="index, follow/i.test(doc)) problems.push('not indexable');
  if (!/<link rel="canonical" href="https:\/\/smarter\.poker\/hub\/club-arena/i.test(doc)) problems.push('no canonical');
  const headWithoutComments = doc.slice(0, bodyStart).replace(/<!--[\s\S]*?-->/g, '');
  if (/<meta[^>]+content="[^"]*noindex/i.test(headWithoutComments)) problems.push('head says noindex');
  if (problems.length) throw new Error(`prerender: ${route} failed verification: ${problems.join('; ')}`);
  return words;
}

async function main() {
  if (process.env.VITE_NATIVE === '1') {
    console.log('[prerender] native build: nothing to prerender (the shell is the app inside the native wrapper)');
    return;
  }
  const shellPath = path.join(DIST, 'index.html');
  if (!existsSync(shellPath)) throw new Error(`prerender: ${shellPath} missing; run after vite build`);
  const shell = readFileSync(shellPath, 'utf8');
  if (shell.includes('data-prerender=')) {
    throw new Error('prerender: dist/index.html is already prerendered; run vite build first (this step is not idempotent by design)');
  }

  buildPrerenderBundle();
  const entry = await import(pathToFileURL(path.join(PRERENDER_OUT, 'entry-server.mjs')).href);
  entry.assertPrerenderCoversPublicRoutes();
  const css = readPrerenderCss();
  const fonts = readFonts();

  const manifest = [];
  for (const route of entry.PRERENDER_PATHS) {
    const page = entry.renderPublicPage(route);
    const doc = composeDocument({ shell, page, css, fonts });
    const words = verifyDocument(route, doc);
    const out = outputPathFor(route);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, doc);
    manifest.push({ route, file: path.relative(DIST, out), words, title: page.seo.title });
    console.log(`[prerender] ${route} -> ${path.relative(ROOT, out)} (${words} words)`);
  }
  writeFileSync(
    path.join(DIST, 'prerender-manifest.json'),
    JSON.stringify({ base: WEB_BASE, generatedFrom: 'src/prerender/entry-server.tsx', routes: manifest }, null, 2) + '\n',
  );
  console.log(`[prerender] ${manifest.length} public routes prerendered; css inlined: ${(css.length / 1024).toFixed(1)} KB; fonts preloaded: ${fonts ? fonts.urls.length : 0}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
