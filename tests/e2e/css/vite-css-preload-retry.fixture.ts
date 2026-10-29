import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cssPreloadRetryPlugin } from '../../../scripts/vite-css-preload-retry.mjs';

export function registerCssPreloadRetryCase() {
  test('a warmed route whose CSS failed waits for the real stylesheet on later entry', async ({
    browser,
  }) => {
    const root = mkdtempSync(
      join(
        process.platform === 'darwin'
          ? process.env.TMPDIR?.startsWith('/Volumes/SmarterWork/agent-work/')
            ? process.env.TMPDIR
            : '/Volumes/SmarterWork/agent-work/shared-capacity'
          : tmpdir(),
        'css-preload-'
      )
    );
    const oldTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    let releaseCss: ServerResponse | undefined;
    let cssRequests = 0;
    let page: Awaited<ReturnType<typeof browser.newPage>> | undefined;
    const server = createServer((req, res) => {
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      if (pathname.endsWith('.css')) {
        cssRequests++;
        if (cssRequests === 1) {
          res.writeHead(503);
          res.end();
        } else releaseCss = res;
        return;
      }
      res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
      try {
        res.end(readFileSync(join(root, 'dist', pathname === '/' ? 'index.html' : pathname)));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    try {
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
      writeFileSync(
        join(root, 'main.js'),
        "window.routeEvaluations = 0; window.review = () => import('./route.js');"
      );
      writeFileSync(
        join(root, 'route.js'),
        "import './route.css'; window.routeEvaluations++; export const ready = true;"
      );
      writeFileSync(join(root, 'route.css'), 'body { --route-ready: loaded; }');
      await build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [cssPreloadRetryPlugin()],
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => typeof (window as any).review === 'function');
      expect(
        await page.evaluate(() =>
          (window as any).review().then(
            () => false,
            () => true
          )
        )
      ).toBe(true);
      await page.evaluate(() => {
        (window as any).settled = false;
        void (window as any).review().then(() => {
          (window as any).settled = true;
        });
      });
      await expect.poll(() => cssRequests).toBe(2);
      expect(await page.evaluate(() => (window as any).settled)).toBe(false);
      expect(await page.evaluate(() => (window as any).routeEvaluations)).toBe(0);
      releaseCss!.writeHead(200, { 'content-type': 'text/css' });
      releaseCss!.end('body { --route-ready: loaded; }');
      await page.waitForFunction(() => (window as any).settled === true);
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.body).getPropertyValue('--route-ready').trim()
        )
      ).toBe('loaded');
      expect(await page.evaluate(() => (window as any).routeEvaluations)).toBe(1);
    } finally {
      releaseCss?.end();
      await page?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (oldTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldTmp;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
