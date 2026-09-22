#!/usr/bin/env node
/**
 * The Diamonds three-card popup (R15): headless render on the real console
 * art, at the two widths the standard asks for. No backend, no account, no
 * wallet - the RPC is a resolved promise, so what is drawn is only the real
 * component, the real stylesheets and the real painted chassis.
 *
 *   node scripts/dev/diamond-cards-render.mjs <outDir> [label]
 *       Shoots every state (face down, the pick revealed, a server refusal) at
 *       393 and 1280 CSS px wide, and prints each card's box so a label can be
 *       proved to sit inside its face rather than on a rim.
 *
 * Environment:
 *   PW_CHROMIUM=/path/to/chrome   when Playwright's own download is absent
 *                                 (this sandbox keeps one at /opt/pw-browsers/chromium)
 *   FONT_DIR=/path/to/woff2       Inter and Roboto Condensed. WITHOUT THEM
 *                                 every fitted label measures wrong and the
 *                                 render lies to you (#ClubArenaConsole, §6).
 */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const [, , outDir = '/tmp/diamond-cards', label = 'c4-cards'] = process.argv;
const FONT_DIR = process.env.FONT_DIR ? resolve(process.env.FONT_DIR) : null;
const STATES = ['facedown', 'revealed', 'refused'];

async function bundle() {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {DiamondCardPick} from './src/components/wheel/DiamondCardPick';
        const award={id:'d1000000-0000-4000-8000-0000000000c1',spin_id:'d1000000-0000-4000-8000-0000000000c2',risk_diamonds:2500};
        const paid={ok:true,award_id:award.id,picked:2,cards:[5000,7500,1250],paid_diamonds:7500,balances:{diamonds:12500}};
        const refusal={ok:false,error:'This Card Pick Is Already Made',award_id:award.id,picked:0,cards:[],paid_diamonds:0,balances:{diamonds:0}};
        const state=new URLSearchParams(location.search).get('state')||'facedown';
        const onPick=async()=>state==='refused'?refusal:paid;
        createRoot(document.getElementById('root')).render(
          <DiamondCardPick award={award} onPick={onPick} onClose={()=>{}}/>
        );
      `,
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/diamond-cards-fixture',
    format: 'iife',
    define: { 'import.meta.env': '{"DEV":false,"BASE_URL":"/","VITE_NATIVE":"0"}' },
    external: ['/assets/*', '/fonts/*', '@capacitor/haptics'],
    logLevel: 'silent',
  });
  return {
    javascript: result.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: result.outputFiles.find((f) => f.path.endsWith('.css')).text,
  };
}

/** @font-face for whatever woff2 files FONT_DIR holds, named by their file. */
function fontCss() {
  if (!FONT_DIR) return '';
  return readdirSync(FONT_DIR)
    .filter((f) => f.endsWith('.woff2'))
    .map((f) => {
      const family = f.startsWith('RobotoCondensed') ? 'Roboto Condensed' : 'Inter';
      const weight = /-(\d+)\.woff2$/.exec(f)?.[1] ?? '400';
      return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url('/fonts/${f}') format('woff2')}`;
    })
    .join('\n');
}

async function shoot() {
  mkdirSync(outDir, { recursive: true });
  const code = await bundle();
  const assetRoot = resolve('public/assets');
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    headless: true,
  });
  const report = [];
  for (const [width, height] of [
    [393, 852],
    [1280, 800],
  ]) {
    for (const state of STATES) {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      await page.setViewportSize({ width, height });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== 'https://diamond-cards.test') return route.abort();
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fontCss()}:root{--animation-speed:1}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font-family:Inter,system-ui,sans-serif}</style><div id="root"></div>`,
          });
        if (url.pathname.startsWith('/fonts/') && FONT_DIR) {
          const font = resolve(FONT_DIR, '.' + url.pathname.replace('/fonts', ''));
          return font.startsWith(FONT_DIR + sep) ? route.fulfill({ path: font }) : route.abort();
        }
        if (!url.pathname.startsWith('/assets/')) return route.abort();
        const path = resolve('public', '.' + decodeURIComponent(url.pathname));
        return path.startsWith(assetRoot + sep) ? route.fulfill({ path }) : route.abort();
      });
      await page.goto(`https://diamond-cards.test/?state=${state}`);
      await page.addStyleTag({ content: code.css });
      await page.addScriptTag({ content: code.javascript });
      await page.waitForSelector('[role="dialog"]');
      if (state !== 'facedown') {
        await page.click('[data-card="2"]');
        await page.waitForTimeout(1400);
      }
      await page.evaluate(() =>
        Promise.all(
          [...document.images]
            .filter((i) => !i.complete)
            .map((i) => new Promise((done) => i.addEventListener('load', done, { once: true })))
        )
      );
      await page.waitForTimeout(250);
      const file = resolve(outDir, `${label}-${state}-${width}.png`);
      await page.screenshot({ path: file });
      report.push({
        state,
        width,
        file,
        cards: await page.evaluate(() =>
          [...document.querySelectorAll('[data-card]')].map((card) => {
            const r = card.getBoundingClientRect();
            const label = card.getAttribute('aria-label');
            return { label, x: Math.round(r.x), width: Math.round(r.width) };
          })
        ),
        overflow: await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        ),
      });
      await page.close();
    }
  }
  await browser.close();
  for (const row of report)
    console.log(
      `${String(row.width).padStart(4)}px ${row.state.padEnd(9)} overflow=${row.overflow} ` +
        row.cards.map((c) => `[${c.x},${c.width}]`).join(' ') +
        `  ${row.file}`
    );
}

shoot().catch((error) => {
  console.error(error);
  process.exit(1);
});
