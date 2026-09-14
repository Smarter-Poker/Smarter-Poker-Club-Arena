import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { loadLiveCss, skipUnlessLiveCss } from './lib/live-css';

// This is a local transport/DOM contract fixture. The existing CSS beat suite
// separately measures the complete application bundle produced by CI.
test.describe('the CSS fixture reads the bundle without starting its application', () => {
  test.describe.configure({ mode: 'serial' });
  let server: Server;
  let arena: string;
  let revision = 1;
  let appBoots = 0;
  let manifestReads = 0;
  let scriptReads = 0;
  let missingSheet = false;
  const sheetCount = 146;

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.endsWith('/index.html')) {
        manifestReads++;
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><html><head><script src="assets/index-probe.js"></script></head><body>App Body</body></html>'
        );
      } else if (req.url?.endsWith('/index-probe.js')) {
        scriptReads++;
        res.setHeader('Content-Type', 'application/javascript');
        const names = Array.from({ length: sheetCount }, (_, i) => `assets/sheet-${i}.css`);
        res.end(`fetch('/app-booted');window.appBooted=true;void ${JSON.stringify(names)};`);
      } else if (req.url === '/app-booted') {
        appBoots++;
        res.end('app started');
      } else if (req.url?.endsWith('/late-import.css')) {
        setTimeout(() => {
          res.setHeader('Content-Type', 'text/css');
          res.end('.fixture-import{width:37px}');
        }, 80);
      } else {
        const match = req.url?.match(/\/sheet-(\d+)\.css$/);
        if (!match) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const i = Number(match[1]);
        if (missingSheet && i === 70) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // Deliberately return requests out of order. The cascade must still
        // follow the manifest, and @import stays first in its own stylesheet.
        setTimeout(
          () => {
            res.setHeader('Content-Type', 'text/css');
            res.end(
              (i === 70 ? '@import url("../late-import.css");' : '') +
                `.fixture-cascade{--sheet-order:${i};--bundle-revision:${revision}}\n`
            );
          },
          (sheetCount - i) % 9
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local fixture did not bind');
    arena = `http://127.0.0.1:${address.port}/hub/club-arena`;
  });

  test.afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  test('preserves every sheet, cascade and imported styles without running app scripts', async ({
    page,
  }) => {
    const load = await loadLiveCss(page, arena, { animationSpeed: '1' });
    expect(load.sheets).toBe(sheetCount);
    expect(load.bytes).toBeGreaterThan(2000);
    const observed = await page.evaluate(() => {
      const element = document.createElement('div');
      element.className = 'fixture-cascade fixture-import';
      document.body.appendChild(element);
      const style = getComputedStyle(element);
      return {
        sheets: document.styleSheets.length,
        order: style.getPropertyValue('--sheet-order'),
        revision: style.getPropertyValue('--bundle-revision'),
        width: style.width,
        animationSpeed: getComputedStyle(document.documentElement).getPropertyValue(
          '--animation-speed'
        ),
        appBooted: Boolean((window as unknown as { appBooted?: boolean }).appBooted),
      };
    });
    expect(observed).toEqual({
      sheets: sheetCount,
      order: '145',
      revision: '1',
      width: '37px',
      animationSpeed: '1',
      appBooted: false,
    });
    expect(appBoots).toBe(0);
    expect(manifestReads).toBe(1);
    expect(scriptReads).toBe(1);
  });

  test('reads a changed bundle afresh and releases its navigation interception', async ({
    page,
  }) => {
    revision = 2;
    await loadLiveCss(page, arena);
    const actual = await page.evaluate(() => {
      const element = document.createElement('div');
      element.className = 'fixture-cascade';
      document.body.appendChild(element);
      return getComputedStyle(element).getPropertyValue('--bundle-revision');
    });
    expect(actual).toBe('2');
    expect(manifestReads).toBe(2);
    expect(scriptReads).toBe(2);
    expect(appBoots).toBe(0);
    await page.goto(arena + '/index.html');
    await expect.poll(() => appBoots).toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { appBooted?: boolean }).appBooted)
    ).toBe(true);
  });

  test('one unreadable declared sheet cannot qualify the other 145 as a complete bundle', async ({
    page,
  }) => {
    missingSheet = true;
    const load = await loadLiveCss(page, arena, { attempts: 1 });
    expect(load.sheets).toBe(0);
    expect(load.reason).toContain('sheet-70.css returned HTTP 404');
    const priorCi = process.env.CI;
    process.env.CI = '1';
    try {
      expect(() => skipUnlessLiveCss(load, arena)).toThrow('complete CSS bundle');
    } finally {
      if (priorCi === undefined) delete process.env.CI;
      else process.env.CI = priorCi;
    }
  });
});
