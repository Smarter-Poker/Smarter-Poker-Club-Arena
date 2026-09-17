/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  public-a11y - the public arena passes an accessibility audit on every build
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DISCOVERABILITY PHASE 6 (2026-09-17). The pages Google ranks (the landing,
 * Help Center and the legal documents: every route dist/prerender-manifest.json
 * lists) are the pages a first-time visitor, a screen reader and a crawler
 * meet first. Accessibility is a ranking input in the page-experience sense
 * (headings, names, contrast, landmarks are what an assistive reader and a
 * crawler both use to understand a page), and it was never measured here.
 *
 * Each route is loaded from Vite preview the way production serves it
 * (prerendered HTML first, the bundle hydrating over it) at a phone and a
 * desktop viewport, then audited with axe-core (WCAG 2.1 A and AA, plus the
 * best-practice rules). A serious or critical violation fails the build and
 * prints the rule, the fix, and every offending node so the failure is
 * actionable from the log. Moderate and minor findings are printed and do not
 * fail, so they are visible without blocking a release.
 *
 * Nothing here is hand-listed: a route the prerender gains is audited the
 * next time this runs, and an empty manifest fails the gate.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { portFor } from './e2e-port.mjs';

const HOST = '127.0.0.1';
const PORT = portFor(4177);
const ORIGIN = `http://${HOST}:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = path.join(ROOT, process.env.CA_DIST || 'dist', 'prerender-manifest.json');

export const FAILING_IMPACTS = new Set(['serious', 'critical']);
export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

export function prerenderedRoutes(manifestPath = MANIFEST) {
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return (manifest.routes || []).map((entry) =>
    entry.route === '/' ? '/hub/club-arena/' : `/hub/club-arena${entry.route}/`
  );
}

/** One line per violation, one indented line per node, so the log is the fix list. */
export function describeViolation(v) {
  const nodes = v.nodes
    .slice(0, 8)
    .map((n) => `      - ${n.target.join(' ')}${n.failureSummary ? `\n        ${n.failureSummary.split('\n').join('\n        ')}` : ''}`)
    .join('\n');
  const more = v.nodes.length > 8 ? `\n      ... and ${v.nodes.length - 8} more` : '';
  return `    [${v.impact}] ${v.id}: ${v.help} (${v.helpUrl})\n${nodes}${more}`;
}

const routes = prerenderedRoutes();
if (routes.length === 0) {
  console.error('[public-a11y] FAILED: dist/prerender-manifest.json has no routes; the public arena was not prerendered.');
  process.exit(1);
}

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
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
      await page.goto(`${ORIGIN}${route}`, { waitUntil: 'load', timeout: 15_000 });
      // The hydrated tree, not only the prerender: the audit covers what a
      // visitor with JavaScript gets, which is a superset of the static HTML.
      await page.waitForSelector('#root > *', { timeout: 10_000 });
      await page.waitForTimeout(500);
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = results.violations.filter((v) => FAILING_IMPACTS.has(v.impact));
      const advisory = results.violations.filter((v) => !FAILING_IMPACTS.has(v.impact));
      console.log(
        `[public-a11y] ${viewport.name} ${route} passes=${results.passes.length} ` +
          `violations=${results.violations.length} (blocking ${blocking.length}, advisory ${advisory.length})`
      );
      for (const v of advisory) console.log(describeViolation(v));
      if (blocking.length) {
        failed = true;
        console.error(`[public-a11y] FAILED: ${viewport.name} ${route}`);
        for (const v of blocking) console.error(describeViolation(v));
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
console.log('[public-a11y] OK - the public arena has no serious or critical accessibility violations.');
