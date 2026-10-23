import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function registerGameLobbyCardCases() {
  test('selected cash, tournament, spin and heads-up cards survive overflowing details', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const bundled = buildSync({
      entryPoints: ['tests/e2e/support/gameLobbyCardFixture.tsx'],
      jsx: 'automatic',
      outfile: 'game-card-fixture.js',
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      loader: {
        '.css': 'empty',
        '.webp': 'dataurl',
        '.png': 'dataurl',
        '.svg': 'dataurl',
        '.jpg': 'dataurl',
      },
      define: {
        'import.meta.env': JSON.stringify({
          VITE_SUPABASE_URL: 'https://fixture.invalid',
          VITE_SUPABASE_ANON_KEY: 'local-fixture',
          VITE_MEDIA_BASE: 'https://fixture.invalid/hub/club-arena/',
          DEV: true,
        }),
        'process.env.NODE_ENV': '"test"',
      },
    });
    const readStyle = (file: string): string =>
      readFileSync(resolve(file), 'utf8').replace(
        /^\s*@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/gm,
        (_, imported: string) => readStyle(resolve(dirname(file), imported))
      );
    const sheets = [
      ...new Set([
        'src/styles/club-engine.css',
        'src/styles/metallic-popups.css',
        ...Object.keys(bundled.metafile!.inputs).filter((file) => file.endsWith('.css')),
      ]),
    ];
    const css = sheets.map(readStyle).join('\n');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 393, height: 700 });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/rest/v1/')) return route.fulfill({ json: null });
      if (url.hostname === 'game-card.fixture' && url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<html data-kind="${url.searchParams.get('kind')}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
        });
      const file = resolve(
        'public',
        url.pathname.replace(/^\/hub\/club-arena\//, '').replace(/^\//, '')
      );
      if (file.startsWith(resolve('public') + '/') && existsSync(file))
        return route.fulfill({ body: readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    });
    for (const kind of ['cash', 'mtt', 'spin', 'sng']) {
      await page.goto(`http://game-card.fixture/?kind=${kind}`);
      await page.addScriptTag({
        content: bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
      });
      const card = page.locator('.glp__arena-card');
      await expect(card, kind).toBeVisible();
      const before = await card.boundingBox();
      expect(
        before!.height,
        `${kind} selected card collapsed into its flex scroll body`
      ).toBeGreaterThan(200);
      const scroll = page.locator('.glp__scroll');
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const after = await card.boundingBox();
      expect(after!.height, `${kind} card shrank while scrolling details`).toBeCloseTo(
        before!.height,
        1
      );
      expect(
        await scroll.evaluate((el) => el.scrollHeight > el.clientHeight),
        `${kind} details remain scrollable`
      ).toBe(true);
      await expect(page.locator('.glp__close')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
