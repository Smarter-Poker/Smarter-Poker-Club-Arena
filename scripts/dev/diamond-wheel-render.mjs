#!/usr/bin/env node
/**
 * Diamond Spins wheel: headless render, selector alignment proof and frame
 * timing. No backend, no account, no wallet: the wheel mounts from the same
 * settled receipt fixture the e2e spec uses (tests/e2e/helpers/diamond-wheel-fixture.mjs).
 *
 *   node scripts/dev/diamond-wheel-render.mjs shots <outDir> [label]
 *       Screenshots the mounted wheel at 393 and 1280 CSS px wide and prints
 *       the holder's horizontal centre against the wheel centre (R5 proof).
 *
 *   node scripts/dev/diamond-wheel-render.mjs perf [cpuThrottle=4] [seconds=10]
 *       393x852 at deviceScaleFactor 3 with CPU throttling; samples
 *       requestAnimationFrame deltas for `seconds` of idle and again during a
 *       spin, and counts long tasks. Prints median and 95th percentile frame
 *       times (R20 before/after evidence).
 *
 * Environment: PW_CHROMIUM=/path/to/chrome when Playwright's own download is
 * absent (this sandbox keeps one at /opt/pw-browsers/chromium).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { diamondWheelFixture } from '../../tests/e2e/helpers/diamond-wheel-fixture.mjs';

const [, , command = 'shots', ...rest] = process.argv;

async function launch() {
  const executablePath = process.env.PW_CHROMIUM || undefined;
  return chromium.launch({ executablePath, headless: true });
}

async function mount(page, kind, { width, height, speed = 1 }) {
  const bundle = await diamondWheelFixture();
  const assetRoot = resolve('public/assets');
  await page.setViewportSize({ width, height });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://diamond-wheel.test') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--animation-speed:${speed}}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font-family:Arial}output{position:absolute;left:0;top:0;font-size:1px}</style><div id="root"></div>`,
      });
    if (!url.pathname.startsWith('/assets/')) return route.abort();
    const path = resolve('public', '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(assetRoot + sep)) return route.abort();
    return route.fulfill({ path });
  });
  await page.goto('https://diamond-wheel.test/?kind=' + kind);
  await page.addStyleTag({ content: bundle.css });
  await page.addScriptTag({ content: bundle.javascript });
  await page.waitForSelector('[aria-label="Diamond Wheel"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-painted-band="loading"]').length === 0 &&
      document.querySelectorAll('[data-painted-band="cached"]').length >= 64
  );
  await page.evaluate(() =>
    Promise.all(
      [...document.images]
        .filter((image) => !image.complete)
        .map((image) => new Promise((done) => image.addEventListener('load', done, { once: true })))
    )
  );
  return bundle;
}

/** The holder centre is the centre of the darkest, most opaque columns of the
 * selector mount image; the wheel centre is the aperture's horizontal middle. */
async function measureAlignment(page) {
  return page.evaluate(() => {
    const wheel = document.querySelector('[aria-label="Diamond Wheel"]');
    const face = wheel.getBoundingClientRect();
    const images = [
      ...wheel.querySelectorAll('[data-wheel-selector] image, [data-wheel-selector] img'),
    ];
    const mount = wheel.querySelector('[data-selector-holder]') ?? images[0] ?? null;
    const pointer = wheel.querySelector('[data-selector-pointer]') ?? images.at(-1) ?? null;
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const holder = mount ? box(mount) : null;
    const crystal = pointer ? box(pointer) : null;
    return {
      wheelCentreX: (face.left + face.right) / 2,
      holderCentreX: holder ? (holder.left + holder.right) / 2 : null,
      holderWidth: holder ? holder.right - holder.left : null,
      pointerCentreX: crystal ? (crystal.left + crystal.right) / 2 : null,
      pointerTipY: crystal ? crystal.bottom : null,
      viewportWidth: innerWidth,
    };
  });
}

async function shots(outDir, label) {
  mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const results = [];
  for (const [width, height] of [
    [393, 852],
    [1280, 800],
  ]) {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await mount(page, 'prize', { width, height });
    // Let the idle drift settle the pointer between two seams before measuring.
    await page.waitForTimeout(400);
    const alignment = await measureAlignment(page);
    const file = resolve(outDir, `${label}-${width}.png`);
    await page.screenshot({ path: file });
    const zoom = resolve(outDir, `${label}-${width}-selector.png`);
    const holder = await page.evaluate(() => {
      const wheel = document.querySelector('[aria-label="Diamond Wheel"]');
      const images = [...wheel.querySelectorAll('[data-wheel-selector] image')];
      const mount = wheel.querySelector('[data-selector-holder]') ?? images[0];
      const rect = mount.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
    await page.screenshot({
      path: zoom,
      clip: {
        x: holder.x - holder.width * 0.5,
        y: holder.y - holder.height * 0.6,
        width: holder.width * 2,
        height: holder.height * 3.2,
      },
    });
    results.push({ width, file, zoom, ...alignment });
    await page.close();
  }
  await browser.close();
  for (const r of results) {
    const offset = r.holderCentreX === null ? null : r.holderCentreX - r.wheelCentreX;
    console.log(
      `${r.width}px: wheel centre ${r.wheelCentreX.toFixed(2)}, holder centre ${r.holderCentreX?.toFixed(2)} (offset ${offset?.toFixed(2)} px, holder ${r.holderWidth?.toFixed(1)} px wide), pointer centre ${r.pointerCentreX?.toFixed(2)} tip y ${r.pointerTipY?.toFixed(1)}`
    );
    console.log(`  ${r.file}\n  ${r.zoom}`);
  }
  return results;
}

function stats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    frames: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    over50: sorted.filter((d) => d > 50).length,
  };
}

async function sample(page, seconds) {
  return page.evaluate(
    (ms) =>
      new Promise((done) => {
        const deltas = [];
        let longTasks = 0;
        let longTaskMs = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks += 1;
            longTaskMs += entry.duration;
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
        let previous = performance.now();
        const start = previous;
        const tick = (now) => {
          deltas.push(now - previous);
          previous = now;
          if (now - start < ms) requestAnimationFrame(tick);
          else {
            observer.disconnect();
            done({ deltas, longTasks, longTaskMs });
          }
        };
        requestAnimationFrame(tick);
      }),
    seconds * 1000
  );
}

async function perf(cpuThrottle = 4, seconds = 10) {
  const browser = await launch();
  const page = await browser.newPage({ deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: Number(cpuThrottle) });
  await mount(page, 'prize', { width: 393, height: 852 });
  await page.waitForTimeout(500);
  const idle = await sample(page, Number(seconds));
  await page.getByRole('button', { name: 'Preview Spin', exact: true }).click();
  await page.waitForTimeout(300);
  const spin = await sample(page, Math.min(Number(seconds), 9));
  await browser.close();
  const report = (name, run) => {
    const s = stats(run.deltas);
    console.log(
      `${name}: ${s.frames} frames, median ${s.median.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms, ${s.over50} frames over 50 ms, ${run.longTasks} long tasks (${run.longTaskMs.toFixed(0)} ms)`
    );
  };
  console.log(`CPU throttle ${cpuThrottle}x, 393x852 @3x`);
  report('idle', idle);
  report('spin', spin);
}

if (command === 'shots') await shots(rest[0] || 'tmp/wheel-shots', rest[1] || 'wheel');
else if (command === 'perf') await perf(rest[0], rest[1]);
else {
  console.error('usage: diamond-wheel-render.mjs shots <outDir> [label] | perf [cpu] [seconds]');
  process.exit(2);
}
