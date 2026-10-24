import { expect, test } from '@playwright/test';
import { build as buildFixture } from 'esbuild';
import { readFileSync } from 'node:fs';

export function registerCompactLobbyRowsCases() {
  test('game counts stay centered under Players and row details wrap', async ({
    page,
  }, testInfo) => {
    const bundle = await buildFixture({
      entryPoints: ['tests/e2e/support/compactLobbyRowsFixture.tsx'],
      jsx: 'automatic',
      bundle: true,
      write: false,
      outfile: 'rows.js',
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
          DEV: true,
        }),
        'process.env.NODE_ENV': '"test"',
      },
      plugins: [
        {
          name: 'no-fixture-transport',
          setup(build) {
            build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
            build.onResolve({ filter: /\/tableWarmup$/ }, () => ({
              path: 'warmup',
              namespace: 'fixture',
            }));
            build.onResolve({ filter: /\/ChunkPreloader$/ }, () => ({
              path: 'prefetch',
              namespace: 'fixture',
            }));
            build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents:
                args.path === 'prefetch'
                  ? 'export const prefetchIntent=()=>({});'
                  : 'export const warmTable=()=>{}; export const observeLobbyTableWarmups=()=>()=>{};',
            }));
          },
        },
      ],
    });
    const sheets = [
      ...new Set([
        'src/components/lobby/LobbyTable.css',
        'src/components/lobby/CompactLobbyRows.css',
      ]),
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    await page.route('https://fixture.invalid/**', (route) => route.fulfill({ json: null }));
    for (const width of [320, 393, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(
        `<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#000}*{box-sizing:border-box}${sheets}</style><div id="root"></div>`
      );
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const table = page.locator(width <= 900 ? '.compact-lobby' : '.lobby-table');
      await expect(table).toBeVisible();
      await expect(table.locator('.lt-seats--game')).toHaveCount(3);
      const geometry = await table.evaluate((root) => {
        const header = [...root.querySelectorAll('th')].find((el) =>
          el.textContent?.includes('Players')
        )!;
        const center = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.x + r.width / 2;
        };
        return {
          deltas: [
            ...root.querySelectorAll(
              '.lt-seats--game .lt-seats__num, .lt-seats--game .lt-seats__tables'
            ),
          ].map((el) => Math.abs(center(el) - center(header))),
          overflow: root.scrollWidth - root.clientWidth,
          meta: [...root.querySelectorAll('.compact-lobby__meta')].map((el) => ({
            whiteSpace: getComputedStyle(el).whiteSpace,
            height: el.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight),
          })),
        };
      });
      expect(
        geometry.deltas.every((delta) => delta <= 1),
        `${width}px player center deltas: ${geometry.deltas}`
      ).toBe(true);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      await testInfo.attach(`compact-rows-${width}px`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      if (width <= 900) {
        expect(geometry.meta.every((meta) => meta.whiteSpace === 'normal')).toBe(true);
        expect(geometry.meta.some((meta) => meta.height > meta.lineHeight * 1.5)).toBe(true);
        await expect(table.locator('.compact-lobby__meta').nth(1)).toContainText(
          'Lightning Games | Big Blind Ante, 40% Minimum VPIP'
        );
        await table.locator('.compact-lobby__open').first().click();
        await expect(page.locator('body')).toHaveAttribute('data-selected', 'true');
      }
    }
  });
}
