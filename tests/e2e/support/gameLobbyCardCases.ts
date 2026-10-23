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
        'src/components/layouts/AppLayout.module.css',
        'src/components/navigation/GlobalHeader.module.css',
        ...Object.keys(bundled.metafile!.inputs).filter((file) => file.endsWith('.css')),
      ]),
    ];
    const css = sheets.map(readStyle).join('\n');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/rest/v1/')) return route.fulfill({ json: null });
      if (url.hostname === 'game-card.fixture' && url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          // The real shell isolates route content beneath persistent chrome.
          // A dialog can be visible yet have its Close control covered by it.
          body: `<html data-kind="${url.searchParams.get('kind')}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="overflow:auto"><header class="header"><button style="width:100%;height:44px">Messages</button></header><main class="casinoStage"><div id="root"></div></main><nav aria-label="Fixture Footer" style="position:fixed;bottom:0;width:100%;height:60px;z-index:1000">Footer</nav></body></html>`,
        });
      const file = resolve(
        'public',
        url.pathname.replace(/^\/hub\/club-arena\//, '').replace(/^\//, '')
      );
      if (file.startsWith(resolve('public') + '/') && existsSync(file))
        return route.fulfill({ body: readFileSync(file) });
      return route.fulfill({ status: 404, body: '' });
    });
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 812, height: 375 },
    ]) {
      await page.setViewportSize(viewport);
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
        await page.getByRole('button', { name: 'Close Game Lobby', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('auto');
        const reopen = page.getByRole('button', { name: 'Open Game Lobby', exact: true });
        // Safari touch clicks need not focus buttons. Restore keyboard focus
        // from a keyboard opening, then exercise pointer entry separately.
        await reopen.focus();
        await reopen.press('Enter');
        await expect(
          page.getByRole('button', { name: 'Close Game Lobby', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(reopen).toBeFocused();
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('auto');
        await reopen.click();
        await page.getByRole('link', { name: 'Back To All Games', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  });
}
