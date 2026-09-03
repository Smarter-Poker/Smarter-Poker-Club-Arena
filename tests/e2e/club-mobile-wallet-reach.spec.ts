/**
 * The production 375px tap sweep found two different Club lobby defects:
 *
 * - the 12px Share glyph owned only its painted box, not a 44px thumb target;
 * - controls inside the collapsed wallet disclosure remained visible to the
 *   DOM/focus model while its zero-height wrapper clipped every pixel.
 *
 * This fixture uses the real component styles and the real lobby nesting. It
 * needs no account or server data, so it runs before merge in CSS Beat E2E.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const identityCss = readFileSync('src/components/club-buttons/ClubIdentityCard.css', 'utf8');
const lobbyCss = readFileSync('src/pages/ClubHomePage.css', 'utf8');
const walletCss = readFileSync('src/components/wallet/DynamicWallet.css', 'utf8');

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

test('Share owns 44px and collapsed wallet controls are not exposed', async ({ page }) => {
  await page.setContent(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; min-height: 100%; background: #000; }
      ${identityCss}
      ${walletCss}
      ${lobbyCss}
    </style>
    <main id="main-content" class="club-home">
      <div class="lobby-top">
        <div class="lobby-top__main">
          <section class="club-identity lobby-top__identity" aria-label="Shark Club club identity">
            <div class="club-identity__details">
              <h2>Shark Club</h2><p class="club-identity__alias">Player</p>
            </div>
            <div class="club-identity__footer">
              <span class="club-identity__playing"><strong>7</strong><span>Playing Now</span></span>
              <button class="club-identity__share" type="button" aria-label="Copy referral link">
                <svg aria-hidden="true" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
              </button>
            </div>
          </section>
          <button class="lobby-bbj" type="button">Bad Beat Jackpot</button>
          <div class="lobby-top__wallet">
            <button class="lobby-wallets-trigger" type="button" aria-expanded="false">
              My Wallets
            </button>
            <div class="lobby-wallets-content" data-expanded="false">
              <div class="lobby-wallets-content__inner">
                <div class="dw dw--lobby-board">
                  <div class="dw__rows">
                    <div class="dw__row dw__row--wallet-art dw__row--actionable" role="button" tabindex="0">Diamond Wallet</div>
                    <div class="dw__row dw__row--wallet-art dw__row--actionable" role="button" tabindex="0">Player Wallet</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  `);

  const share = page.getByRole('button', { name: 'Copy referral link' });
  const reach = await share.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return [-20, 0, 20].map((dy) => {
      const hit = document.elementFromPoint(x, y + dy);
      return hit === button || button.contains(hit);
    });
  });
  expect(reach, 'the Share button must own the complete 44px vertical band').toEqual([
    true,
    true,
    true,
  ]);

  const wallets = page.locator('.lobby-wallets-content');
  await expect(wallets).toHaveCSS('visibility', 'hidden');
  await expect(page.getByText('Diamond Wallet')).toBeHidden();
  await expect(page.getByText('Player Wallet')).toBeHidden();

  await wallets.evaluate((node) => node.setAttribute('data-expanded', 'true'));
  await expect(wallets).toHaveCSS('visibility', 'visible');
  await expect(page.getByText('Diamond Wallet')).toBeVisible();
  await expect(page.getByText('Player Wallet')).toBeVisible();
});
