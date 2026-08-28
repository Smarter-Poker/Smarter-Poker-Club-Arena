/**
 * VISUAL PROOF FOR THE SEAT KNOCKOUT (2026-08-28).
 *
 * "It compiles" is not verification and neither is a green unit test — the
 * unit tests pin that the elements exist and that the durations scale, not
 * that the thing LOOKS like Dan's PokerBros capture. This renders the real
 * component markup against the real stylesheet and photographs it at the same
 * timestamps the capture was measured at, so the two can be put side by side.
 *
 *   node scripts/dev/preview-seat-knockout.mjs [outDir]
 *
 * Animations are PAUSED and driven by setting currentTime, not by sleeping:
 * a sleep-and-shoot harness is flaky at 30fps and would photograph a different
 * frame on a loaded machine, which is the one thing a reference comparison
 * cannot tolerate.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(process.argv[2] || resolve(ROOT, '.preview-knockout'));

const css = readFileSync(resolve(ROOT, 'src/components/table/SeatKnockout.css'), 'utf8');

/* The glove, copied from SeatKnockout.tsx's GloveArt. Kept in sync by eye on
   purpose: this file is a darkroom, not a source of truth, and importing TSX
   here would mean standing up a bundler to take a photograph. */
const GLOVE = `<svg viewBox="0 0 128 96" aria-hidden="true">
  <rect x="2" y="27" width="31" height="42" rx="9" fill="#f1e6d0"/>
  <path d="M2 50h31v10a9 9 0 0 1-9 9H11a9 9 0 0 1-9-9z" fill="#000" opacity="0.16"/>
  <path d="M11 32v32M20 30v36M29 32v32" stroke="#c6b28a" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M31 19h35c26 0 46 13 46 29S92 77 66 77H31c-7 0-12-5-12-12V31c0-7 5-12 12-12z" fill="#d51616"/>
  <path d="M33 25h33c19 0 34 6 41 14-9-9-24-14-41-14H33z" fill="#ff7b6b" opacity="0.85"/>
  <ellipse cx="55" cy="35" rx="16" ry="7" fill="#fff" opacity="0.26"/>
  <path d="M31 77h35c22 0 40-9 45-22-2 17-21 29-45 29H31z" fill="#5f0303" opacity="0.5"/>
  <path d="M78 28c8 9 8 30 0 39" stroke="#8e0808" stroke-width="3.2" stroke-linecap="round" fill="none" opacity="0.55"/>
  <path d="M38 58c0-9 8-14 17-14 11 0 18 7 18 16s-8 17-18 17H43c-3 0-5-3-5-6z" fill="#bd1111"/>
  <path d="M43 50c4-3 9-4 13-4 8 0 14 3 17 8-4-7-11-10-18-10-4 0-9 2-12 6z" fill="#ff7b6b" opacity="0.6"/>
</svg>`;

const rays = Array.from(
  { length: 12 },
  (_, i) => `<span class="sko__ray" style="--sko-ray-i:${i}"></span>`
).join('');

const EMBERS = [
  [-0.42, 0.3],
  [-0.24, 0.44],
  [0.02, 0.5],
  [0.28, 0.42],
  [0.46, 0.26],
  [-0.5, 0.08],
  [0.36, -0.18],
  [-0.16, -0.3],
];
const embers = EMBERS.map(
  ([x, y], i) =>
    `<span class="sko__ember" style="--sko-ember-x:${x};--sko-ember-y:${y};animation-delay:calc((0.54s + ${i * 0.018}s) * var(--animation-speed,1))"></span>`
).join('');

/** A stand-in for the seat underneath, so the effect can be judged in context. */
const seatPlate = (name, stack) => `
  <div class="seat">
    <div class="seat__cards"><span>A</span><span>10</span></div>
    <div class="seat__name">${name}</div>
    <div class="seat__stack">${stack}</div>
  </div>`;

const page = `<style>
  :root { --animation-speed: 1; --seat-avatar-base: 84px; }
  * { box-sizing: border-box; }
  body { margin:0; background:#12111c; font-family: system-ui, sans-serif; }
  .felt { position:relative; width:520px; height:320px; margin:24px auto;
          border-radius:150px; background:#22252b;
          box-shadow: inset 0 0 0 6px #a07b2a, inset 0 0 60px rgba(0,0,0,.7); }
  .anchor { position:absolute; left:62%; top:58%; }
  .seat { position:absolute; left:0; top:0; transform:translate(-50%,-50%);
          width:110px; text-align:center; color:#ddd; }
  .seat__cards { display:flex; gap:2px; justify-content:center; }
  .seat__cards span { background:#c9c9c9; color:#111; font-weight:700; font-size:22px;
                      width:34px; height:46px; display:grid; place-items:center; border-radius:3px; }
  .seat__name { font-size:12px; margin-top:2px; text-shadow:0 1px 2px #000; }
  .seat__stack { font-size:12px; color:#d8c76a; }
  ${css}
  /* Paused so the harness can drive currentTime by hand. */
  .sko * { animation-play-state: paused !important; }
</style>
<div class="felt">
  <div class="anchor">${seatPlate('Gordo Chris', '0')}</div>
  <div class="sko-layer">
    <div class="sko" style="--sko-x:62%; --sko-y:58%">
      <div class="sko__glove">${GLOVE}</div>
      <div class="sko__burst">${rays}</div>
      <div class="sko__core"></div>
      ${embers}
      <div class="sko__stamp" data-motion="keep">KO</div>
    </div>
  </div>
</div>`;

/* The beats the capture was measured at, plus the two either side of impact —
   those are where a mistimed delay shows up and nowhere else. */
const FRAMES = [0, 200, 400, 460, 520, 620, 800, 930, 1000, 1400, 2000, 2380];

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 568, height: 380 }, deviceScaleFactor: 2 });
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'harness.html'), page);
await tab.setContent(page);
await tab.waitForTimeout(120);

const shots = [];
for (const t of FRAMES) {
  await tab.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = ms;
    }
  }, t);
  const file = resolve(OUT, `t${String(t).padStart(4, '0')}.png`);
  await tab.screenshot({ path: file });
  shots.push(file);
}

await browser.close();
console.log(`${shots.length} frames -> ${OUT}`);
