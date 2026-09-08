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
 * It always writes `<outDir>/harness.html`, an HTML file with an adjacent assets folder that
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
 *   node scripts/dev/preview-throwable.mjs [outDir] [--only beer,tomato | --items=beer,tomato] [--shots | --html-only]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const { values, positionals } = parseArgs({
  options: {
    only: { type: 'string' },
    items: { type: 'string' },
    shots: { type: 'boolean', default: false },
    'html-only': { type: 'boolean', default: false },
    'executable-path': { type: 'string' },
  },
  allowPositionals: true,
});
if (
  positionals.length > 1 ||
  (values.only && values.items) ||
  (values.shots && values['html-only'])
) {
  throw new Error('Use [outDir] [--only=a,b | --items=a,b] [--shots | --html-only]');
}
const OUT = resolve(positionals[0] || join(repo, '.throwable-darkroom'));
const selection = values.only ?? values.items;
const only =
  selection === undefined
    ? null
    : [
        ...new Set(
          selection
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        ),
      ];
if (only && !only.length) throw new Error('The item list must not be empty');

mkdirSync(OUT, { recursive: true });
const copiedAtlases = new Set();

/* ── 1. Bundle the registry (rigs + specs) so node can import it ──────────────
   The bundle lives INSIDE the repo, not in outDir: node resolves `react` and
   `react-dom/server` from the importing file's directory, so a bundle written
   to /tmp cannot find them however the externals are declared. */
const tmp = mkdtempSync(join(repo, 'node_modules', '.throwable-darkroom-'));
const entry = join(tmp, 'entry.mjs');
writeFileSync(
  entry,
  `export { RIGGED_IDS, riggedThrowable } from ${JSON.stringify(join(repo, 'src/throwables/registry.ts'))};\nexport { THROWABLE_GRAMMAR } from ${JSON.stringify(join(repo, 'src/throwables/spec.ts'))};\n`
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
        build.onLoad({ filter: /.*/, namespace: 'stub-empty' }, () => ({
          contents: '',
          loader: 'js',
        }));
        // The cue preloader reaches the AudioContext and `fetch` at module
        // scope. The darkroom is about pixels; sound is verified by its own
        // manifest test.
        build.onResolve({ filter: /(^|\/)cues(\.ts)?$/ }, () => ({
          path: 'throwable-cues',
          namespace: 'stub-cues',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub-cues' }, () => ({
          contents:
            'export function preloadThrowableCues() {}\nexport function cueUrl(){return ""}\nexport function isPlaceholderCue(){return true}\nexport function placeholderRecipe(){return undefined}\n',
          loader: 'js',
        }));
      },
    },
  ],
});

const { RIGGED_IDS, riggedThrowable, THROWABLE_GRAMMAR } = await import(pathToFileURL(bundle).href);
rmSync(tmp, { recursive: true, force: true });
const { renderToStaticMarkup } = await import('react-dom/server');
const React = (await import('react')).default;

const unknown = (only ?? []).filter((id) => !RIGGED_IDS.includes(id));
if (unknown.length) throw new Error(`Unknown rig(s): ${unknown.join(', ')}`);
const ids = only ?? RIGGED_IDS;
if (!ids.length) {
  console.error('preview-throwable: no rigs to render');
  process.exit(1);
}

/* ── 2. The stylesheets, inlined so the harness needs no stylesheet server ──────────────── */
const css = [readFileSync(join(repo, 'src/components/table/ThrowablePlayer.css'), 'utf8')];
for (const id of ids) {
  const p = join(repo, `src/throwables/rigs/${id}.css`);
  if (existsSync(p)) css.push(readFileSync(p, 'utf8'));
}

/* Each tile renders independently: SVG gradient/filter IDs must be unique. */
const rendered = ids.map((id) => ({ id, ...riggedThrowable(id) }));
let tileId = 0;
function layer(r, at, unit) {
  const landing = r.spec.flight.mode === 'none' ? 0 : r.spec.flight.ms;
  const end = landing + Math.max(r.spec.payload.ms, r.spec.residue?.ms ?? 0);
  if (at >= end) return '';
  const payload = at >= landing;
  const uid = `dk${tileId++}`;
  const markup = renderToStaticMarkup(
    React.createElement(payload ? r.rig.Payload : r.rig.Projectile, { uid })
  ).replace(/\/images\/throwables\/animated\/([a-z0-9_-]+)\.webp/g, (_, id) => {
    mkdirSync(join(OUT, 'assets'), { recursive: true });
    const target = join(OUT, 'assets', `${id}.webp`);
    if (!copiedAtlases.has(id)) {
      copyFileSync(join(repo, 'public/images/throwables/animated', `${id}.webp`), target);
      copiedAtlases.add(id);
    }
    return `assets/${id}.webp`;
  });
  const phase = at >= landing + r.spec.payload.ms ? 'residue' : 'payload';
  const cls = payload
    ? `thr__payload thr__payload--${r.spec.arrival} thr__payload--${phase}${r.spec.residue?.fade === 'fade' ? ' thr__payload--fades' : ''}`
    : 'thr__proj';
  const x = r.spec.payload.anchor === 'left' ? -0.6 : r.spec.payload.anchor === 'right' ? 0.6 : 0;
  const y = r.spec.payload.anchor === 'above' ? -0.9 : 0;
  const anchor = payload ? `left:calc(50% + ${x * unit}px);top:calc(50% + ${y * unit}px);` : '';
  const arrival =
    r.spec.arrival === 'land' ? THROWABLE_GRAMMAR.landMs : THROWABLE_GRAMMAR.arrivalMs;
  return `<div class="beat-layer" style="--thr-u:${unit}px;--thr-arrival-ms:${arrival}ms;--thr-payload-ms:${r.spec.payload.ms}ms;--thr-residue-ms:${r.spec.residue?.ms ?? r.spec.payload.ms}ms;"><div class="${cls}" style="${anchor}">${markup}</div></div>`;
}

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
        ${layer(r, b.at, 84)}
      </div>`
      )
      .join('');
    const rungs = RUNGS.map(
      (u) => `
      <div class="cell" style="--u:${u}px; width:${Math.round(u * 3.1)}px; height:${Math.round(u * 3.1)}px;"
           data-at="${beats[Math.floor(beats.length / 2)].at}" data-landing="${landing}" data-id="${r.id}">
        <div class="cap">${u}px</div>
        ${seatMarkup}
        ${layer(r, beats[Math.floor(beats.length / 2)].at, u)}
      </div>`
    ).join('');
    return `<h2>${r.spec.name} &mdash; ${r.id} &middot; spawn ${r.spec.spawnMs} &middot; flight ${r.spec.flight.ms} &middot; payload ${r.spec.payload.ms}${
      r.spec.reference
        ? ` &middot; ref video ${r.spec.reference.video} ${r.spec.reference.throw} launch f${r.spec.reference.launchFrame}`
        : ''
    }</h2>
    <button type="button" data-replay="${r.id}">Replay ${r.spec.name} at target</button>
    <div data-live="${r.id}" data-duration="${r.spec.payload.ms}" style="position:relative;overflow:hidden;background:#165940;width:320px;height:320px;--u:104px;">
      ${seatMarkup}
      <div data-performance hidden>${layer(r, landing, 104)}</div>
    </div>
    <div class="row">${tiles}</div>
    <h2 style="opacity:.7">${r.id}: the four seat rungs</h2>
    <div class="row">${rungs}</div>`;
  })
  .join('\n')}
<script>
  // Replay the actual payload components. One controllable clock; repeated
  // clicks cancel the previous frame loop and the final beat cuts cleanly.
  const liveFrames = new Map();
  document.querySelectorAll('[data-replay]').forEach(button => {
    button.addEventListener('click', () => {
      const host = document.querySelector('[data-live="' + button.dataset.replay + '"]');
      const performance = host.querySelector('[data-performance]');
      cancelAnimationFrame(liveFrames.get(host));
      performance.hidden = false;
      const animations = performance.getAnimations({subtree:true});
      animations.forEach(a => { a.pause(); a.currentTime = 0; });
      const start = window.performance.now();
      const duration = Number(host.dataset.duration);
      const tick = now => {
        const elapsed = now - start;
        if (elapsed >= duration) {
          performance.hidden = true;
          liveFrames.delete(host);
          return;
        }
        animations.forEach(a => { a.currentTime = elapsed; });
        liveFrames.set(host, requestAnimationFrame(tick));
      };
      liveFrames.set(host, requestAnimationFrame(tick));
    });
  });
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

writeFileSync(
  join(OUT, 'specs.json'),
  JSON.stringify(
    rendered.map(({ id, spec }) => ({ id, spec })),
    null,
    2
  )
);
const harness = join(OUT, 'harness.html');
writeFileSync(harness, page);
console.log(`harness: ${harness}`);
console.log(`rigs:    ${ids.join(', ')}`);

/* ── 5. Screenshots, if Playwright is here. Never required. ───────────────── */
let browser;
if (!values['html-only'])
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ executablePath: values['executable-path'] });
    const pageCtx = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await pageCtx.goto(pathToFileURL(harness).href);
    await pageCtx.waitForFunction(() => document.documentElement.dataset.frozen === '1', {
      timeout: 5000,
    });
    // CSS backgrounds do not emit pageerror when absent. Decode every atlas
    // before recording so a blank sprite cannot be mistaken for a valid beat.
    await pageCtx.evaluate(async () => {
      const assets = new Map();
      for (const el of document.querySelectorAll('[data-atlas-width]')) {
        const url = el.style.backgroundImage.slice(4, -1).replace(/^['"]|['"]$/g, '');
        const width = Number(el.dataset.atlasWidth);
        const height = Number(el.dataset.atlasHeight);
        assets.set(`${url}:${width}:${height}`, { url, width, height });
      }
      await Promise.all(
        [...assets.values()].map(async ({ url, width, height }) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error(`Atlas dimensions mismatch: ${url}, expected ${width}x${height}`);
        })
      );
    });
    const shots = join(OUT, 'shots');
    mkdirSync(shots, { recursive: true });
    const cells = await pageCtx.$$('.cell[data-at]');
    let i = 0;
    for (const cell of cells) {
      const id = await cell.getAttribute('data-id');
      const at = await cell.getAttribute('data-at');
      await cell.screenshot({
        path: join(shots, `${String(i++).padStart(2, '0')}-${id}-${at}ms.png`),
      });
    }
    console.log(`shots:   ${shots} (${cells.length})`);
  } catch (err) {
    console.error(`Screenshot capture failed: ${String(err).split('\n')[0]}. Harness: ${harness}`);
    if (values.shots) process.exitCode = 1;
  } finally {
    await browser?.close();
  }
