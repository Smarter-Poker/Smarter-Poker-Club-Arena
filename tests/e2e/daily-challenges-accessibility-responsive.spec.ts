import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

type ChallengeTier = 'daily' | 'weekly' | 'monthly';

const CHALLENGE_LOAD_TIMEOUT = 60_000;
const ECONOMY_RPC = /\/(?:claim_daily_challenges|reroll_daily_challenge|buy_streak_freeze)(?:\?|$)/;
const TIERS: ReadonlyArray<{ tier: ChallengeTier; label: string }> = [
  { tier: 'daily', label: 'Daily' },
  { tier: 'weekly', label: 'Weekly' },
  { tier: 'monthly', label: 'Monthly' },
];

function challengeUrl(testInfo: TestInfo, tier: ChallengeTier): string {
  const configuredBase = String(testInfo.project.use.baseURL || 'http://localhost:5173/');
  return new URL(`challenges/${tier}`, configuredBase).toString();
}

function observeEconomyMutations(page: Page): { assertNone: () => void } {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (ECONOMY_RPC.test(request.url())) requests.push(request.url());
  });
  return {
    assertNone: () =>
      expect(requests, 'this read-only accessibility suite must never call an economy RPC').toEqual(
        []
      ),
  };
}

async function openChallengeTier(
  page: Page,
  testInfo: TestInfo,
  tier: ChallengeTier
): Promise<void> {
  await page.goto(challengeUrl(testInfo, tier), {
    waitUntil: 'domcontentloaded',
    timeout: CHALLENGE_LOAD_TIMEOUT,
  });

  const surface = page.locator('#daily-missions');
  const signedOut = page.getByRole('button', { name: 'Sign In', exact: true });
  await expect
    .poll(
      async () =>
        page.url().includes('/auth') ||
        (await surface.count()) > 0 ||
        (await signedOut.isVisible().catch(() => false)),
      { timeout: CHALLENGE_LOAD_TIMEOUT }
    )
    .toBe(true);
  test.skip(
    page.url().includes('/auth') || (await signedOut.isVisible().catch(() => false)),
    'authenticated Daily Challenges session is not configured'
  );

  await expect(surface).toBeVisible({ timeout: CHALLENGE_LOAD_TIMEOUT });
  await expect(surface).toHaveAttribute('aria-busy', 'false', {
    timeout: CHALLENGE_LOAD_TIMEOUT,
  });
  await expect(page.getByRole('tablist', { name: 'Challenge Period' })).toBeVisible();
}

async function expectExclusiveTier(page: Page, tier: ChallengeTier, label: string): Promise<void> {
  const surface = page.locator('#daily-missions');
  const tablist = page.getByRole('tablist', { name: 'Challenge Period' });
  const tabs = tablist.getByRole('tab');
  const selected = page.getByRole('tab', { name: new RegExp(`^${label}`, 'i') });

  await expect(surface).toHaveAttribute('data-mission-cycle', tier);
  await expect(tabs).toHaveCount(3);
  await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1);
  await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('tabpanel')).toHaveAttribute(
    'aria-labelledby',
    `mission-tab-${tier}`
  );

  const renderedTiers = await surface
    .locator('[data-mission-tier]')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-mission-tier')));
  expect(renderedTiers, `${label} must render at least one assigned challenge`).not.toHaveLength(0);
  expect(
    renderedTiers.every((renderedTier) => renderedTier === tier),
    `the ${label} panel rendered a card from another challenge cycle`
  ).toBe(true);
}

test.describe('Daily Challenges accessibility and responsive certification', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  for (const { tier, label } of TIERS) {
    test(`${label} direct route exposes only its own named challenge cycle`, async ({
      page,
    }, testInfo) => {
      const economy = observeEconomyMutations(page);
      await openChallengeTier(page, testInfo, tier);

      await expect(page).toHaveURL(new RegExp(`/challenges/${tier}(?:[?#]|$)`));
      await expect(page).toHaveTitle(`${label} Challenges | Smarter Poker`);
      await expect(
        page.getByRole('heading', { name: `${label} Challenges`, level: 1, exact: true })
      ).toHaveCount(1);
      await expectExclusiveTier(page, tier, label);
      economy.assertNone();
    });
  }

  for (const { tier, label } of TIERS) {
    test(`${label} challenge surface passes the WCAG A and AA automated scan`, async ({
      page,
    }, testInfo) => {
      const economy = observeEconomyMutations(page);
      await openChallengeTier(page, testInfo, tier);

      const results = await new AxeBuilder({ page })
        .include('#daily-missions')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        targets: violation.nodes.flatMap((node) => node.target.map(String)),
      }));
      expect(violations).toEqual([]);
      economy.assertNone();
    });
  }

  test('keyboard cycle navigation moves focus, URL, title, heading, and tab panel together', async ({
    page,
  }, testInfo) => {
    const economy = observeEconomyMutations(page);
    await openChallengeTier(page, testInfo, 'daily');

    const boardHeading = page.getByRole('heading', {
      name: 'Daily Challenge Ledger',
      level: 2,
    });
    await page.getByRole('button', { name: 'View Challenge Ledger' }).click();
    await expect(boardHeading).toBeFocused();

    const daily = page.getByRole('tab', { name: /^Daily/i });
    const weekly = page.getByRole('tab', { name: /^Weekly/i });
    const monthly = page.getByRole('tab', { name: /^Monthly/i });
    await daily.focus();
    await page.keyboard.press('ArrowRight');
    await expect(weekly).toBeFocused();
    await expect(page).toHaveURL(/\/challenges\/weekly(?:[?#]|$)/);
    await expect(page).toHaveTitle('Weekly Challenges | Smarter Poker');
    await expect(page.getByRole('heading', { name: 'Weekly Challenges', level: 1 })).toBeVisible();
    await expectExclusiveTier(page, 'weekly', 'Weekly');

    await page.keyboard.press('End');
    await expect(monthly).toBeFocused();
    await expect(page).toHaveURL(/\/challenges\/monthly(?:[?#]|$)/);
    await expect(page).toHaveTitle('Monthly Challenges | Smarter Poker');
    await expectExclusiveTier(page, 'monthly', 'Monthly');

    await page.keyboard.press('Home');
    await expect(daily).toBeFocused();
    await expect(page).toHaveURL(/\/challenges\/daily(?:[?#]|$)/);
    await expect(page).toHaveTitle('Daily Challenges | Smarter Poker');
    await expectExclusiveTier(page, 'daily', 'Daily');
    economy.assertNone();
  });

  test('320px, phone landscape, and 200 percent text retain reflow and touch targets', async ({
    page,
  }, testInfo) => {
    const economy = observeEconomyMutations(page);
    await openChallengeTier(page, testInfo, 'monthly');

    for (const viewport of [
      { name: '320px Portrait', width: 320, height: 568 },
      { name: 'Phone Landscape', width: 568, height: 320 },
    ]) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, `${viewport.name} has horizontal document overflow`).toBeLessThanOrEqual(
          1
        );

        const shortTargets = await page
          .locator('#daily-missions button:visible')
          .evaluateAll((buttons) =>
            buttons
              .map((button) => {
                const box = button.getBoundingClientRect();
                return {
                  name: button.getAttribute('aria-label') || (button.textContent || '').trim(),
                  width: box.width,
                  height: box.height,
                };
              })
              .filter((button) => button.width < 44 || button.height < 44)
          );
        expect(shortTargets, `${viewport.name} has controls below the 44px touch floor`).toEqual(
          []
        );

        const selectedTab = page.getByRole('tab', { name: /^Monthly/i });
        await selectedTab.evaluate((element) =>
          element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
        );
        await expect(selectedTab).toBeVisible();
        const footer = page.getByRole('navigation', { name: 'Club Arena' });
        if (await footer.isVisible().catch(() => false)) {
          const [targetBox, footerBox] = await Promise.all([
            selectedTab.boundingBox(),
            footer.boundingBox(),
          ]);
          expect(targetBox, 'the selected cycle tab has no rendered box').not.toBeNull();
          expect(footerBox, 'the fixed Club Arena footer has no rendered box').not.toBeNull();
          expect(
            targetBox!.y + targetBox!.height,
            `${viewport.name} selected tab is covered by the fixed footer`
          ).toBeLessThanOrEqual(footerBox!.y + 1);
        }
      });
    }

    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => {
      const container = document.createElement('div');
      container.className = 'toast-container';
      container.dataset.dailyMissionToastProbe = 'true';
      container.setAttribute('role', 'region');
      container.setAttribute('aria-label', 'Notification Reflow Probe');
      for (const [index, type] of ['success', 'warning'].entries()) {
        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        const icon = document.createElement('span');
        icon.className = 'toast__icon';
        icon.setAttribute('aria-hidden', 'true');
        const message = document.createElement('span');
        message.className = 'toast__message';
        message.textContent =
          index === 0
            ? 'Daily Mission Settlement Confirmed With Every Diamond Recorded In The Vault Ledger And Reconciled Against The Current Wallet Before The Reward Window Closed'
            : 'Streak Freeze Protection Is Ready And The Protected Date Remains Visible After Reload Across Every Open Club Arena Challenge Window';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast__close';
        close.setAttribute('aria-label', `Dismiss Probe Notification ${index + 1}`);
        close.textContent = 'X';
        toast.append(icon, message, close);
        container.append(toast);
      }
      document.body.append(container);
    });
    const baseTypography = await page.evaluate(() => ({
      heading: Number.parseFloat(
        getComputedStyle(document.querySelector<HTMLElement>('#daily-missions h1')!).fontSize
      ),
      toast: Number.parseFloat(
        getComputedStyle(
          document.querySelector<HTMLElement>('[data-daily-mission-toast-probe] .toast')!
        ).fontSize
      ),
    }));

    await test.step('200 Percent Text At 320px', async () => {
      await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, '200 percent text creates horizontal document overflow').toBeLessThanOrEqual(
        1
      );
      await expect(
        page.getByRole('heading', { name: 'Monthly Challenges', level: 1, exact: true })
      ).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Challenge Period' })).toBeVisible();

      const reflow = await page.evaluate(() => {
        const heading = document.querySelector<HTMLElement>('#daily-missions h1');
        const tabs = Array.from(
          document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')
        );
        const cardToplines = Array.from(
          document.querySelectorAll<HTMLElement>('[data-mission-topline]')
        );
        const localFrames = Array.from(
          document.querySelectorAll<HTMLElement>(
            '#daily-missions section, #daily-missions aside, #daily-missions [role="tablist"], #daily-missions button'
          )
        );
        const ornamentedFrames = Array.from(
          document.querySelectorAll<HTMLElement>(
            '#daily-missions [data-mission-state], #daily-missions footer'
          )
        );
        const missionCards = Array.from(
          document.querySelectorAll<HTMLElement>('#daily-missions [data-mission-state]')
        );
        const glyphs = Array.from(
          document.querySelectorAll<HTMLElement>('#daily-missions [data-mission-instrument]')
        );
        const toastContainer = document.querySelector<HTMLElement>(
          '[data-daily-mission-toast-probe]'
        );
        const toastCloseButtons = Array.from(
          toastContainer?.querySelectorAll<HTMLElement>('.toast__close') || []
        );
        const toastItems = Array.from(
          toastContainer?.querySelectorAll<HTMLElement>('.toast') || []
        );
        const headingBox = heading?.getBoundingClientRect();
        const tabBoxes = tabs.map((tab) => tab.getBoundingClientRect());
        const overlappingTabs = tabBoxes.some((box, index) =>
          tabBoxes
            .slice(index + 1)
            .some(
              (other) =>
                Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 &&
                Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1
            )
        );

        return {
          headingInsideViewport: Boolean(
            headingBox && headingBox.left >= -1 && headingBox.right <= innerWidth + 1
          ),
          headingFits: Boolean(heading && heading.scrollWidth <= heading.clientWidth + 1),
          tabsFit: tabs.every((tab) => tab.scrollWidth <= tab.clientWidth + 1),
          cardToplinesFit: cardToplines.every((topline) => {
            const bounds = topline.getBoundingClientRect();
            return (
              topline.scrollWidth <= topline.clientWidth + 1 &&
              Array.from(topline.children).every((child) => {
                const childBounds = child.getBoundingClientRect();
                return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1;
              })
            );
          }),
          overflowingFrames: localFrames
            .filter((frame) => frame.scrollWidth > frame.clientWidth + 1)
            .map((frame) => ({
              element: frame.tagName.toLowerCase(),
              id: frame.id,
              label:
                frame.getAttribute('aria-label') || (frame.textContent || '').trim().slice(0, 80),
              clientWidth: frame.clientWidth,
              scrollWidth: frame.scrollWidth,
            })),
          ornamentedFrameChildrenFit: ornamentedFrames.every((frame) => {
            const bounds = frame.getBoundingClientRect();
            return Array.from(frame.children).every((child) => {
              const childBounds = child.getBoundingClientRect();
              return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1;
            });
          }),
          cardInnerNodesFit: missionCards.every((card) => {
            const bounds = card.getBoundingClientRect();
            return Array.from(
              card.querySelectorAll<HTMLElement>(
                'h3, p, button, [role="progressbar"], [data-mission-instrument]'
              )
            ).every((node) => {
              const nodeBounds = node.getBoundingClientRect();
              return nodeBounds.left >= bounds.left - 1 && nodeBounds.right <= bounds.right + 1;
            });
          }),
          glyphsFitHousing: glyphs.every((glyph) => {
            const housing = glyph.parentElement?.getBoundingClientRect();
            const bounds = glyph.getBoundingClientRect();
            return Boolean(
              housing &&
              bounds.left >= housing.left - 1 &&
              bounds.right <= housing.right + 1 &&
              bounds.top >= housing.top - 1 &&
              bounds.bottom <= housing.bottom + 1
            );
          }),
          headingFontSize: Number.parseFloat(heading ? getComputedStyle(heading).fontSize : '0'),
          toastFontSize: Number.parseFloat(
            toastItems[0] ? getComputedStyle(toastItems[0]).fontSize : '0'
          ),
          toastStackBounded: Boolean(
            toastContainer &&
            toastContainer.getBoundingClientRect().top >= -1 &&
            toastContainer.getBoundingClientRect().bottom <= innerHeight + 1 &&
            toastContainer.scrollHeight > toastContainer.clientHeight
          ),
          firstToastCloseVisible: Boolean(
            toastCloseButtons[0] &&
            toastCloseButtons[0].getBoundingClientRect().top >= -1 &&
            toastCloseButtons[0].getBoundingClientRect().bottom <= innerHeight + 1
          ),
          toastItemsFitContent: toastItems.every(
            (toast) => toast.scrollHeight <= toast.clientHeight + 1
          ),
          overlappingTabs,
        };
      });

      expect(reflow).toMatchObject({
        headingInsideViewport: true,
        headingFits: true,
        tabsFit: true,
        cardToplinesFit: true,
        overflowingFrames: [],
        ornamentedFrameChildrenFit: true,
        cardInnerNodesFit: true,
        glyphsFitHousing: true,
        toastStackBounded: true,
        firstToastCloseVisible: true,
        toastItemsFitContent: true,
        overlappingTabs: false,
      });
      expect(reflow.headingFontSize).toBeGreaterThanOrEqual(baseTypography.heading * 1.5);
      expect(reflow.toastFontSize).toBeGreaterThanOrEqual(baseTypography.toast * 1.5);

      const toastStack = page.locator('[data-daily-mission-toast-probe]');
      await toastStack.evaluate((container) => {
        container.scrollTop = container.scrollHeight;
      });
      const lastToastClose = toastStack.getByRole('button', {
        name: 'Dismiss Probe Notification 2',
      });
      await expect(lastToastClose).toBeInViewport();

      await page.getByRole('tab', { name: /^Daily/i }).click();
      const reroll = page
        .getByRole('button', { name: /^(?:Reroll|Need) 1 Diamond (?:For|To Reroll) .+$/ })
        .first();
      if ((await reroll.count()) > 0 && (await reroll.isEnabled())) {
        await reroll.click();
        const confirmation = page.getByRole('group', { name: /^Confirm Reroll For / });
        await expect(confirmation).toBeVisible();
        const confirmationFits = await confirmation.evaluate((group) => {
          const bounds = group.getBoundingClientRect();
          return {
            groupInsideViewport: bounds.left >= -1 && bounds.right <= innerWidth + 1,
            descendantsFit: Array.from(group.querySelectorAll<HTMLElement>('*')).every((node) => {
              const nodeBounds = node.getBoundingClientRect();
              return nodeBounds.left >= bounds.left - 1 && nodeBounds.right <= bounds.right + 1;
            }),
          };
        });
        expect(confirmationFits).toEqual({ groupInsideViewport: true, descendantsFit: true });
        await confirmation.getByRole('button', { name: 'Keep It' }).click();
        await expect(confirmation).toHaveCount(0);
      } else if ((await reroll.count()) > 0) {
        await expect(reroll).toHaveAccessibleName(/^Need 1 Diamond To Reroll /);
      }
    });
    await page
      .locator('[data-daily-mission-toast-probe]')
      .evaluate((container) => container.remove());
    economy.assertNone();
  });

  test('ledger-unavailable recovery state reflows at 320px and 200 percent text', async ({
    page,
  }, testInfo) => {
    const economy = observeEconomyMutations(page);
    await page.route('**/rest/v1/rpc/get_daily_challenge_dashboard_v3*', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PGRST002',
          message: 'Daily Missions Unavailable State Certification',
        }),
      });
    });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(challengeUrl(testInfo, 'daily'), {
      waitUntil: 'domcontentloaded',
      timeout: CHALLENGE_LOAD_TIMEOUT,
    });
    const signedOut = page.getByRole('button', { name: 'Sign In', exact: true });
    await expect
      .poll(
        async () =>
          page.url().includes('/auth') ||
          (await signedOut.isVisible().catch(() => false)) ||
          (await page
            .getByRole('alert')
            .isVisible()
            .catch(() => false)),
        { timeout: CHALLENGE_LOAD_TIMEOUT }
      )
      .toBe(true);
    test.skip(
      page.url().includes('/auth') || (await signedOut.isVisible().catch(() => false)),
      'authenticated Daily Challenges session is not configured'
    );

    const unavailable = page.getByRole('alert');
    await expect(unavailable).toContainText('Challenge Ledger Unavailable', {
      timeout: CHALLENGE_LOAD_TIMEOUT,
    });
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    const geometry = await unavailable.evaluate((surface) => {
      const bounds = surface.getBoundingClientRect();
      const retry = surface.querySelector<HTMLElement>('button')?.getBoundingClientRect();
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        surfaceInsideViewport: bounds.left >= -1 && bounds.right <= innerWidth + 1,
        descendantsFit: Array.from(surface.querySelectorAll<HTMLElement>('*')).every((node) => {
          const nodeBounds = node.getBoundingClientRect();
          return nodeBounds.left >= bounds.left - 1 && nodeBounds.right <= bounds.right + 1;
        }),
        retryTouchTarget: Boolean(retry && retry.width >= 44 && retry.height >= 44),
      };
    });
    expect(geometry).toEqual({
      documentOverflow: 0,
      surfaceInsideViewport: true,
      descendantsFit: true,
      retryTouchTarget: true,
    });
    economy.assertNone();
  });

  test('reduced-motion preference flattens all long or repeating challenge animation', async ({
    page,
  }, testInfo) => {
    const economy = observeEconomyMutations(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openChallengeTier(page, testInfo, 'daily');
    await page.waitForTimeout(50);

    const result = await page.locator('#daily-missions').evaluate((surface) => {
      const parseDuration = (value: string): number => {
        const duration = Number.parseFloat(value);
        if (!Number.isFinite(duration)) return 0;
        return value.trim().endsWith('ms') ? duration : duration * 1000;
      };
      const offenders: Array<{ element: string; channel: string; value: string }> = [];
      const elements = [surface, ...surface.querySelectorAll<HTMLElement>('*')];

      for (const element of elements) {
        for (const pseudo of [null, '::before', '::after'] as const) {
          const style = getComputedStyle(element, pseudo);
          const label = `${element.tagName.toLowerCase()}${
            element.id ? `#${element.id}` : ''
          }${pseudo || ''}`;
          const animationNames = style.animationName.split(',').map((value) => value.trim());
          const animationDurations = style.animationDuration
            .split(',')
            .map((value) => parseDuration(value));
          const animationIterations = style.animationIterationCount
            .split(',')
            .map((value) => (value.trim() === 'infinite' ? Infinity : Number(value)));
          if (
            animationNames.some((name) => name !== 'none') &&
            (animationDurations.some((duration) => duration > 2) ||
              animationIterations.some((iterations) => iterations > 1))
          ) {
            offenders.push({
              element: label,
              channel: 'animation',
              value: `${style.animationName} / ${style.animationDuration} / ${style.animationIterationCount}`,
            });
          }
          if (
            style.transitionDuration
              .split(',')
              .map((value) => parseDuration(value))
              .some((duration) => duration > 2)
          ) {
            offenders.push({
              element: label,
              channel: 'transition',
              value: style.transitionDuration,
            });
          }
        }
      }

      const longRunningAnimations = surface.getAnimations({ subtree: true }).filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        const duration = typeof timing?.duration === 'number' ? timing.duration : 0;
        return (
          animation.playState === 'running' && (duration > 2 || timing?.iterations === Infinity)
        );
      }).length;

      return {
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        longRunningAnimations,
        offenders,
      };
    });

    expect(result.reducedMotion).toBe(true);
    expect(result.scrollBehavior).toBe('auto');
    expect(result.longRunningAnimations).toBe(0);
    expect(result.offenders).toEqual([]);
    economy.assertNone();
  });
});
