/**
 * VISUAL PROOF FOR THE SEAT KNOCKOUT (2026-08-28, rebuilt 2026-08-29).
 *
 * "It compiles" is not verification and neither is a green unit test — the
 * unit tests pin that the elements exist and that the durations scale, not
 * that the thing LOOKS like Dan's PokerBros capture. This renders the real
 * component markup against the real stylesheet and photographs it at the same
 * timestamps the capture was measured at, WITH THE MATCHING REFERENCE FRAME
 * BESIDE IT, so "does this look right" becomes a diff instead of an opinion.
 *
 *   node scripts/dev/preview-seat-knockout.mjs [outDir]
 *
 * It always writes `<outDir>/harness.html`, which is a single self-contained
 * file you can open in any browser — that path matters, because a sandboxed
 * agent frequently cannot run Playwright (the installed esbuild/Playwright
 * binaries are darwin-arm64) but can always write a file and open it. If
 * Playwright IS available it then screenshots each beat as well.
 *
 * WHAT IT SHOWS
 *   1. Fourteen beats, ours beside the capture's own frame at the same time.
 *   2. Eight simultaneous knockouts — the 375px worst case (9-handed table,
 *      one survivor), frozen on the densest frame.
 *   3. The four --seat-avatar-base rungs SeatSlot.css retunes at.
 *   4. A prefers-reduced-motion pass: the stamp must still hold, everything
 *      else must be gone.
 *
 * Animations are PAUSED and driven by setting currentTime, not by sleeping:
 * a sleep-and-shoot harness is flaky at 30fps and would photograph a different
 * frame on a loaded machine, which is the one thing a reference comparison
 * cannot tolerate.
 *
 * THE REFERENCE COLUMN is pulled out of `.agent-trees/ko-reference/KO-VIDEO.MOV`
 * with ffmpeg at t0 = 1.97s (the frame the glove appears in the villain
 * knockout). That directory is gitignored and machine-local; without it, or
 * without ffmpeg, the page still renders and simply drops the left column.
 *
 * THE MOCK SEAT IS DRAWN TO SeatSlot.css's REAL PROPORTIONS — avatar = 1 unit,
 * villain hole-card cluster = 0.321 x 0.346 units on the avatar's lower edge,
 * name plate = 0.76 units. The first version of this file used a 110px plate
 * with 34px cards, which is nothing like the product, and judging against it
 * is how the rebuild's first pass ended up with a star wider than the seat.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(process.argv[2] || resolve(ROOT, '.preview-knockout'));
mkdirSync(OUT, { recursive: true });

/* THE REAL POT-WIN FLOAT RULE, lifted out of TablePage.css rather than
   re-typed. This is the "+2,120" that rides from the busted seat to the
   winner's chair, and a harness that mocked it with a lookalike would be
   showing Dan something the product does not do. */
const tablePageCss = readFileSync(resolve(ROOT, 'src/pages/TablePage.css'), 'utf8');
const POT_FLOAT_CSS = (() => {
  const start = tablePageCss.indexOf('.pot-win-float {');
  if (start < 0) throw new Error('.pot-win-float rule not found in TablePage.css');
  const end = tablePageCss.indexOf('@media (prefers-reduced-motion: reduce)', start);
  return tablePageCss.slice(start, end > 0 ? end : start + 2000);
})();

const SRC = resolve(ROOT, 'src/components/table/SeatKnockout.tsx');
const css = readFileSync(resolve(ROOT, 'src/components/table/SeatKnockout.css'), 'utf8');
const tsx = readFileSync(SRC, 'utf8');

/* ── The art, lifted OUT OF THE COMPONENT rather than copied ────────────────
   The previous version of this file pasted the glove SVG in and said it was
   "kept in sync by eye on purpose". By the time the rebuild started, it was
   already the source of truth for nothing and would have photographed the OLD
   glove against the NEW stylesheet. The star paths and the spark table are
   parsed straight out of the .tsx, so a change to the component cannot leave
   the darkroom photographing something that no longer ships. The glove and
   the stamp are JSX (attribute names differ from HTML), so those two are
   transliterated below with a test that keeps them honest. */
function constant(name) {
  const m = tsx.match(new RegExp(`const ${name} =\\n?([\\s\\S]*?);\\n`));
  if (!m) throw new Error(`${name} not found in ${SRC}`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
}
const STAR_MAIN = constant('STAR_MAIN');
const STAR_ALT = constant('STAR_ALT');
const STAR_SHARDS = constant('STAR_SHARDS');

const EMBERS = [
  ...tsx
    .slice(tsx.indexOf('const EMBERS'), tsx.indexOf('];', tsx.indexOf('const EMBERS')))
    .matchAll(/\[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]/g),
].map((m) => m.slice(1).map(Number));
if (EMBERS.length < 14) throw new Error(`parsed ${EMBERS.length} sparks — the table moved`);

/** JSX -> HTML. Only the attributes this file's own markup uses. */
const html = (s) =>
  s
    .replace(/stopColor=/g, 'stop-color=')
    .replace(/stopOpacity=/g, 'stop-opacity=')
    .replace(/strokeWidth=/g, 'stroke-width=')
    .replace(/fillRule=/g, 'fill-rule=');

/** Pull one JSX component's <svg>…</svg> out of the .tsx and de-JSX it. */
function svgOf(fnName) {
  const fn = tsx.slice(tsx.indexOf(`function ${fnName}(`));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const svg = body.match(/<svg[\s\S]*<\/svg>/)[0];
  return html(svg)
    .replace(/\{`url\(#\$\{g\('(\w+)'\)\}\)`\}/g, (_, n) => `"url(#sko-${n}-UID)"`)
    .replace(/id=\{g\('(\w+)'\)\}/g, (_, n) => `id="sko-${n}-UID"`)
    .replace(/d=\{(\w+)\}/g, (_, n) => `d="${n === 'K' ? '__K__' : '__O__'}"`)
    .replace(/\{/g, '')
    .replace(/\}/g, '');
}

/* The two stamp glyphs, read out of StampArt so they cannot drift. */
const K = tsx.match(/const K =\s*'([^']*)'/)[1];
const O = [...tsx.slice(tsx.indexOf('const O =')).matchAll(/'([^']*)'/g)]
  .slice(0, 2)
  .map((m) => m[1])
  .join('');
const STAMP = svgOf('StampArt').replace('__K__', K).replace('__O__', O);

/* DAN'S GLOVES, inlined as data URIs.
   The component resolves them through mediaUrl(), which produces an absolute
   `/hub/club-arena/...` path — correct in the app and useless in a file:// page
   opened straight off disk, which is exactly how this harness gets looked at.
   Reading the bytes and inlining them keeps harness.html a single file you can
   double-click, and it is still the SHIPPING art rather than a stand-in. */
const gloveDataUri = (name) => {
  const f = resolve(ROOT, `public/images/knockout/${name}.webp`);
  if (!existsSync(f)) {
    console.warn(`!! ${f} missing — the gloves will not draw`);
    return '';
  }
  return `data:image/webp;base64,${readFileSync(f).toString('base64')}`;
};
const GLOVE_L = gloveDataUri('glove-left');
const GLOVE_R = gloveDataUri('glove-right');

const EMBER_ROT = EMBERS.map(([dx, dy]) => (Math.atan2(dy, dx) * 180) / Math.PI);

function sko(uid, { hero = false } = {}) {
  const u = (s) => s.replace(/UID/g, uid);
  const sparks = EMBERS.map(
    ([dx, dy, size, step], i) =>
      `<span class="sko__ember" style="--sko-ember-x:${dx};--sko-ember-y:${dy};` +
      `--sko-ember-size:${size};--sko-ember-rot:${EMBER_ROT[i].toFixed(1)}deg;` +
      `animation-delay:calc((0.54s + ${(step * 0.014).toFixed(3)}s) * var(--animation-speed,1));` +
      `animation-duration:calc((0.44s + ${((i % 4) * 0.05).toFixed(2)}s) * var(--animation-speed,1))"></span>`
  ).join('');
  const star =
    `<svg class="sko__star" viewBox="-30 -30 260 260" preserveAspectRatio="xMidYMid meet"><defs>` +
    `<radialGradient id="sko-burst-${uid}" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0%" stop-color="#fbfcff"/><stop offset="46%" stop-color="#fffdf7"/>` +
    `<stop offset="70%" stop-color="#fff4d9"/><stop offset="88%" stop-color="#ffdf9e"/>` +
    `<stop offset="100%" stop-color="#ffbe63" stop-opacity="0.75"/></radialGradient>` +
    `<radialGradient id="sko-hit-${uid}" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0%" stop-color="#fffdf4"/><stop offset="34%" stop-color="#ffe9a8"/>` +
    `<stop offset="72%" stop-color="#ffa93c"/><stop offset="100%" stop-color="#ff6a12" stop-opacity="0.85"/>` +
    `</radialGradient></defs>` +
    `<g class="sko__star-alt"><path d="${STAR_ALT}" fill="url(#sko-burst-${uid})" opacity="0.4"/></g>` +
    `<g class="sko__star-main"><path d="${STAR_MAIN}" fill="url(#sko-burst-${uid})"/></g>` +
    `<g class="sko__shards"><path d="${STAR_SHARDS}" fill="#fffdf4"/></g></svg>`;
  const hit =
    `<svg class="sko__hit" viewBox="-30 -30 260 260" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${STAR_ALT}" fill="url(#sko-hit-${uid})"/></svg>`;
  return (
    // The order matters and mirrors the component: the bursts are drawn AFTER
    // the gloves so each one blows out over the glove that caused it.
    `<div class="sko${hero ? ' sko--hero' : ''}" style="--sko-x:50%;--sko-y:50%">` +
    `<div class="sko__light"></div><div class="sko__ring"></div>` +
    `<img class="sko__glove sko__glove--r" src="${GLOVE_R}" alt="" draggable="false">` +
    `<img class="sko__glove sko__glove--l" src="${GLOVE_L}" alt="" draggable="false">` +
    `${star}<div class="sko__core"></div>${hit}${sparks}` +
    `<div class="sko__flash"></div><div class="sko__stampring"></div>` +
    `<div class="sko__stamp" data-motion="keep">${u(STAMP)}</div></div>`
  );
}

const SEAT = `<div class="seat" data-seat-num="1">
  <div class="seat__av"></div>
  <div class="seat__cards"><span class="c c0"></span><span class="c c1"></span></div>
  <div class="seat__plate"><b>Gordo Chris</b><i>0</i></div>
</div>`;

/* ── The reference column ───────────────────────────────────────────────────
   t0 = 1.97s, the frame the glove appears in the capture's villain knockout.
   The crop is the busted seat: 84x74 at (140,284) in the 220x480 source. */
const REF_T0 = 1.97;
const VIDEO = resolve(ROOT, '.agent-trees/ko-reference/KO-VIDEO.MOV');
function referenceFrame(ms) {
  if (!existsSync(VIDEO)) return null;
  const file = resolve(OUT, `ref-${ms}.png`);
  try {
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-ss', (REF_T0 + ms / 1000).toFixed(3),
        '-i', VIDEO,
        '-frames:v', '1',
        '-vf', 'crop=84:74:140:284',
        file,
      ],
      { stdio: 'pipe' }
    );
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

const BEATS = [
  [0, 'right glove in'],
  [120, 'closing'],
  [180, 'LANDING 1 — right'],
  [250, 'retract, left enters'],
  [320, 'LANDING 2 — left'],
  [390, 'both cock back'],
  [460, 'FINISH — both, white star'],
  [520, 'star peak'],
  [600, 'break-up'],
  [700, 'sparks'],
  [860, 'gloves gone'],
  [930, 'KO SLAM'],
  [1010, 'stamp settled'],
  [1400, 'seat empty, KO burns'],
  [2380, 'fade out'],
];

let refCount = 0;
const tiles = BEATS.map(([ms, label], i) => {
  const ref = referenceFrame(ms);
  if (ref) refCount++;
  const left = ref
    ? `<div class="cell"><span class="tag">PokerBros</span><img class="refshot" src="${ref}" alt=""></div>`
    : '';
  return `<figure class="cmp"><figcaption><b>+${ms}ms</b> <span>${label}</span></figcaption>
  <div class="pair${ref ? '' : ' pair--solo'}">${left}
    <div class="cell"><span class="tag">Club Arena</span>
      <div class="stage" data-t="${ms}"><div class="felt">${SEAT}<div class="sko-layer">${sko(`c${i}`)}</div></div></div>
    </div>
  </div></figure>`;
}).join('');

const multi = Array.from(
  { length: 8 },
  (_, i) => `<div class="felt felt--m">${SEAT}<div class="sko-layer">${sko(`m${i}`)}</div></div>`
).join('');

const bp = [
  [56, '56px — 375'],
  [66, '66px — 414'],
  [84, '84px — 768'],
  [104, '104px — 1024'],
]
  .map(
    ([px, label], i) =>
      `<div class="bp" data-t="500" style="--seat-avatar-base:${px}px">
         <div class="felt" style="width:${px * 2.6}px;height:${px * 2.35}px">${SEAT}<div class="sko-layer">${sko(`b${i}`)}</div></div>
         <span>${label}</span></div>`
  )
  .join('');

const page = `<!doctype html><meta charset="utf-8"><title>Knockout Frame Compare</title>
<style>
:root{--animation-speed:1;--seat-avatar-base:84px;
  --bg:#f6f4f0;--fg:#17161a;--mut:#6b6870;--card:#fff;--line:#e2ded8}
@media (prefers-color-scheme:dark){:root{--bg:#101014;--fg:#eceaf0;--mut:#9a97a3;--card:#191920;--line:#2b2b34}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);padding:28px 20px 60px;
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:23px;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:16px;margin:36px 0 12px;padding-top:16px;border-top:1px solid var(--line)}
p.sub,.note{color:var(--mut);margin:0 0 24px;max-width:70ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.cmp{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}
figcaption{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--mut);margin-bottom:8px}
figcaption b{color:var(--fg);font-size:13px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pair--solo{grid-template-columns:1fr}
.cell{position:relative;background:#0c0d10;border-radius:6px;overflow:hidden;
  aspect-ratio:216/196;display:grid;place-items:center}
/* The reference frame gets a CLASS, not a bare element-type selector.
   .cell img is specificity (0,1,1) and .sko__glove is (0,1,0), so a type
   selector here silently OUTRANKS the component's own sizing: it stretched
   Dan's gloves to fill the whole cell, which looked exactly like a product
   bug and was not one. Never style a bare element type inside this harness.
   (And no backticks in these comments — the whole page is a template
   literal, so one backtick ends the string mid-stylesheet.) */
.cell .refshot{width:100%;height:100%;object-fit:cover;image-rendering:pixelated}
.tag{position:absolute;left:5px;top:4px;z-index:9;font-size:9px;letter-spacing:.08em;
  text-transform:uppercase;color:#fff8;pointer-events:none}
.stage{width:100%;height:100%;display:grid;place-items:center;overflow:hidden}
.felt{position:relative;width:216px;height:196px;border-radius:4px;
  background:radial-gradient(120% 120% at 40% 20%,#2b3a33 0%,#1a241f 60%,#121a16 100%)}
.felt--m{margin:5px}
/* SeatSlot.css's real proportions — see the header note. */
.seat{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:var(--seat-avatar-base);height:var(--seat-avatar-base)}
.seat__av{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 38% 30%,#6c5a45 0%,#3d3226 62%,#241d15 100%);
  box-shadow:0 0 0 2px #b9902f inset,0 2px 6px #0009}
.seat__cards{position:absolute;right:-6%;top:calc(var(--seat-avatar-base) - 7px);
  transform:translateY(-100%);width:calc(var(--seat-avatar-base)*.321);
  height:calc(var(--seat-avatar-base)*.346);filter:drop-shadow(0 2px 5px #0007)}
.seat__cards .c{position:absolute;top:0;width:calc(var(--seat-avatar-base)*.247);height:100%;
  border-radius:2px;background:linear-gradient(#e8e8e8,#c2c2c2);
  box-shadow:0 0 0 1px #ffffff38;transform-origin:50% 120%}
.seat__cards .c0{left:calc(var(--seat-avatar-base)*.074);transform:rotate(4deg);z-index:2}
.seat__cards .c1{left:0;transform:rotate(-4deg)}
.seat__plate{position:absolute;left:50%;top:calc(var(--seat-avatar-base)*.92);
  transform:translateX(-50%);width:calc(var(--seat-avatar-base)*.76);background:#12161bdd;
  border-radius:3px;text-align:center;padding:1px 0;border:1px solid #ffffff1a}
.seat__plate b{display:block;font-size:calc(var(--seat-avatar-base)*.115);color:#e6e6e6;font-weight:600}
.seat__plate i{display:block;font-size:calc(var(--seat-avatar-base)*.11);color:#d8c76a;font-style:normal}
.multi{display:flex;flex-wrap:wrap;zoom:.55;background:#0c0d10;border-radius:8px;padding:8px;border:1px solid var(--line)}
.bps{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;zoom:.72}
.bp{background:#0c0d10;border:1px solid var(--line);border-radius:8px;padding:8px;text-align:center}
.bp span{display:block;font-size:11px;color:var(--mut);margin-top:6px}
${css}
/* The darkroom freezes every animation and drives currentTime by hand. */
.sko,.sko *{animation-play-state:paused!important}
</style>
<h1>Knockout rebuild — frame against frame</h1>
<p class="sub">Right is what Club Arena renders at that beat: real markup, real stylesheet, real
glove art, animations paused and driven by <code>currentTime</code> rather than by sleeping.
Left is Dan's FIRST capture (t0&nbsp;=&nbsp;1.97s) — that is the one the star, the sparks and the
KO stamp were matched against, and it is a single-glove knockout, so its gloves will not line up
with ours before +460ms. The two-glove flurry timing came from the SECOND capture
(<code>KO KNOCKOUT.MOV</code>) instead, measured frame by frame and confirmed against its own
audio track by onset detection: seven landings across 0.9s, 64-272ms apart.</p>
<div class="grid">${tiles}</div>

<h2>Eight simultaneous knockouts — the 375px worst case</h2>
<p class="note">A nine-handed table with one survivor. Frozen on the impact beat, the densest frame.</p>
<div class="multi" data-t="500">${multi}</div>

<h2>Breakpoints</h2>
<p class="note">The effect scales off <code>--seat-avatar-base</code>, which SeatSlot.css retunes
four times. Frozen on the impact beat.</p>
<div class="bps">${bp}</div>

<h2>Reduced motion</h2>
<p class="note">The stamp must still hold and be readable; the glove, the star and the sparks must
be gone entirely. Frozen at +600ms — inside <code>skoStampReduced</code>'s hold. (Freezing this
tile at the 1400ms full duration shows an empty seat and looks like a bug: the reduced variant is
1.1s and has already faded by then, which is correct and was worth finding here rather than in a
bug report.)</p>
<div class="bps" id="rm"><div class="bp" data-t="600"><div class="felt">${SEAT}
  <div class="sko-layer">${sko('rm0')}</div></div><span>prefers-reduced-motion</span></div></div>

<script>
/* Force the reduced-motion rules for the last section only: the media query
   cannot be emulated per-element, so its declarations are re-applied by hand
   under a #rm prefix. Kept mechanical (a text transform of the real block) so
   it cannot drift from what ships. */
(function(){
  var css = ${JSON.stringify(css)};
  var i = css.indexOf('@media (prefers-reduced-motion: reduce)');
  var block = css.slice(css.indexOf('{', i) + 1, css.lastIndexOf('}'));
  var scoped = block.replace(/(^|\\n)(\\s*)(\\.[a-zA-Z][^{,\\n]*)/g, '$1$2#rm $3');
  var s = document.createElement('style'); s.textContent = scoped;
  document.head.appendChild(s);
})();
var PUNCHES = [180, 320, 460], FLINCH = 200;
function freeze(){
  document.querySelectorAll('[data-t]').forEach(function(scope){
    var ms = Number(scope.dataset.t);
    scope.querySelectorAll('*').forEach(function(el){
      el.getAnimations().forEach(function(a){ a.pause(); a.currentTime = ms; });
    });
    /* The seat jolt is added by SeatKnockout.tsx on a timer, once per landing.
       A frozen frame that leaves it out is a frame that lies about what the
       seat is doing, so the darkroom reproduces the same windows. */
    var hitAt = null;
    PUNCHES.forEach(function(p){ if (ms >= p && ms < p + FLINCH) hitAt = p; });
    scope.querySelectorAll('.seat').forEach(function(seat){
      seat.classList.toggle('seat--ko-flinch', hitAt !== null);
      seat.querySelectorAll('.seat--ko-flinch, *').forEach(function(el){
        el.getAnimations().forEach(function(a){ a.pause(); a.currentTime = hitAt === null ? 0 : ms - hitAt; });
      });
      seat.getAnimations().forEach(function(a){ a.pause(); a.currentTime = hitAt === null ? 0 : ms - hitAt; });
    });
  });
}
requestAnimationFrame(function(){ requestAnimationFrame(freeze); });
setTimeout(freeze, 400);
</script>`;

/* ── PLAYBACK ───────────────────────────────────────────────────────────────
   The frozen contact sheet above answers "is this frame right". It cannot
   answer "does this read as a punch", which is a question about MOTION and is
   the one Dan actually asked. This second page plays the thing: a six-handed
   felt that busts a different seat every few seconds, a double knockout, the
   eight-way, an animation-speed switch (the setting is real and the CSS/JS
   pair must hold at 0.25x and 2x as well as 1x), and a scrubber for stepping
   through a beat by hand. */
const OVAL = [
  [50, 6], [88, 26], [88, 70], [50, 92], [12, 70], [12, 26],
];
const names = ['Gordo Chris', 'madswley', 'gemelo1234', 'ckone23', 'SunBum45', 'YANKEE'];
/* Seat 4 (ckone23) is the winner every time, so the money always flies to the
   same chair and the eye can follow it. */
const WINNER_SEAT = 3;
const felt6 = OVAL.map(
  ([x, y], i) =>
    `<div class="seatpos" style="left:${x}%;top:${y}%"><div class="seat" data-seat-num="${i + 1}">
      ${i === WINNER_SEAT ? '<span class="winner-tag">winner</span>' : ''}
      <div class="seat__av"></div>
      <div class="seat__cards"><span class="c c0"></span><span class="c c1"></span></div>
      <div class="seat__plate"><b>${names[i]}</b><i>${(12 + i * 7) * 100}</i></div></div></div>`
).join('');

const playback = `<!doctype html><meta charset="utf-8"><title>Knockout — playback</title>
<style>
:root{--animation-speed:1;--seat-avatar-base:84px;
  --bg:#0e1013;--fg:#eceaf0;--mut:#9a97a3;--line:#2b2b34}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);padding:22px 20px 60px;
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:15px;margin:30px 0 10px;padding-top:14px;border-top:1px solid var(--line);color:var(--mut)}
p.sub{color:var(--mut);margin:0 0 18px;max-width:72ch}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
button{background:#1b1e24;color:var(--fg);border:1px solid #343943;border-radius:7px;
  padding:7px 13px;font:inherit;font-size:13px;cursor:pointer}
button:hover{background:#242932}
button[aria-pressed="true"]{background:#b9902f;border-color:#b9902f;color:#12140f;font-weight:600}
label{color:var(--mut);font-size:13px;display:flex;gap:8px;align-items:center}
input[type=range]{width:260px;accent-color:#b9902f}
.table{position:relative;width:760px;max-width:100%;aspect-ratio:16/10;margin:0 0 8px;
  border-radius:50%/34%;background:
    radial-gradient(120% 120% at 42% 22%,#2f4139 0%,#1c2721 55%,#121a16 100%);
  box-shadow:inset 0 0 0 9px #7c5f22, inset 0 0 0 12px #241a08, inset 0 0 70px #000a, 0 18px 50px #0009}
.seatpos{position:absolute;transform:translate(-50%,-50%)}
.seat{position:relative;width:var(--seat-avatar-base);height:var(--seat-avatar-base)}
.seat__av{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 38% 30%,#6c5a45 0%,#3d3226 62%,#241d15 100%);
  box-shadow:0 0 0 2px #b9902f inset,0 2px 6px #0009}
.seat__cards{position:absolute;right:-6%;top:calc(var(--seat-avatar-base) - 7px);
  transform:translateY(-100%);width:calc(var(--seat-avatar-base)*.321);
  height:calc(var(--seat-avatar-base)*.346);filter:drop-shadow(0 2px 5px #0007);
  transition:opacity .2s}
.seat__cards .c{position:absolute;top:0;width:calc(var(--seat-avatar-base)*.247);height:100%;
  border-radius:2px;background:linear-gradient(#e8e8e8,#c2c2c2);
  box-shadow:0 0 0 1px #ffffff38;transform-origin:50% 120%}
.seat__cards .c0{left:calc(var(--seat-avatar-base)*.074);transform:rotate(4deg);z-index:2}
.seat__cards .c1{left:0;transform:rotate(-4deg)}
.seat__plate{position:absolute;left:50%;top:calc(var(--seat-avatar-base)*.92);
  transform:translateX(-50%);width:calc(var(--seat-avatar-base)*.76);background:#12161bdd;
  border-radius:3px;text-align:center;padding:1px 0;border:1px solid #ffffff1a;white-space:nowrap}
.seat__plate b{display:block;font-size:calc(var(--seat-avatar-base)*.115);color:#e6e6e6;font-weight:600}
.seat__plate i{display:block;font-size:calc(var(--seat-avatar-base)*.11);color:#d8c76a;font-style:normal}
.seat.out .seat__av{opacity:.25;filter:grayscale(1)}
.seat.out .seat__cards{opacity:0}
.seat.out .seat__plate{opacity:.4}
.now{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
${css}
${POT_FLOAT_CSS}
/* A stand-in for ChipAnimation's sprites — the real ones are DOM/canvas
   objects owned by TablePage and cannot be lifted into a static page. Same
   path, same 40ms stagger, same flight time; simpler discs. */
.hchip{position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,#fff 0%,#ffd75e 45%,#c8901a 100%);
  box-shadow:0 0 0 2px #7a5410 inset,0 2px 5px #0008;z-index:618;pointer-events:none}
.winner-tag{position:absolute;left:50%;top:-18px;transform:translateX(-50%);
  font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#ffe94a;
  text-shadow:0 1px 2px #000;white-space:nowrap}
/* Scrub mode only: the page drives currentTime by hand. */
body.scrub .sko, body.scrub .sko *{animation-play-state:paused!important}
</style>
<h1>Knockout — playback</h1>
<p class="sub">The real component markup against the real stylesheet, running. Seats bust on a
loop. <b>Speed</b> is the player's own Animation Speed setting — the CSS and the JS timers both
multiply by it, so if they ever drift apart, 0.25x is where you will see it.</p>

<div class="bar">
  <button id="one">Bust one seat</button>
  <button id="two">Double knockout</button>
  <button id="all">All eight</button>
  <button id="loop" aria-pressed="true">Loop: on</button>
  <button id="sound" aria-pressed="false">Sound: off</button>
  <span style="width:14px"></span>
  <span class="now">Speed</span>
  <button class="sp" data-s="0.25">0.25x</button>
  <button class="sp" data-s="0.5">0.5x</button>
  <button class="sp" data-s="1" aria-pressed="true">1x</button>
  <button class="sp" data-s="2">2x</button>
</div>
<div class="table" id="felt">${felt6}</div>
<div class="bar">
  <label><input type="checkbox" id="scrubon"> Scrub</label>
  <input type="range" id="scrub" min="0" max="2400" step="10" value="460" disabled>
  <span class="now" id="t">460 ms</span>
</div>

<h2>The same thing at 0.25x, for the frames the eye cannot catch</h2>
<div class="table" id="slow" style="width:520px">${felt6}</div>

<script>
const SKO_HTML = ${JSON.stringify(sko('P'))};
const DURATION = 2400, IMPACT = 460, STAMP = 930;
function speed(){ return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--animation-speed')) || 1; }

function knockout(root, seatNum){
  const pos = root.querySelectorAll('.seatpos')[seatNum];
  const seat = pos.querySelector('.seat');
  const layer = document.createElement('div');
  layer.className = 'sko-layer';
  layer.style.position = 'absolute';
  layer.style.left = '0'; layer.style.top = '0';
  layer.style.width = '0'; layer.style.height = '0';
  // Unique gradient ids per firing: <defs> ids are global to the document and
  // two live knockouts sharing one would silently repaint each other. This is
  // the same rule useId() enforces in the component.
  const uid = 'p' + Math.random().toString(36).slice(2, 8);
  layer.innerHTML = SKO_HTML.replace(/sko-([a-z]+)-P/g, 'sko-$1-' + uid);
  pos.appendChild(layer);
  const s = speed();
  setTimeout(() => {
    seat.classList.add('seat--ko-flinch');
    setTimeout(() => seat.classList.remove('seat--ko-flinch'), 350 * s);
  }, IMPACT * s);
  setTimeout(() => seat.classList.add('out'), (STAMP + 270) * s);
  setTimeout(() => { layer.remove(); seat.classList.remove('out'); }, DURATION * s + 400);
  /* The bounty ships on the SAME beat as the stamp — that is the whole point
     of TablePage coalescing it there, and it is why the money and the KO land
     together rather than on unrelated schedules. */
  if (seatNum !== WINNER_SEAT) {
    setTimeout(() => bountyFlight(root, seatNum, BOUNTY), STAMP * s);
  }
  playFlurry(false);
}

const felt = document.getElementById('felt');
const slow = document.getElementById('slow');
let seq = 0, timer = null, looping = true;

function fireOne(){ knockout(felt, seq % 6); knockout(slow, seq % 6); seq++; }
function fireTwo(){ knockout(felt, 1); knockout(felt, 4); knockout(slow, 1); knockout(slow, 4); }
function fireAll(){ for (let i = 0; i < 6; i++) knockout(felt, i); }

function schedule(){
  clearTimeout(timer);
  if (!looping) return;
  timer = setTimeout(() => {
    const n = seq % 8;
    if (n === 6) fireTwo(); else if (n === 7) fireAll(); else fireOne();
    seq++;
    schedule();
  }, DURATION * speed() + 900);
}

/* ── THE BOUNTY AWARD ────────────────────────────────────────────────────
   This is the part TablePage owns in the product: on the KO stamp beat it
   flies chips from the busted seat to the winner's chair and floats the
   summed "+N" along the same path (spawnPotWinFloat + createPotToWinnerEvent).
   None of that lives in SeatKnockout, which is why it was missing from this
   harness while shipping perfectly well in the app. Reproduced here so the
   whole sequence can be watched end to end.

   The "+N" element below uses the REAL .pot-win-float rule, read out of
   TablePage.css at build time. The chips are a stand-in. */
/* WINNER_SEAT is a BUILD-TIME const in the generator. Interpolate it — a bare
   reference here is just text inside a template literal, so it reaches the
   page as an undeclared identifier and throws the first time the bounty tries
   to fly. (The new Function() guard cannot catch that: it is a parse check,
   and an undefined variable is a runtime error.) */
var WINNER_SEAT = ${WINNER_SEAT};
var STAMP_MS = 930, BOUNTY = 2120;
function centreOf(el){
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function bountyFlight(root, fromSeatIdx, amount){
  var sp = root.querySelectorAll('.seatpos');
  var from = centreOf(sp[fromSeatIdx].querySelector('.seat'));
  var to = centreOf(sp[WINNER_SEAT].querySelector('.seat'));
  var sp2 = speed();

  // Chip fan: 3-8 sprites, 40ms apart, exactly as createPotToWinnerEvent does.
  var n = Math.min(Math.max(Math.round(amount / 400), 3), 8);
  for (var i = 0; i < n; i++) {
    (function(i){
      var c = document.createElement('div');
      c.className = 'hchip';
      var jx = (Math.random() - 0.5) * 20, jy = (Math.random() - 0.5) * 10;
      c.style.transform = 'translate(' + (from.x + jx - 8) + 'px,' + (from.y + jy - 8) + 'px)';
      c.style.transition = 'transform ' + (600 * sp2) + 'ms cubic-bezier(.3,.7,.3,1), opacity 200ms linear';
      document.body.appendChild(c);
      setTimeout(function(){
        c.style.transform = 'translate(' + (to.x + (Math.random() - 0.5) * 15 - 8) + 'px,' + (to.y - 8) + 'px)';
      }, 20 + i * 40 * sp2);
      setTimeout(function(){ c.style.opacity = '0'; }, (620 + i * 40) * sp2);
      setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, (900 + i * 40) * sp2);
    })(i);
  }

  // ONE float, carrying the TOTAL, riding the same path.
  var f = document.createElement('div');
  f.className = 'pot-win-float';
  f.textContent = '+' + Math.round(amount).toLocaleString('en-US');
  f.style.setProperty('--pwf-from-x', from.x + 'px');
  f.style.setProperty('--pwf-from-y', from.y + 'px');
  f.style.setProperty('--pwf-to-x', to.x + 'px');
  f.style.setProperty('--pwf-to-y', to.y + 'px');
  document.body.appendChild(f);
  setTimeout(function(){ if (f.parentNode) f.parentNode.removeChild(f); }, 2400 * sp2);
}

/* ── THE SOUND ───────────────────────────────────────────────────────────
   A faithful port of SoundService.playKnockoutFlurry, so the cue can be
   HEARD here rather than only read. Every number is the same one the service
   uses, and every number in the service was measured off Dan's capture:
   landings 180/320/460ms, body partials at 86 and 129Hz, a leather crack
   filtered at 1.5kHz (2.6kHz on the finish), a 3.8kHz snap on the finish
   only, and the called "K.O." gliding 342Hz down to 157Hz across 300ms.

   Browsers refuse to start audio without a user gesture, which is why this is
   behind a button rather than firing on the loop by itself. */
var actx = null, soundOn = false;
function ac(){ if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); return actx; }
function noise(at, dur, vol, lp){
  var c = ac(), n = Math.floor(c.sampleRate * dur), b = c.createBuffer(1, Math.max(n,1), c.sampleRate), d = b.getChannelData(0);
  for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  var src = c.createBufferSource(); src.buffer = b;
  var f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
  var g = c.createGain(); g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(f); f.connect(g); g.connect(c.destination); src.start(at);
}
function tone(at, hz, dur, vol, type){
  var c = ac(), o = c.createOscillator(), g = c.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(hz, at);
  g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + dur);
}
function koCall(at, dur, vol){
  var c = ac(), end = at + dur;
  noise(at, 0.035, vol * 0.5, 3200);              // the hard K
  var o = c.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(342, at);
  o.frequency.exponentialRampToValueAtTime(157, end);
  function formant(f0, f1, q, gain){
    var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, at);
    bp.frequency.exponentialRampToValueAtTime(f1, end);
    var g = c.createGain(); g.gain.value = gain;
    o.connect(bp); bp.connect(g); return g;
  }
  var amp = c.createGain();
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(vol, at + 0.055);
  amp.gain.setValueAtTime(vol, at + dur * 0.55);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  formant(640, 230, 6, 1).connect(amp);
  formant(1000, 650, 8, 0.7).connect(amp);
  amp.connect(c.destination);
  o.start(at); o.stop(end + 0.02);
}
function playFlurry(isHero){
  if (!soundOn) return;
  var c = ac(), t0 = c.currentTime, sp2 = speed();
  var punches = [180, 320, 460];
  noise(t0, 0.17 * sp2, 0.07, 2600);
  punches.forEach(function(ms, i){
    var at = t0 + (ms / 1000) * sp2, last = i === punches.length - 1;
    var g = last ? (isHero ? 1 : 0.85) : 0.5;
    tone(at, 86, 0.13 * sp2, 0.34 * g, 'sine');
    tone(at, 129, 0.10 * sp2, 0.20 * g, 'sine');
    noise(at, (last ? 0.12 : 0.055) * sp2, 0.24 * g, last ? 2600 : 1500);
    if (last) noise(at, 0.07 * sp2, 0.20 * g, 3800);
  });
  koCall(t0 + ((460 - 40) / 1000) * sp2, 0.30 * sp2, isHero ? 0.30 : 0.24);
  var stampAt = t0 + (STAMP_MS / 1000) * sp2;
  tone(stampAt, 880, 0.14 * sp2, 0.22, 'square');
  tone(stampAt + 0.01, 440, 0.20 * sp2, 0.16, 'triangle');
}

document.getElementById('sound').onclick = function(e){
  soundOn = !soundOn;
  if (soundOn) ac().resume();
  e.target.setAttribute('aria-pressed', String(soundOn));
  e.target.textContent = 'Sound: ' + (soundOn ? 'on' : 'off');
};

document.getElementById('one').onclick = fireOne;
document.getElementById('two').onclick = fireTwo;
document.getElementById('all').onclick = fireAll;
document.getElementById('loop').onclick = (e) => {
  looping = !looping;
  e.target.setAttribute('aria-pressed', String(looping));
  e.target.textContent = 'Loop: ' + (looping ? 'on' : 'off');
  schedule();
};
document.querySelectorAll('.sp').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.sp').forEach((o) => o.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    document.documentElement.style.setProperty('--animation-speed', b.dataset.s);
    schedule();
  };
});
document.getElementById('slow').closest('body');
slow.parentElement.querySelector('#slow').style.setProperty('--animation-speed', '4');

const scrub = document.getElementById('scrub'), tlabel = document.getElementById('t');
document.getElementById('scrubon').onchange = (e) => {
  document.body.classList.toggle('scrub', e.target.checked);
  scrub.disabled = !e.target.checked;
  looping = !e.target.checked;
  document.getElementById('loop').setAttribute('aria-pressed', String(looping));
  document.getElementById('loop').textContent = 'Loop: ' + (looping ? 'on' : 'off');
  if (e.target.checked){ clearTimeout(timer); felt.querySelectorAll('.sko-layer').forEach(n=>n.remove()); knockout(felt, 0); setTimeout(apply, 30); }
  else schedule();
};
function apply(){
  tlabel.textContent = scrub.value + ' ms';
  felt.querySelectorAll('*').forEach((el) => el.getAnimations().forEach((a) => { a.pause(); a.currentTime = Number(scrub.value); }));
}
scrub.oninput = apply;

fireOne(); schedule();
</script>`;

/* SYNTAX-CHECK THE EMITTED SCRIPT BEFORE WRITING IT.
   This page's whole behaviour lives in one inline <script> that is itself
   written inside a template literal, and a template literal eats backslashes:
   a regex written here as /-P\)/ is emitted as /-P)/, which is an invalid
   regex, which throws at parse time and kills the ENTIRE script. The page then
   renders a perfect, permanently motionless poker table with no error anywhere
   the user can see. That happened. It cost Dan a round trip and it would have
   happened again.

   new Function() parses without executing, so this catches the whole class —
   unbalanced regex, stray backtick, broken quote — at build time. */
const emitted = playback.slice(playback.lastIndexOf('<script>') + 8, playback.lastIndexOf('</script>'));
try {
  // eslint-disable-next-line no-new-func
  new Function(emitted);
} catch (err) {
  console.error('!! the playback page emitted a script that does not parse:');
  console.error(`   ${err.message}`);
  console.error('   Nothing was written. Look for an escape sequence the template literal ate.');
  process.exit(1);
}

const playFile = resolve(OUT, 'playback.html');
writeFileSync(playFile, playback);
console.log(`playback -> ${playFile}  (inline script parses)`);

const harness = resolve(OUT, 'harness.html');
writeFileSync(harness, page);
console.log(
  `harness -> ${harness}` +
    (refCount
      ? `  (${refCount}/${BEATS.length} reference frames embedded)`
      : `  (no reference column: ${existsSync(VIDEO) ? 'ffmpeg failed' : 'KO-VIDEO.MOV not found'})`)
);
console.log('Open it directly, or let Playwright shoot the beats below.');

/* Playwright is OPTIONAL on purpose. Its browsers, and the installed esbuild,
   are platform binaries; a sandboxed agent on a different arch can still write
   and open harness.html, and that must not be an error. */
let browser;
try {
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
} catch (err) {
  // Either the package is not installed, or its browsers are not downloaded
  // for this platform. Both are fine: harness.html is already written and is
  // the artefact that actually matters.
  console.log(`playwright unavailable (${String(err).split('\n')[0]})`);
  console.log('harness.html is written — open it in a browser.');
  process.exit(0);
}

const tab = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
await tab.goto(`file://${harness}`);
await tab.waitForTimeout(600);

for (const [ms] of BEATS) {
  const fig = tab.locator('figure.cmp', { hasText: `+${ms}ms` }).first();
  await fig.screenshot({ path: resolve(OUT, `t${String(ms).padStart(4, '0')}.png`) });
}
await tab.locator('.multi').screenshot({ path: resolve(OUT, 'multi-8.png') });
await tab.locator('.bps').first().screenshot({ path: resolve(OUT, 'breakpoints.png') });
await tab.locator('#rm').screenshot({ path: resolve(OUT, 'reduced-motion.png') });
await tab.screenshot({ path: resolve(OUT, 'all.png'), fullPage: true });
await browser.close();
console.log(`${BEATS.length} beats + multi + breakpoints + reduced-motion -> ${OUT}`);
