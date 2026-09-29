#!/usr/bin/env node
/**
 * Diamond bonus games: frame timing of the three WebGL scenes on a throttled,
 * phone-shaped headless Chromium, against the fixture page (no account, no
 * wallet), the way diamond-wheel-render.mjs measures the wheel.
 *
 *   node scripts/dev/diamond-scene-perf.mjs [game=all] [cpuThrottle=4] [seconds=6] [baseUrl]
 *       game: crash | crossing | plinko | all
 *
 * For each game: requestAnimationFrame deltas and long tasks are sampled while
 * the scene idles and again while a round is in flight, and the quality tier
 * the governor settled on is read back from sessionStorage. Prints median and
 * 95th percentile frame times. WebGL here runs on SwiftShader, so absolute
 * numbers are those of a phone with no GPU; the comparison that matters is
 * before/after on the same machine.
 */
import { chromium } from '@playwright/test';

const [, , which = 'all', cpuThrottle = '4', seconds = '6', baseUrl = 'http://127.0.0.1:5199/hub/club-arena'] = process.argv;
const games = which === 'all' ? ['crash', 'crossing', 'plinko'] : [which];

function stats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    frames: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    over50: sorted.filter((d) => d > 50).length,
  };
}
function sample(page, secs) {
  return page.evaluate(
    (ms) =>
      new Promise((done) => {
        const deltas = [];
        let longTasks = 0,
          longTaskMs = 0;
        let observer = null;
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTasks += 1;
              longTaskMs += entry.duration;
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
        } catch {
          observer = null;
        }
        let previous = performance.now();
        const start = previous;
        const tick = (now) => {
          deltas.push(now - previous);
          previous = now;
          if (now - start < ms) requestAnimationFrame(tick);
          else {
            observer?.disconnect();
            done({ deltas, longTasks, longTaskMs });
          }
        };
        requestAnimationFrame(tick);
      }),
    secs * 1000
  );
}
const report = (label, run) => {
  const s = stats(run.deltas);
  console.log(
    `  ${label}: ${s.frames} frames, median ${s.median.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms, ${s.over50} over 50 ms, ${run.longTasks} long tasks (${run.longTaskMs.toFixed(0)} ms)`
  );
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`CPU throttle ${cpuThrottle}x, 393x852 @3x, ${seconds}s per sample`);
for (const game of games) {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: Number(cpuThrottle) });
  await page.goto(`${baseUrl}/diamond-test.html?game=${game}`, { waitUntil: 'networkidle' });
  await page.locator('canvas').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(2000);
  console.log(game);
  report('idle', await sample(page, Number(seconds)));
  await page.getByRole('button', { name: 'Start Test', exact: true }).click();
  await page.waitForTimeout(400);
  if (game === 'crossing') {
    const cross = page.getByRole('button', { name: 'Cross Next Road', exact: true });
    if (await cross.isEnabled().catch(() => false)) await cross.click();
  }
  report('round', await sample(page, Number(seconds)));
  const tier = await page.evaluate(() => sessionStorage.getItem('ca:diamond-scene-quality'));
  const ratio = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? (c.width / c.getBoundingClientRect().width).toFixed(2) : 'n/a';
  });
  console.log(`  governor tier: ${tier ?? '0 (best)'}; canvas pixels per CSS pixel: ${ratio}`);
  await context.close();
}
await browser.close();
