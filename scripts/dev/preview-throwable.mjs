#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE THROWABLE DARKROOM (phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "It compiles" is not verification, and a green unit test only says the
 * elements exist and the durations scale. This renders the REAL rig markup
 * against the REAL stylesheets and photographs every rig at the beats its own
 * spec names, on a mock seat drawn to SeatSlot.css's proportions, at the four
 * `--seat-avatar-base` rungs the app retunes at (56 / 66 / 84 / 104 px).
 *
 * It always writes `<outDir>/harness.html`, a single self-contained file that
 * opens in any browser. That is deliberate and is what the knockout darkroom
 * learned: a sandboxed agent frequently cannot launch a browser, but can
 * always write a file. If Playwright IS available the script also screenshots
 * each beat into `<outDir>/shots/`.
 *
 * ANIMATIONS ARE PAUSED AND DRIVEN BY `currentTime`, never by sleeping. A
 * sleep-and-shoot harness photographs a different frame on a loaded machine,
 * which is the one thing a beat comparison cannot tolerate.
 *
 * The rigs are TSX, so they are bundled with the repo's own esbuild and
 * rendered to static markup with react-dom/server - the same components the
 * table mounts, not a hand-copied lookalike that can drift.
 *
 *   node scripts/dev/preview-throwable.mjs [outDir] [--only beer,tomato]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const OUT = resolve(args.find((a) => !a.startsWith('--')) || join(repo, '.throwable-darkroom'));
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg ? (onlyArg.split('=')[1] || args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean) : null;

mkdirSync(OUT, { recursive: true });

/* ── 1. Bundle the registry (rigs + specs) so node can import it ──────────────
   The bundle lives INSIDE the repo, not in outDir: node resolves `react` and
   `react-dom/server` from the importing file's directory, so a bundle written
   to /tmp cannot find them however the externals are declared. */
const tmp = join(repo, 'node_modules', '.throwable-darkroom');
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.mjs');
writeFileSync(
  entry,
  `export { RIGGED_IDS, riggedThrowable } from ${JSON.stringify(join(repo, 'src/throwables/registry.ts'))};\n`
);
const bundle = join(tmp, 'rigs.mjs');
const esbuild = await import(pathToFileURL(join(repo, 'node_modules/esbuild/lib/main.js')).href);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  // Vite's `import.meta.env` does not exist in node, and mediaBase reads it at
  // module scope.
  define: { 'import.meta.env': JSON.stringify({ VITE_MEDIA_BASE: '', BASE_URL: '/' }) },
  plugins: [
    {
      name: 'darkroom-stubs',
      setup(build) {
        // The rigs import their own .css for Vite; node cannot. The files are
        // read directly further down and inlined into the page.
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'stub-empty' }));
        build.onLoad({ filter: /.*/, namespace: 'stub-empty' }, () => ({ contents: '', loader: 'js' }));
        // The cue preloader reaches the AudioContext and `fetch` at module
        // scope. The darkroom is about pixels; sound is verified by its own
        // manifest test.
        build.onResolve({ filter: /(^|\/)cues(\.ts)?$/ }, () => ({
          path: 'throwable-cues',
          namespace: 'stub-cues',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub-cues' }, () => ({
          contents: 'export function preloadThrowableCues() {}\nexport function cueUrl(){return ""}\nexport function isPlaceholderCue(){return true}\nexport function placeholderRecipe(){return undefined}\n',
          loader: 'js',
        }));
      },
    },
  ],
});

const { RIGGED_IDS, riggedThrowable } = await import(pathToFileURL(bundle).href);
const { renderToStaticMarkup } = await import('react-dom/server');
const React = (await import('react')).default;

const ids = (only && only.length ? only : RIGGED_IDS).filter((id) => riggedThrowable(id));
if (!ids.length) {
  console.error('preview-throwable: no rigs to render');
  process.exit(1);
}

/* ── 2. The stylesheets, inlined so harness.html is one file ──────────────── */
const css = [readFileSync(join(repo, 'src/components/table/ThrowablePlayer.css'), 'utf8')];
for (const id of ids) {
  const p = join(repo, `src/throwables/rigs/${id}.css`);
  if (existsSync(p)) css.push(readFileSync(p, 'utf8'));
}

/* ── 3. Render every rig once; the harness re-uses the markup per beat ────── */
const rendered = ids.map((id) => {
  const { spec, rig } = riggedThrowable(id);
  return {
    id,
    spec,
    projectile: renderToStaticMarkup(React.createElement(rig.Projectile, { uid: `dk${id}p` })),
    payload: renderToStaticMarkup(React.createElement(rig.Payload, { uid: `dk${id}q` })),
  };
});

/* ── 4. The mock seat, at SeatSlot.css's real proportions ─────────────────── */
const seatMarkup = `
  <div class="mock-seat" data-seat-num="1">
    <div class="mock-plate"></div>
    <div class="seat__avatar mock-avatar"><span>SB</span></div>
    <div class="mock-cards"><i></i><i></i></div>
    <div class="mock-name">SunBum45<b>12,480</b></div>
  </div>`;

const RUNGS = [56, 66, 84, 104];

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Throwable darkroom</title>
<style>
  :root { --animation-speed: 1; }
  body { margin: 0; background: #0b1418; color: #cfe3ea;
         font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 15px; margin: 18px 12px 4px; color: #ffd479; }
  h2 { font-size: 13px; margin: 22px 12px 6px; color: #9fd0e0; font-weight: 600; }
  p.note { margin: 0 12px 10px; color: #7e97a1; max-width: 90ch; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 12px 14px; }
  .cell { background:
      radial-gradient(ellipse at 50% 42%, #1d6b4f 0%, #145138 58%, #0d3826 100%);
      border: 1px solid #24424f; border-radius: 10px; position: relative;
      overflow: hidden; }
  .cell .cap { position: absolute; left: 4px; top: 3px; z-index: 9;
      font: 10px/1 ui-monospace, monospace; color: #ffe9a8; text-shadow: 0 1px 2px #000; }
  .cell .cap em { color: #8fe0ff; font-style: normal; }
  /* the mock seat, in avatar units */
  .mock-seat { position: absolute; left: 50%; top: 50%; }
  .mock-avatar { position: absolute; left: 50%; top: 50%;
      width: var(--u); height: var(--u); margin: calc(var(--u) * -0.5) 0 0 calc(var(--u) * -0.5);
      border-radius: 50%; background: linear-gradient(180deg, #4d6b7a, #2b3f4a);
      border: calc(var(--u) * 0.035) solid #86a7b6; display: grid; place-items: center;
      color: #cfe3ea; font-size: calc(var(--u) * 0.3); font-weight: 700; }
  .mock-plate { position: absolute; left: 50%; top: 50%;
      width: calc(var(--u) * 0.76); height: calc(var(--u) * 0.34);
      margin: calc(var(--u) * 0.34) 0 0 calc(var(--u) * -0.38);
      border-radius: calc(var(--u) * 0.06); background: #12222b; border: 1px solid #2c444a; }
  .mock-cards { position: absolute; left: 50%; top: 50%;
      width: calc(var(--u) * 0.321); height: calc(var(--u) * 0.346);
      margin: calc(var(--u) * 0.2) 0 0 calc(var(--u) * -0.16); display: flex; gap: 2px; }
  .mock-cards i { flex: 1; background: #1b3f6b; border: 1px solid #2f5f96; border-radius: 2px; }
  .mock-name { position: absolute; left: 50%; top: 50%; transform: translate(-50%, 0);
      margin-top: calc(var(--u) * 0.4); font-size: calc(var(--u) * 0.12);
      color: #b9d2dc; white-space: nowrap; }
  .mock-name b { display: block; color: #ffd479; }
  /* the player's own layer, positioned for a static beat */
  .beat-layer { position: absolute; inset: 0; }
  .beat-layer .thr__payload,
  .beat-layer .thr__proj { left: 50%; top: 50%; }
  .beat-layer .thr__proj { translate: none !important; }
</style>
<style>${css.join('\n\n')}</style>
</head><body>
<h1>Throwable darkroom &mdash; ${rendered.length} rig(s), beats from each spec</h1>
<p class="note">Every animation is PAUSED and driven by <code>currentTime</code>, so each tile is
exactly the frame its caption names. Beat times are ms from LAUNCH; the payload's own
animations are delayed from LANDING and the harness accounts for that. Compare against
<code>docs/throwables/pokerbros-reference-video-*.md</code>, which gives the frame number for
every beat in the capture.</p>
${rendered
  .map((r) => {
    const landing = r.spec.flight.mode === 'none' ? 0 : r.spec.flight.ms;
    const beats = r.spec.beats;
    const tiles = beats
      .map(
        (b) => `
      <div class="cell" style="--u:84px; width:260px; height:260px;" data-at="${b.at}" data-landing="${landing}" data-id="${r.id}">
        <div class="cap">${b.at}ms <em>${b.marker}</em></div>
        ${seatMarkup}
        <div class="beat-layer" style="--thr-u:84px;">
          ${b.at < landing ? `<div class="thr__proj">${r.projectile}</div>` : `<div class="thr__payload thr__payload--${r.spec.arrival}">${r.payload}</div>`}
        </div>
      </div>`
      )
      .join('');
    const rungs = RUNGS.map(
      (u) => `
      <div class="cell" style="--u:${u}px; width:${Math.round(u * 3.1)}px; height:${Math.round(u * 3.1)}px;"
           data-at="${beats[Math.floor(beats.length / 2)].at}" data-landing="${landing}" data-id="${r.id}">
        <div class="cap">${u}px</div>
        ${seatMarkup}
        <div class="beat-layer" style="--thr-u:${u}px;">
          <div class="thr__payload thr__payload--${r.spec.arrival}">${r.payload}</div>
        </div>
      </div>`
    ).join('');
    return `<h2>${r.spec.name} &mdash; ${r.id} &middot; spawn ${r.spec.spawnMs} &middot; flight ${r.spec.flight.ms} &middot; payload ${r.spec.payload.ms}${
      r.spec.reference ? ` &middot; ref video ${r.spec.reference.video} ${r.spec.reference.throw} launch f${r.spec.reference.launchFrame}` : ''
    }</h2>
    <div class="row">${tiles}</div>
    <h2 style="opacity:.7">${r.id}: the four seat rungs</h2>
    <div class="row">${rungs}</div>`;
  })
  .join('\n')}
<script>
  // Freeze every animation at the beat its tile names. The payload's own
  // animations start at LANDING, so its currentTime is (at - landing).
  function freeze() {
    document.querySelectorAll('.cell[data-at]').forEach((cell) => {
      const at = Number(cell.dataset.at);
      const landing = Number(cell.dataset.landing);
      const inPayload = at >= landing;
      const t = inPayload ? at - landing : at;
      cell.querySelectorAll('*').forEach((el) => {
        if (!el.getAnimations) return;
        el.getAnimations().forEach((a) => {
          a.pause();
          try { a.currentTime = t; } catch (e) { /* delayed animation not started */ }
        });
      });
    });
    document.documentElement.dataset.frozen = '1';
  }
  // Two frames so every delayed animation exists before it is paused.
  requestAnimationFrame(() => requestAnimationFrame(freeze));
</script>
</body></html>`;

const harness = join(OUT, 'harness.html');
writeFileSync(harness, page);
rmSync(tmp, { recursive: true, force: true });
console.log(`harness: ${harness}`);
console.log(`rigs:    ${ids.join(', ')}`);

/* ── 5. Screenshots, if Playwright is here. Never required. ───────────────── */
try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const pageCtx = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await pageCtx.goto(pathToFileURL(harness).href);
  await pageCtx.waitForFunction(() => document.documentElement.dataset.frozen === '1', { timeout: 5000 });
  const shots = join(OUT, 'shots');
  mkdirSync(shots, { recursive: true });
  const cells = await pageCtx.$$('.cell[data-at]');
  let i = 0;
  for (const cell of cells) {
    const id = await cell.getAttribute('data-id');
    const at = await cell.getAttribute('data-at');
    await cell.screenshot({ path: join(shots, `${String(i++).padStart(2, '0')}-${id}-${at}ms.png`) });
  }
  await browser.close();
  console.log(`shots:   ${shots} (${cells.length})`);
} catch (err) {
  console.log(`playwright unavailable (${String(err).split('\n')[0]}) - harness.html is written and is the deliverable`);
}
