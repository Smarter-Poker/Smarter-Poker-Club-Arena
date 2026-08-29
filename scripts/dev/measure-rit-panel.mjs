/**
 * Measure the run-it-twice consent panel on real phone viewports.
 *
 * Dan 2026-08-28: "the run it twice pop up is blocked and you can't click run
 * it once, twice or 3 times. It's cut off."
 *
 * The unit test pins the CSS declarations; this renders the real stylesheet at
 * real device sizes and reports whether every button is actually inside the
 * visible viewport and big enough to hit. Run it after touching RunItTwice.css:
 *
 *     node scripts/dev/measure-rit-panel.mjs
 *
 * No dev server, no login, no arithmetic done in a comment.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../src/components/table/RunItTwice.css'), 'utf8');

/** The chooser's panel: the widest action row the component can produce. */
const panel = (rows) => `
<div class="rit-overlay">
  <div class="rit-panel" role="dialog">
    <h3 class="rit-panel__title">Run It Multiple Times</h3>
    <div class="rit-panel__board-row">
      <span class="rit-panel__board-label">Board:</span>
      <div class="rit-panel__board-cards">
        ${'<span class="rit-panel__card rit-panel__card--back"></span>'.repeat(5)}
      </div>
    </div>
    <div class="rit-panel__meta">
      <span class="rit-panel__pot">Pot: 12,480</span>
      <span class="rit-panel__countdown">Countdown: 19s</span>
    </div>
    <div class="rit-panel__timer-bar"><div class="rit-panel__timer-fill" style="width:76%"></div></div>
    <div class="rit-panel__players">
      ${Array.from(
        { length: rows },
        (_, i) => `
      <div class="rit-panel__player">
        <div class="rit-panel__player-cards">
          <span class="rit-panel__card rit-panel__card--sm" style="width:22px;height:31px"></span>
          <span class="rit-panel__card rit-panel__card--sm" style="width:22px;height:31px"></span>
        </div>
        <span class="rit-panel__player-name">Player ${i + 1}</span>
        <span class="rit-panel__player-equity">52.34%</span>
        <span class="rit-panel__check rit-panel__check--on">&#10003;</span>
      </div>`
      ).join('')}
    </div>
    <p class="rit-panel__message">You Have The Best Hand. Choose How Many Times To Run It.</p>
    <div class="rit-panel__actions">
      <button class="rit-panel__btn rit-panel__btn--decline">Run Once</button>
      <button class="rit-panel__btn rit-panel__btn--accept">Run It Twice</button>
      <button class="rit-panel__btn rit-panel__btn--accept rit-panel__btn--triple">Run It 3 Times</button>
    </div>
  </div>
</div>`;

const DEVICES = [
  { label: 'iPhone SE', w: 375, h: 667 },
  { label: 'iPhone 12/13/14', w: 390, h: 844 },
  { label: 'iPhone 14 Pro Max', w: 430, h: 932 },
  { label: 'small android', w: 360, h: 740 },
  { label: 'very small', w: 320, h: 568 },
];

/** A 9-way all-in is the tallest the panel can ever be. */
const ROWS = [2, 5, 9];

const browser = await chromium.launch();
const rows = [];
let bad = 0;

for (const d of DEVICES) {
  for (const n of ROWS) {
    const page = await browser.newPage({ viewport: { width: d.w, height: d.h } });
    await page.setContent(
      `<style>*{box-sizing:border-box}html,body{margin:0;height:100%}${css}</style>${panel(n)}`
    );

    const m = await page.evaluate(() => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const btns = [...document.querySelectorAll('.rit-panel__btn')].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent.trim(), top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, w: r.width };
      });
      const actions = document.querySelector('.rit-panel__actions').getBoundingClientRect();
      const p = document.querySelector('.rit-panel');
      return {
        vw,
        vh,
        btns,
        actionRows: new Set(btns.map((b) => Math.round(b.top))).size,
        panelH: p.getBoundingClientRect().height,
        scrolls: p.scrollHeight > p.clientHeight + 1,
        actionsBottom: actions.bottom,
      };
    });

    const offscreen = m.btns.filter(
      (b) => b.bottom > m.vh + 0.5 || b.top < -0.5 || b.left < -0.5 || b.right > m.vw + 0.5
    );
    const tooSmall = m.btns.filter((b) => b.h < 44 || b.w < 60);
    const ok = offscreen.length === 0 && tooSmall.length === 0;
    if (!ok) bad++;

    rows.push({
      device: d.label,
      viewport: `${d.w}x${d.h}`,
      'all-in players': n,
      'panel h': Math.round(m.panelH),
      'panel scrolls': m.scrolls ? 'yes' : 'no',
      'button rows': m.actionRows,
      'smallest button': `${Math.round(Math.min(...m.btns.map((b) => b.w)))}x${Math.round(Math.min(...m.btns.map((b) => b.h)))}`,
      'buttons off screen': offscreen.length,
      verdict: ok ? 'OK' : offscreen.length ? 'CUT OFF' : 'TOO SMALL',
    });
    await page.close();
  }
}

await browser.close();
console.table(rows);
console.log(bad === 0 ? '\nAll buttons reachable and hittable on every size.' : `\n${bad} FAILING combinations.`);
process.exit(bad === 0 ? 0 : 1);
