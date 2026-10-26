import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildCss, buildHtml } from './support/feltHarness.mjs';

const css =
  readFileSync('src/styles/club-engine.css', 'utf8').replace(/@import\s+[^;]+;/g, '') +
  buildCss(process.cwd()) +
  '\n' +
  readFileSync('src/components/table/PotDisplay.css', 'utf8');
const event = 'Morning Free Buy (NLH) · Freeroll';
const longEvent = 'Sunday Morning No Limit Holdem Championship Celebration · 1,000 Buy-In';
const name = 'Alexandria Championship';
const brand = (title: string) => `<div class="table-brand"><div class="table-brand__meta">
  <span class="table-brand__line table-brand__line--identity"><span class="table-brand__club"><span class="table-brand__club-name">Kings Club</span> <span class="table-brand__union">· Midway Union</span></span></span>
  <span class="table-brand__line table-brand__line--level"><span class="table-brand__game">${title}</span><span class="table-brand__hand">Hand #48909509</span></span>
</div></div>`;

for (const [width, height] of [
  [320, 667],
  [375, 667],
  [393, 852],
  [430, 932],
  [844, 390],
  [1440, 900],
]) {
  for (const title of [event, longEvent]) {
    test(`full captions at ${width}x${height}: ${title}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      let html = buildHtml(css).replace(
        'table-page--embedded"',
        'table-page--embedded table-page--tournament"'
      );
      html = html.replace(
        '<div class="table-scaler">',
        `<div class="table-scaler"><div class="table-surface">${brand(title)}</div>`
      );
      html = html.replace('>HERO<', `>${name}<`);
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.table-brand__game')).toHaveText(title);
      await expect(page.locator('.seat__name')).toHaveText(name);
      const results = await page
        .locator(
          '.table-brand__game, .table-brand__hand, .table-brand__line--identity, .seat__name'
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const el = node as HTMLElement;
            const style = getComputedStyle(el);
            const range = document.createRange();
            range.selectNodeContents(el);
            const box = el.getBoundingClientRect();
            return {
              text: el.textContent,
              overflow: style.overflow,
              ellipsis: style.textOverflow,
              inside: [...range.getClientRects()].every(
                (r) => r.left >= box.left - 1 && r.right <= box.right + 1
              ),
              widthFits: el.scrollWidth <= el.clientWidth + 1,
            };
          })
        );
      for (const result of results) {
        expect(result, result.text || '').toMatchObject({ inside: true, widthFits: true });
        expect(result.ellipsis).not.toBe('ellipsis');
        expect(result.overflow).not.toBe('hidden');
      }
      const game = await page.locator('.table-brand__game').boundingBox();
      const hand = await page.locator('.table-brand__hand').boundingBox();
      expect(hand!.y).toBeGreaterThanOrEqual(game!.y + game!.height - 1);
    });
  }
}
