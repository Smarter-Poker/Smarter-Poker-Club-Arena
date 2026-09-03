import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const HOST = '127.0.0.1';
const PORT = 4173;
const ORIGIN = `http://${HOST}:${PORT}`;
// AuthGuard correctly hands signed-out users to the World Hub's /auth/login,
// which is outside Vite preview. Exercise two public in-SPA routes here so the
// gate measures rendered Club Arena rather than a missing local Hub shell.
const routes = ['/hub/club-arena/legal', '/hub/club-arena/health'];
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 1000 },
];

const preview = spawn(
  process.platform === 'win32' ? 'node_modules/.bin/vite.cmd' : 'node_modules/.bin/vite',
  ['preview', '--host', HOST, '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' }
);

const waitForPreview = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/hub/club-arena/`);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Vite preview did not become ready.');
};

let browser;
let failed = false;

try {
  await waitForPreview();
  browser = await chromium.launch({ headless: true });

  for (const viewport of viewports) {
    for (const route of routes) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const devtools = await context.newCDPSession(page);
      await devtools.send('Performance.enable');
      await page.addInitScript(() => {
        window.__routeMetrics = { lcp: 0, cls: 0 };
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) window.__routeMetrics.lcp = last.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__routeMetrics.cls += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });

      const response = await page.goto(`${ORIGIN}${route}`, { waitUntil: 'load', timeout: 15_000 });
      await page.waitForSelector('#root > *', { timeout: 10_000 });
      await page.waitForTimeout(500);
      const devtoolsMetrics = await devtools.send('Performance.getMetrics');
      const metric = (name) =>
        devtoolsMetrics.metrics.find((entry) => entry.name === name)?.value || 0;
      const devtoolsFcp = Math.max(
        0,
        (metric('FirstContentfulPaint') - metric('NavigationStart')) * 1000
      );
      const metrics = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        const routeMetrics = window.__routeMetrics || { lcp: 0, cls: 0 };
        const firstContentfulPaint = performance
          .getEntriesByType('paint')
          .find((entry) => entry.name === 'first-contentful-paint');
        return {
          status: document.readyState,
          responseStatus: 0,
          domContentLoaded: navigation.domContentLoadedEventEnd,
          load: navigation.loadEventEnd,
          lcp: routeMetrics.lcp,
          fcp: firstContentfulPaint?.startTime || 0,
          cls: routeMetrics.cls,
          transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
          horizontalOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rootChildren: document.querySelector('#root')?.childElementCount || 0,
          bodyTextLength: document.body.innerText.trim().length,
        };
      });
      metrics.responseStatus = response?.status() || 0;
      metrics.fcp = devtoolsFcp || metrics.fcp;

      const violations = [];
      if (metrics.responseStatus >= 400 || metrics.responseStatus === 0)
        violations.push('HTTP status');
      if (metrics.status !== 'complete') violations.push('document incomplete');
      if (metrics.rootChildren < 1) violations.push('React root empty');
      if (metrics.bodyTextLength < 5) violations.push('visible content empty');
      if (metrics.domContentLoaded > 3500) violations.push('DOMContentLoaded > 3500ms');
      if (metrics.load > 5000) violations.push('load > 5000ms');
      if (metrics.fcp <= 0) violations.push('FCP unavailable');
      if (metrics.fcp > 2500) violations.push('FCP > 2500ms');
      if (metrics.lcp > 4000) violations.push('LCP > 4000ms');
      if (metrics.cls > 0.15) violations.push('CLS > 0.15');
      if (metrics.transferBytes > 3_000_000) violations.push('transfer > 3MB');
      if (metrics.horizontalOverflow > 1) violations.push('horizontal overflow');

      console.log(
        `[route-performance] ${viewport.name} ${route} ` +
          `dcl=${Math.round(metrics.domContentLoaded)}ms load=${Math.round(metrics.load)}ms ` +
          `fcp=${Math.round(metrics.fcp)}ms lcp=${Math.round(metrics.lcp)}ms cls=${metrics.cls.toFixed(3)} ` +
          `transfer=${Math.round(metrics.transferBytes / 1024)}kB overflow=${metrics.horizontalOverflow}px`
      );
      if (violations.length) {
        failed = true;
        console.error(`[route-performance] FAILED: ${violations.join(', ')}`);
      }
      await page.close();
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
}

if (failed) process.exit(1);
console.log('[route-performance] OK — public shell meets route and responsive budgets.');
