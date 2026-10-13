import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';

const css = [
  'src/styles/club-engine.css',
  'src/styles/animations.css',
  'src/styles/metallic-popups.css',
  'src/styles/reducedMotion.css',
  'src/pages/ClubHomePage.css',
]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const script = buildSync({
  entryPoints: ['tests/e2e/helpers/diamond-jackpot-readout-fixture.tsx'],
  bundle: true,
  outdir: 'unused',
  // The actual styles are injected above; keep their asset URLs browser-owned.
  loader: { '.css': 'empty' },
  write: false,
  jsx: 'automatic',
  format: 'iife',
  define: { 'import.meta.env.BASE_URL': "'/'", 'process.env.NODE_ENV': "'production'" },
}).outputFiles[0].text;

export function registerDiamondJackpotReadoutCases() {
  for (const width of [375, 393, 430, 1440]) {
    for (const amount of [0, 2792, 999999999999]) {
      test(`whole Diamond readout fits its approved bay at ${width}px with ${amount}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 700 });
        await page.route('http://readout.test/**', async (route) => {
          if (route.request().url().includes('bbj-dynamic-plaque-v1.webp'))
            return route.fulfill({
              contentType: 'image/webp',
              body: readFileSync('public/assets/club-buttons/bbj/bbj-dynamic-plaque-v1.webp'),
            });
          await route.fulfill({
            contentType: 'text/html',
            body: `<style>${css}body{margin:0;background:#000;font-family:Arial}.lobby-bbj{width:calc((100vw - 34px)/2);max-width:400px;aspect-ratio:1566/672;margin:20px}</style><div id="root"></div><script>${script}</script>`,
          });
        });
        await page.goto(`http://readout.test/?amount=${amount}`);
        const button = page.getByRole('button', {
          name: `Bad Beat Jackpot: ${amount.toLocaleString('en-US')} Diamonds`,
          exact: true,
        });
        await expect(button).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            page.locator('.lobby-bbj__amount').evaluate((bay) => {
              const box = bay.getBoundingClientRect();
              return [...bay.querySelectorAll('span')].every((line) => {
                const range = document.createRange();
                range.selectNodeContents(line);
                const text = range.getBoundingClientRect();
                return (
                  text.left >= box.left - 0.5 &&
                  text.right <= box.right + 0.5 &&
                  text.top >= box.top - 0.5 &&
                  text.bottom <= box.bottom + 0.5
                );
              });
            })
          )
          .toBe(true);
        await expect(page.locator('.lobby-bbj__amount')).toHaveText(
          `${amount.toLocaleString('en-US')} Diamonds`
        );
        await button.click();
        expect(await page.locator('body').getAttribute('data-clicked')).toBe('true');
      });
    }
  }
}
