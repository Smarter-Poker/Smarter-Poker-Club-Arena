import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { loadLiveCss } from './lib/live-css';
import { settleLayout } from './lib/settle-layout';

let server: Server;
let arena: string;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url?.endsWith('/index.html')) {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><script type="module" src="assets/index-probe.js"></script>');
    } else if (request.url?.endsWith('/index-probe.js')) {
      response.setHeader('content-type', 'text/javascript');
      response.end('/* assets/probe.css */ document.body.dataset.appStarted = "true";');
    } else if (request.url?.endsWith('/probe.css')) {
      response.setHeader('content-type', 'text/css');
      response.end(
        '.probe { width: 137px; background-image: url("assets/probe.svg"); } /*' +
          'x'.repeat(2_000) +
          '*/'
      );
    } else if (request.url?.endsWith('/probe.svg')) {
      response.setHeader('content-type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Probe listener missing');
  arena = `http://127.0.0.1:${address.port}/hub/club-arena`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

test('CSS keeps its real origin without starting the app or retaining the route override', async ({
  page,
}) => {
  const browserScripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') browserScripts.push(request.url());
  });
  const load = await loadLiveCss(page, arena, { attempts: 1 });
  expect(load.sheets).toBe(1);
  expect(load.bytes).toBeGreaterThan(2_000);
  await page.evaluate(() => {
    document.body.innerHTML = '<div class="probe">Fixture</div>';
  });
  await expect(page.locator('.probe')).toHaveCSS('width', '137px');
  await expect(page.locator('.probe')).toHaveCSS(
    'background-image',
    `url("${arena}/assets/probe.svg")`
  );
  expect(await page.locator('body').getAttribute('data-app-started')).toBeNull();
  expect(browserScripts).toEqual([]);
  // A later ordinary navigation must receive the original application again.
  await page.goto(`${arena}/index.html`);
  await expect(page.locator('body')).toHaveAttribute('data-app-started', 'true');
});

test('layout waits for a finite entrance while a decorative loop keeps playing', async ({
  page,
}) => {
  await page.setContent(`<style>
    @keyframes entrance { from { transform: translateY(30px); } to { transform: translateY(0); } }
    @keyframes glow { from { opacity: .4; } to { opacity: .8; } }
    #entrance { animation: entrance .15s both; } #loop { animation: glow 1s infinite; }
    </style><div id="entrance">Entrance</div><div id="loop">Loop</div>`);
  await settleLayout(page);
  expect(
    await page.locator('#entrance').evaluate((element) => element.getAnimations()[0].playState)
  ).toBe('finished');
  expect(
    await page.locator('#loop').evaluate((element) => element.getAnimations()[0].playState)
  ).toBe('running');
  await expect(page.locator('#entrance')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('an unfinished paused entrance fails the layout deadline', async ({ page }) => {
  await page.setContent('<div id="entrance">Entrance</div>');
  await page.locator('#entrance').evaluate((element) => {
    element
      .animate([{ transform: 'translateY(30px)' }, { transform: 'translateY(0)' }], 10_000)
      .pause();
  });
  await expect(settleLayout(page, 150)).rejects.toThrow(
    'Layout did not settle before its deadline'
  );
});
