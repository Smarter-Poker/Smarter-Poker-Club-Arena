import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { mountDiamondWheel } from '../helpers/diamond-wheel-fixture.mjs';
import { WHEEL_SPIN_MS } from '../../../src/utils/diamondWheelMotion';

type WheelProof = {
  finished: number;
  events: { event: string; title?: string; time: number }[];
  upgradeStates: {
    phase: string;
    expanded: string;
    selectors: number;
    titles: number;
    cards: number;
    slots: number;
    visible: boolean;
    scale: string;
    finished: number;
    destination: string;
  }[];
};
declare global {
  interface Window {
    wheelProof: WheelProof;
  }
}

test.use({ storageState: { cookies: [], origins: [] } });

async function insideViewport(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements.every((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= innerWidth + 1;
    })
  );
}

for (const width of [320, 390, 1280]) {
  for (const kind of ['prize', 'bonus', 'upgrade', 'upgradechips'] as const) {
    test(`Diamond wheel ${kind} completes its reveal at ${width}px`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const receipt = await mountDiamondWheel(page, kind, width);
      const wheel = page.getByRole('img', { name: 'Diamond Wheel', exact: true });
      const secondary = page.getByRole('img', { name: 'Upgrade Wheel', exact: true });
      await expect(page.locator('[data-painted-band="loading"]')).toHaveCount(0);
      await expect(page.locator('[data-painted-band="cached"]')).toHaveCount(64);
      await expect(secondary.locator('[data-slot]')).toHaveCount(8);
      await expect(secondary).toBeVisible();
      await expect(secondary.locator('[data-wheel-selector]')).toHaveCount(0);
      await expect(secondary.locator('[data-card-design="title"]')).toHaveCount(8);
      await expect(secondary.locator('[data-card-design="full"]')).toHaveCount(0);
      await expect(page.locator('[data-wheel-assembly]')).toHaveAttribute(
        'data-upgrade-reveal',
        'peek'
      );
      await expect(wheel.locator('[data-wheel-face]')).toHaveCSS(
        'transform',
        'matrix(0.91, 0, 0, 0.91, 0, 0)'
      );
      await expect(wheel.locator('[data-wheel-selector]')).toHaveCount(1);
      await expect
        .poll(async () => (await wheel.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(width - 24);
      const upperBox = await secondary.boundingBox();
      const lowerBox = await wheel.boundingBox();
      const controlsBox = await page
        .getByRole('complementary', { name: 'Diamond Spins Controls' })
        .boundingBox();
      expect(controlsBox!.y).toBeGreaterThanOrEqual(lowerBox!.y + lowerBox!.height);
      // Both independent rotors share one centre and one uninterrupted aperture.
      expect(upperBox).toEqual(lowerBox);
      await expect(page.locator('[data-wheel-assembly="concentric"]')).toHaveCount(1);
      await expect(secondary).toHaveAttribute('viewBox', '320 0 360 415');
      await expect(wheel).toHaveAttribute('viewBox', '320 0 360 415');
      await expect(secondary.locator('..')).toHaveAttribute('data-idle-direction', '-1');
      await expect(wheel.locator('..')).toHaveAttribute('data-idle-direction', '1');
      await expect(wheel.locator('[data-slot]')).toHaveCount(12);
      await expect(
        page.getByRole('region', { name: 'Wheel Prizes' }).getByRole('listitem')
      ).toHaveCount(12);
      expect(
        await insideViewport(page, '[aria-label="Diamond Wheel"], [aria-label="Wheel Prizes"] li')
      ).toBe(true);
      await expect(page.getByLabel('Diamonds To Spin')).toHaveValue(
        String(receipt.entry_value_diamonds)
      );
      for (const amount of ['25', '100', '500', '1,000', '2,500']) {
        const target = await page.getByRole('button', { name: amount, exact: true }).boundingBox();
        expect(target!.width).toBeGreaterThanOrEqual(44);
        expect(target!.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({
        path: testInfo.outputPath(`wheel-idle-${width}.png`),
        fullPage: true,
      });
      const idleRotation = await wheel.locator('[data-wheel-rotor]').getAttribute('transform');
      await expect
        .poll(() => wheel.locator('[data-wheel-rotor]').getAttribute('transform'))
        .not.toBe(idleRotation);
      await page.getByRole('button', { name: 'Preview Spin', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Preview Spin', exact: true })).toBeDisabled();
      await expect(page.getByLabel('Diamonds To Spin')).toBeDisabled();
      await expect(page.getByTestId('destination')).toHaveText('/clubs/fixture/wheel');

      if (kind.startsWith('upgrade')) {
        // The fixture runs at the player's 0.25 animation-speed setting. On a
        // software-rendered runner, sequential round trips can span the entire
        // secondary spin. Require all the same properties in ONE observed
        // rendered state, retained before the real game navigation removes it.
        await expect
          .poll(() => page.evaluate(() => window.wheelProof.upgradeStates), {
            timeout: WHEEL_SPIN_MS + 1400 + 650,
          })
          .toContainEqual({
            phase: 'spinning',
            expanded: 'open',
            selectors: 1,
            titles: 0,
            cards: 8,
            slots: 8,
            visible: true,
            scale: 'matrix(0.56, 0, 0, 0.56, 0, 0)',
            finished: 0,
            destination: '/clubs/fixture/wheel',
          });
      }
      if (kind === 'prize' || kind === 'upgradechips') {
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('aria-label', /Chips?$/);
        await expect(dialog).toBeVisible();
        const proceed = dialog.getByRole('button', { name: 'Continue', exact: true });
        await expect(proceed).toBeEnabled();
        expect(await insideViewport(page, '[role="dialog"], [role="dialog"] button')).toBe(true);
        await expect(proceed).toBeInViewport();
        // Give a completed reveal another full reveal duration: a timer must not
        // dismiss a booked prize without the player's explicit acknowledgement.
        await page.evaluate(async () => {
          const opening = document.querySelector('[role="dialog"] [data-motion="keep"]')!;
          const duration = parseFloat(getComputedStyle(opening).animationDuration) * 1000;
          await new Promise((resolve) => setTimeout(resolve, duration));
        });
        await expect(dialog).toBeVisible();
        expect(await page.evaluate(() => window.wheelProof.finished)).toBe(0);
        await page.screenshot({ path: testInfo.outputPath(`wheel-prize-${width}.png`) });
        await proceed.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('destination')).toHaveText('/clubs/fixture/wheel');
      } else {
        await expect(page.getByRole('heading', { name: 'Earned Game Entry' })).toBeVisible();
        await expect(page.getByTestId('destination')).toHaveText(
          `/clubs/fixture/${receipt.bonus.game}?wheelAward=${receipt.bonus.id}`
        );
      }
      const proof = await page.evaluate(() => window.wheelProof);
      expect(proof.finished).toBe(1);
      const starts = proof.events.filter((event) => event.event === 'animationstart');
      const ends = proof.events.filter((event) => event.event === 'animationend');
      expect(starts).toHaveLength(kind.startsWith('upgrade') ? 2 : 1);
      expect(ends).toHaveLength(starts.length);
      expect(proof.events.at(-1)?.event).toBe('finished');
      if (kind.startsWith('upgrade')) {
        expect(starts[0].title).toBe('Bonus Upgrade');
        expect(starts[1].time).toBeGreaterThan(ends[0].time);
        expect(starts[1].title).not.toBe('Bonus Upgrade');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      expect(errors).toEqual([]);
      const proofPath = testInfo.outputPath('wheel-animation-proof.json');
      await writeFile(proofPath, JSON.stringify(proof, null, 2));
      await testInfo.attach('wheel-animation-proof', {
        path: proofPath,
        contentType: 'application/json',
      });
    });
  }
}

// Pin the actual page, including free entry choices, real global styles and
// the control panel. The old width-only wheel put Spin below the first screen.
for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 844, height: 390 },
  { width: 844, height: 390, fallbackFonts: true },
]) {
  test(`Diamond Spins controls share one screen at ${viewport.width}x${viewport.height}${'fallbackFonts' in viewport ? ' with fallback fonts' : ''}`, async ({
    page,
  }, testInfo) => {
    const { diamondWheelPageFixture } = await import('../helpers/diamond-wheel-page-fixture.mjs');
    const bundle = await diamondWheelPageFixture();
    await page.setViewportSize(viewport);
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'diamond-wheel.test') return route.abort();
      if (
        url.pathname.startsWith('/assets/') ||
        url.pathname.startsWith('/fonts/') ||
        url.pathname.startsWith('/images/') ||
        url.pathname === '/default-avatar.png'
      ) {
        const { resolve, sep } = await import('node:path');
        const root = resolve('public');
        const path = resolve(root, '.' + decodeURIComponent(url.pathname));
        return path.startsWith(root + sep) ? route.fulfill({ path }) : route.abort();
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}</style><div id="root"></div>',
      });
    });
    await page.goto('https://diamond-wheel.test/');
    await page.addStyleTag({ content: bundle.css });
    if ('fallbackFonts' in viewport) {
      await page.addStyleTag({
        content:
          '[aria-label="Diamond Spins Controls"] button {font-family: Arial, sans-serif !important}',
      });
    }
    await page.addScriptTag({ content: bundle.javascript });
    const controls = page.getByRole('complementary', { name: 'Diamond Spins Controls' });
    await expect(controls).toBeVisible();
    await controls.getByRole('button', { name: 'Use Diamonds', exact: true }).click();
    await controls.getByRole('button', { name: 'Hold Automatic Spin', exact: true }).click();
    await expect(page.locator('#global-header')).toBeVisible();
    await expect(controls.getByText('Club Chips', { exact: true })).toBeVisible();
    await expect(controls.getByText('12.3K', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
    const assertFits = async () => {
      const measured = await controls.evaluate((el) => {
        const wheel = document.querySelector('[data-wheel-assembly]')!.getBoundingClientRect();
        const controls = el.getBoundingClientRect();
        return {
          wheelHeight: wheel.height,
          wheelBottom: wheel.bottom,
          controlsTop: controls.top,
          bottom: controls.bottom,
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          targets: [...el.querySelectorAll('button,input')]
            .filter((e) => !(e as HTMLElement).hidden)
            .map((e) => {
              const b = e.getBoundingClientRect();
              return (
                b.top >= 0 &&
                b.bottom <= innerHeight + 1 &&
                b.left >= 0 &&
                b.right <= innerWidth + 1 &&
                b.height >= 32
              );
            }),
        };
      });
      expect(measured.wheelHeight).toBeGreaterThan(100);
      expect(measured.controlsTop).toBeGreaterThanOrEqual(measured.wheelBottom - 1);
      expect(measured.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(measured.scrollHeight).toBeLessThanOrEqual(viewport.height + 1);
      expect(measured.scrollWidth).toBeLessThanOrEqual(viewport.width);
      expect(measured.targets.every(Boolean)).toBe(true);
      expect(
        await controls.locator('button').evaluateAll((elements) =>
          elements.flatMap((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect(),
              button = el.getBoundingClientRect();
            return text.left >= button.left &&
              text.right <= button.right &&
              text.top >= button.top &&
              text.bottom <= button.bottom
              ? []
              : [{ label: el.textContent, text: text.toJSON(), button: button.toJSON() }];
          })
        )
      ).toEqual([]);
    };
    await assertFits();
    await controls.getByRole('button', { name: '2,500', exact: true }).click();
    await expect(page.getByLabel('Diamonds To Spin')).toHaveValue('2500');
    await expect(page.getByRole('button', { name: 'Spin 2,500', exact: true })).toBeEnabled();
    await controls.getByRole('button', { name: 'Run Off', exact: true }).click();
    await expect(controls.getByRole('button', { name: /^Auto Spin / })).toBeEnabled();
    await assertFits();
    await controls.getByRole('button', { name: 'Bonus Spins (2)', exact: true }).click();
    await expect(page.getByLabel('Diamonds To Spin')).toBeDisabled();
    await expect(controls.getByRole('button', { name: 'Bonus Spin', exact: true })).toBeEnabled();
    await assertFits();
    await controls.getByRole('button', { name: 'Prizes & More', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'Diamond Spins Details' });
    await expect(details).toBeVisible();
    await expect(
      details.getByRole('region', { name: 'Wheel Prizes' }).getByRole('listitem')
    ).toHaveCount(12);
    await expect(details.getByRole('heading', { name: 'Check Any Spin' })).toBeAttached();
    await expect(details.getByRole('heading', { name: 'History', exact: true })).toBeAttached();
    await details.getByRole('button', { name: 'Close Dialog' }).click();
    await expect(details).toHaveCount(0);
    await assertFits();
    await page.screenshot({ path: testInfo.outputPath('one-screen.png') });
    if (viewport.width === 320) {
      await page.goto('https://diamond-wheel.test/?paused');
      await page.addStyleTag({ content: bundle.css });
      await page.addScriptTag({ content: bundle.javascript });
      await expect(controls.getByText('Local Connection Is Paused', { exact: true })).toBeVisible();
      await expect(
        controls.getByRole('button', { name: 'Refresh Wheel', exact: true })
      ).toBeEnabled();
      await expect(
        controls.getByRole('button', { name: 'Bonus Spin', exact: true })
      ).toBeDisabled();
      await assertFits();
      await page.screenshot({ path: testInfo.outputPath('one-screen-paused.png') });
    }
  });
}
