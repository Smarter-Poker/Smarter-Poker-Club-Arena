import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const controlCss = readFileSync('src/components/table/ControlThemeTokens.css', 'utf8');
const actionCss = readFileSync('src/components/table/ActionPanel.css', 'utf8');

const CONTROL_THEMES = [
  'classic-white',
  'red-d-gear',
  'gray-d-gear',
  'blue-crystal',
  'gold-star',
  'sports-themed',
  'jade-seal',
  'amethyst-chip',
  'carbon-ion',
  'ocean-pearl',
] as const;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('all ten control themes paint distinct mobile action buttons without changing semantics', async ({
  page,
}) => {
  await page.setContent(`
    <style>${controlCss}\n${actionCss}</style>
    <main class="table-page" data-button-theme="classic-white">
      <section class="action-panel action-panel--active">
        <div class="action-row">
          <button class="action-btn action-btn--fold"><span class="action-btn__label">Fold</span></button>
          <button class="action-btn action-btn--check"><span class="action-btn__label">Check</span></button>
          <button class="action-btn action-btn--raise"><span class="action-btn__label">Raise</span></button>
        </div>
      </section>
    </main>
  `);

  const fingerprints: string[] = [];
  for (const theme of CONTROL_THEMES) {
    await page.locator('.table-page').evaluate((node, value) => {
      node.setAttribute('data-button-theme', value);
    }, theme);
    fingerprints.push(
      await page.locator('.action-btn--fold').evaluate((node) => {
        const style = getComputedStyle(node);
        const material = getComputedStyle(node, '::after');
        const label = getComputedStyle(node.querySelector('.action-btn__label')!);
        return [
          style.borderRadius,
          style.borderTopWidth,
          style.borderTopColor,
          material.backgroundImage,
          material.boxShadow,
          label.letterSpacing,
        ].join('|');
      })
    );
  }

  expect(new Set(fingerprints).size).toBe(CONTROL_THEMES.length);

  const semanticPaint = await page.locator('.action-row').evaluate(() => ({
    fold: getComputedStyle(document.querySelector('.action-btn--fold')!).backgroundImage,
    check: getComputedStyle(document.querySelector('.action-btn--check')!).backgroundImage,
    raise: getComputedStyle(document.querySelector('.action-btn--raise')!).backgroundImage,
  }));
  expect(semanticPaint.fold).not.toBe(semanticPaint.check);
  expect(semanticPaint.check).not.toBe(semanticPaint.raise);
  expect(semanticPaint.fold).toContain('240, 82, 77');
  expect(semanticPaint.check).toContain('21, 135, 248');
  expect(semanticPaint.raise).toContain('77, 198, 96');

  const fitsPhone = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(fitsPhone).toBe(true);
});
