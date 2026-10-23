import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function registerGameLobbyCardCases() {
  test('selected cash, tournament, spin and heads-up cards survive overflowing details', async ({
    page,
  }, testInfo) => {
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
          body: `<html data-kind="${url.searchParams.get('kind')}" data-stacked="${url.searchParams.get('stacked') === '1'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
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
      // The real drawer must escape the page's stacking context and cover the
      // actual global-header layer. Click normally: forced clicks hide this bug.
      for (const viewport of [
        { width: 393, height: 852 },
        { width: 852, height: 393 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`http://game-card.fixture/?kind=${kind}&stacked=1`);
        await page.addScriptTag({
          content: bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
        });
        const trigger = page.getByRole('button', { name: 'Open Game Lobby', exact: true });
        await trigger.click();
        const close = page.getByRole('button', { name: 'Close Game Lobby', exact: true });
        await expect(close).toBeFocused();
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
        await expect
          .poll(() =>
            close.evaluate((el) => {
              const rect = el.getBoundingClientRect();
              return el.contains(
                document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              );
            })
          )
          .toBe(true);
        if (kind === 'cash') {
          await testInfo.attach(`game-lobby-header-layer-${viewport.width}`, {
            body: await page.screenshot({
              path: testInfo.outputPath(`game-lobby-header-layer-${viewport.width}.png`),
            }),
            contentType: 'image/png',
          });
        }
        await close.click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
        // A native pointer click need not focus a button (Safari leaves BODY
        // focused). Keyboard opening gives the trap a known return target.
        await trigger.focus();
        await trigger.press('Enter');
        await expect(close).toBeFocused();
        await close.click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await trigger.press('Enter');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(trigger).toBeFocused();
        if (viewport.width > 720) {
          await trigger.click();
          await page.locator('.glp-backdrop').click({ position: { x: 10, y: 150 } });
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
      }
      // Keep each format's original overflow proof at its existing viewport.
      await page.setViewportSize({ width: 393, height: 700 });
    }
    expect(errors).toEqual([]);
  });
}
