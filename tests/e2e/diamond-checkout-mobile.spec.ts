import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const checkoutCss = readFileSync('src/components/vip/DiamondTopUpModal.css', 'utf8');

test.describe('mobile Diamond Store', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('keeps a secure, touch-safe checkout catalog inside the phone viewport', async ({
    page,
  }) => {
    const packs = [
      ['Pocket Change', '100', '$0.99'],
      ['First Stack', '500', '$3.99'],
      ['Table Builder', '1,400', '$7.99'],
      ['Most Popular', '3,750', '$14.99'],
      ['High Roller', '8,500', '$29.99'],
      ['Diamond Vault', '20,000', '$49.99'],
    ];
    await page.setContent(`
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>${checkoutCss}</style>
      <div class="diamond-modal-overlay">
        <section class="diamond-modal" role="dialog" aria-label="Add Diamonds">
          <header class="diamond-modal__header"><div><span class="diamond-modal__eyebrow">SECURE PLAYER CHECKOUT</span><h2>Add Diamonds</h2></div><button class="diamond-modal__close">×</button></header>
          <p class="diamond-modal__desc">Choose A Pack. Stripe Confirms The Price Before Payment, Then Your Balance Updates From The Server.</p>
          <div class="diamond-modal__grid">
            ${packs
              .map(
                ([name, amount, price], index) => `
                <article class="diamond-package ${index === 3 ? 'diamond-package--popular' : ''}">
                  ${index === 3 ? '<span class="diamond-package__badge">Most Popular</span>' : ''}
                  <div class="diamond-package__amount"><strong class="diamond-package__diamonds">${amount}</strong>${index > 1 ? '<span class="diamond-package__bonus">Bonus Included</span>' : ''}</div>
                  <span class="diamond-package__name">${name}</span>
                  <button class="diamond-package__btn">${price}</button>
                </article>`
              )
              .join('')}
          </div>
          <footer class="diamond-modal__trust"><span>Stripe Checkout</span><span>Server-Priced</span><span>Permanent Balance</span></footer>
        </section>
      </div>
    `);

    await expect(page.locator('.diamond-modal')).toHaveCSS('width', '390px');
    await expect(page.locator('.diamond-modal')).toHaveCSS('height', '844px');
    const columns = await page
      .locator('.diamond-modal__grid')
      .evaluate(
        (node) => getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length
      );
    expect(columns).toBe(2);
    for (const selector of ['.diamond-modal__close', '.diamond-package__btn']) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(43.9);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.locator('.diamond-modal__header')).toBeVisible();
    await expect(page.locator('.diamond-modal__trust')).toBeVisible();

    if (process.env.CAPTURE_CUSTOMIZATION_VISUALS) {
      await page.screenshot({ path: 'test-results/diamond-checkout-mobile.png' });
    }

    // A shorter phone keeps the hardware/header fixed and gives scrolling to
    // the package rail—not to the page underneath the checkout.
    await page.setViewportSize({ width: 390, height: 667 });
    expect(
      await page
        .locator('.diamond-modal__grid')
        .evaluate((node) => node.scrollHeight > node.clientHeight)
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(667);
    await expect(page.locator('.diamond-modal__header')).toBeVisible();
    await expect(page.locator('.diamond-modal__trust')).toBeVisible();
  });
});
