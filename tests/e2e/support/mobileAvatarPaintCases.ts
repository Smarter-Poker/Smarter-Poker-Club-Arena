import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { AVATAR_CROWN_TOP } from '../../../src/components/table/avatarCrownBounds';
import { readMobileTableLayout } from './mobileLiveTableLayout';

export function registerMobileAvatarPaintCases() {
  test('live avatar geometry excludes transparent crown but rejects painted board overlap', async ({
    page,
  }) => {
    const avatar = 'https://avatar.fixture/avatars/table/free_penguin@2x.webp?v=1';
    const taintedAvatar = 'https://tainted-avatar.fixture/avatars/table/free_penguin@2x.webp';
    await page.route(avatar, (route) =>
      route.fulfill({
        contentType: 'image/webp',
        body: readFileSync('tests/fixtures/mobile-avatar-geometry/free_penguin@2x.webp'),
      })
    );
    await page.setViewportSize({ width: 599, height: 1065 });
    await page.route('https://avatar.fixture/geometry', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.goto('https://avatar.fixture/geometry');
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
    // The raw canvas intersects the board, independently of crown metadata.
    // Decoded transparent pixels must clear with or without that metadata.
    const rawOverlap = await page.evaluate(() => {
      const image = document.querySelector('img')!.getBoundingClientRect();
      const board = document.querySelector('.community-area')!.getBoundingClientRect();
      return (
        image.left < board.right &&
        image.right > board.left &&
        image.top < board.bottom &&
        image.bottom > board.top
      );
    });
    expect(rawOverlap).toBe(true);
    const withoutMetadata = await page.evaluate(readMobileTableLayout, {});
    expect(withoutMetadata.violations).toEqual([]);
    const corrected = await page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
    expect(corrected.violations).toEqual([]);
    // Move the actual opaque body into the board, not merely its rectangular
    // crown metadata: the original right-edge pose still had transparent pixels.
    await page.locator('img').evaluate((image: HTMLImageElement) => {
      image.style.left = '300px';
      image.style.top = '400px';
    });
    const collision = await page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
    expect(collision.violations).toHaveLength(1);
    expect(collision.violations[0]).toContain('Player Or Bet Covers Board: seat__avatar-img');
    expect(collision.violations[0]).toContain('"seat":"6"');
    expect(collision.violations[0]).toContain('"painted":');
    expect(collision.violations[0]).toContain('"board":');
    // Unknown pixels still fail closed, even when old crown metadata claims
    // clearance. Deliberately omit CORS permission on this second origin.
    await page.route(taintedAvatar, (route) =>
      route.fulfill({
        contentType: 'image/webp',
        body: readFileSync('tests/fixtures/mobile-avatar-geometry/free_penguin@2x.webp'),
      })
    );
    await page.locator('img').evaluate((image: HTMLImageElement, src) => {
      image.style.left = '450px';
      image.style.top = '516px';
      image.src = src;
    }, taintedAvatar);
    await page.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    const tainted = await page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
    expect(tainted.violations).toHaveLength(1);
    expect(tainted.violations[0]).toContain('Player Or Bet Covers Board: seat__avatar-img');
  });
}
