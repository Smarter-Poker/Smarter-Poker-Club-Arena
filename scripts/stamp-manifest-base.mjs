/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  stamp-manifest-base - the web app manifest points at the sub-path it lives on
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO PHASE 1 (2026-09-17). public/manifest.json is copied to dist/ verbatim
 * by Vite, and it said `start_url: "/"`, `scope: "/"`. On the web the arena is
 * served under https://smarter.poker/hub/club-arena/, so a player who
 * installed it as a PWA got an app whose front door was the World Hub root
 * and whose scope claimed the whole origin; the icon path, meanwhile, was
 * hard-coded to the web sub-path and wrong for the native shell (which serves
 * the bundle at "/"). Vite only rewrites paths in HTML and CSS, not in JSON.
 *
 * This runs after `vite build`, on both targets, and rewrites the copy in the
 * output directory from ONE source of truth: the build's base. Web build:
 * base "/hub/club-arena/" (start_url, scope, id and the icon all under it).
 * Native build (CA_PUBLIC_BASE=/): base "/". public/manifest.json is not
 * touched, so the source file stays target-neutral.
 *
 *   node scripts/stamp-manifest-base.mjs            (build:ci; reads env)
 *   CA_DIST=dist-native CA_PUBLIC_BASE=/ node scripts/stamp-manifest-base.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../', import.meta.url).pathname);
const WEB_BASE = '/hub/club-arena/';

export function manifestBase(env = process.env) {
  const raw = env.CA_PUBLIC_BASE || (env.VITE_NATIVE === '1' ? '/' : WEB_BASE);
  let base = raw.trim();
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

/** Rewrite one manifest object for `base`; returns a new object. */
export function stampManifest(manifest, base) {
  const out = { ...manifest };
  // The front door the World Hub serves is the slashless /hub/club-arena, and
  // a manifest scope of "/hub/club-arena/" would NOT cover it (scope is a
  // path prefix; the service worker in App.tsx makes the same slashless
  // choice for the same reason). Root stays "/".
  const scope = base.length > 1 ? base.replace(/\/$/, '') : base;
  out.id = scope;
  out.start_url = scope;
  out.scope = scope;
  out.icons = (manifest.icons || []).map((icon) => {
    const file = String(icon.src || '').replace(/^\/hub\/club-arena\//, '/').replace(/^\//, '');
    return { ...icon, src: `${base}${file}` };
  });
  return out;
}

function main() {
  const dist = path.resolve(ROOT, process.env.CA_DIST || 'dist');
  const file = path.join(dist, 'manifest.json');
  if (!existsSync(file)) throw new Error(`stamp-manifest-base: ${file} missing; run after vite build`);
  const base = manifestBase();
  const stamped = stampManifest(JSON.parse(readFileSync(file, 'utf8')), base);
  writeFileSync(file, `${JSON.stringify(stamped, null, 2)}\n`);
  console.log(`[manifest] start_url, scope, id and ${stamped.icons.length} icon(s) stamped for base ${base}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
