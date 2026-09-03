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
  await page.setContent(
    `
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
            <!-- NO BACKTICKS IN THIS COMMENT. It lives inside a template
                 literal, so a backtick here ENDS THE STRING - and that is not
                 hypothetical. This comment used to quote a CSS class name in
                 backticks; Prettier rewrapped the expression that produced,
                 and the file threw "ReferenceError: identity__details is not
                 defined" at runtime. That is what turned this branch's CI red
                 on 2026-09-03, and while it sat red main moved underneath it
                 and the pull request went dirty, so a day of card fixes never
                 reached production - over a comment.

                 The fixture mirrors the real card: the club name is its own
                 full-width band across the top, one line, with the measurable
                 inner span the component sizes to fit; the alias is its own
                 line beside the logo; and the playing count sits in its own
                 measurable span so it can be fitted to its bay. A fixture
                 nesting these the old way would exercise markup the component
                 no longer renders, which matters here because this spec proves
                 the Share button owns its 44px band and that the count shares
                 that band's line. -->
            <h2 class="club-identity__name" style="--club-name-size: 7cqw">
              <span>Shark Club</span>
            </h2>
            <p class="club-identity__alias">Player</p>
            <div class="club-identity__footer">
              <span class="club-identity__playing"><span class="club-identity__playing-fit"><strong>7</strong><span>Playing Now</span></span></span>
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
  `
  );

  /* MEASURE THE RUN, DO NOT SAMPLE THREE POINTS (rewritten 2026-09-03).
   *
   * This probed centre-20, centre, centre+20 and required all three. That is a
   * proxy for "owns 44px", and it was a bad one: measured at this viewport the
   * card is 180.5 x 75.2 with `overflow: hidden`, the button's centre sits at
   * y 55.9, and centre+20 landed at 75.9 - PAST THE CARD'S BOTTOM EDGE at 75.2.
   * The band was already clipped; the probe simply fell 0.2px inside it and the
   * suite reported green. Moving the button onto the painted frame's true
   * centre, 1.2 points lower, moved that probe to 75.9 and the test failed - a
   * correct failure, for a defect that predated the change.
   *
   * So measure the thing the rule is actually about: the longest unbroken run
   * of pixels, down the button's own centre line, that the button answers for.
   * The band is anchored to the button's bottom now, so all 44px of it live
   * inside the card. This assertion is strictly stronger than the old one - it
   * cannot be satisfied by luck - and it still fails the original regression,
   * a 12px glyph owning only its painted box.
   */
  const share = page.getByRole('button', { name: 'Copy referral link' });
  const reach = await share.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    let best = 0;
    let run = 0;
    for (let y = 0; y <= Math.ceil(window.innerHeight); y += 1) {
      const hit = document.elementFromPoint(x, y);
      if (hit === button || button.contains(hit)) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    return { tallestRun: best, buttonHeight: Math.round(box.height) };
  });
  expect(
    reach.tallestRun,
    `the Share button must answer for an unbroken 44px column, not just its ${reach.buttonHeight}px painted box`
  ).toBeGreaterThanOrEqual(44);

  const wallets = page.locator('.lobby-wallets-content');
  await expect(wallets).toHaveCSS('visibility', 'hidden');
  await expect(page.getByText('Diamond Wallet')).toBeHidden();
  await expect(page.getByText('Player Wallet')).toBeHidden();

  await wallets.evaluate((node) => node.setAttribute('data-expanded', 'true'));
  await expect(wallets).toHaveCSS('visibility', 'visible');
  await expect(page.getByText('Diamond Wallet')).toBeVisible();
  await expect(page.getByText('Player Wallet')).toBeVisible();
});
