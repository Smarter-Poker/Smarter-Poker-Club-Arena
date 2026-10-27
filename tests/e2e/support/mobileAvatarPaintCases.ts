import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { AVATAR_CROWN_TOP } from '../../../src/components/table/avatarCrownBounds';
import { readMobileTableLayout } from './mobileLiveTableLayout';

export function registerMobileAvatarPaintCases() {
  test('live avatar geometry excludes transparent crown but rejects painted board overlap', async ({
    page,
  }) => {
    await page.route('https://avatar.fixture/avatars/table/free_penguin@2x.webp?v=1', (route) =>
      route.fulfill({
        contentType: 'image/webp',
        body: readFileSync('tests/fixtures/mobile-avatar-geometry/free_penguin@2x.webp'),
      })
    );
    await page.setViewportSize({ width: 599, height: 1065 });
    await page.setContent(`<style>
      body{margin:0}.table-page{width:599px;height:1065px;position:relative}
      .community-area{position:absolute;left:110px;top:415px;width:378px;height:104px}
      .seat__avatar-img{position:absolute;left:450px;top:516px;width:157px;height:157px;object-fit:contain;object-position:50% 100%}
    </style><div class="table-page"><div class="community-area"></div><div class="seat" data-seat-num="6"><span class="seat__name">Jett69</span><img class="seat__avatar-img" src="https://avatar.fixture/avatars/table/free_penguin@2x.webp?v=1#avatar"></div></div>`);
    await page.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    const measured = await page.locator('img').evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    expect(measured).toEqual({ width: 250, height: 340 });
    // Independent asset measurement: alpha>=16 starts at row106 of340.
    expect(AVATAR_CROWN_TOP['free_penguin@2x.webp']).toBeCloseTo(106 / 340, 5);
    const oldCanvas = await page.evaluate(readMobileTableLayout, {});
    expect(
      oldCanvas.violations.some((value) => value.startsWith('Player Or Bet Covers Board:'))
    ).toBe(true);
    const corrected = await page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
    expect(corrected.violations).toEqual([]);
    // Move the same artwork so its opaque crown crosses the reserved board.
    await page.locator('img').evaluate((image: HTMLImageElement) => {
      image.style.top = '450px';
    });
    const collision = await page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
    expect(collision.violations).toHaveLength(1);
    expect(collision.violations[0]).toContain('Player Or Bet Covers Board: seat__avatar-img');
    expect(collision.violations[0]).toContain('"seat":"6"');
    expect(collision.violations[0]).toContain('"painted":');
    expect(collision.violations[0]).toContain('"board":');
  });
}
