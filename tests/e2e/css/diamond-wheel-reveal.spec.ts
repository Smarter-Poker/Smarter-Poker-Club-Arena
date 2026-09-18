import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { mountDiamondWheel } from '../helpers/diamond-wheel-fixture.mjs';

type WheelProof = {
  finished: number;
  events: { event: string; title?: string; time: number }[];
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
      await expect(secondary.locator('[data-slot]')).toHaveCount(8);
      await expect(secondary).toBeVisible();
      await expect(secondary.locator('[data-wheel-selector]')).toHaveCount(0);
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
        await expect(secondary.locator('..')).toHaveAttribute('data-phase', 'spinning');
        await expect(secondary.locator('[data-wheel-selector]')).toHaveCount(1);
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
        if (kind === 'upgrade') {
          await expect(secondary).toBeVisible();
          await expect(secondary.locator('[data-slot]')).toHaveCount(8);
          expect(await page.evaluate(() => window.wheelProof.finished)).toBe(0);
          await expect(page.getByTestId('destination')).toHaveText('/clubs/fixture/wheel');
          await page.screenshot({ path: testInfo.outputPath(`wheel-upgrade-${width}.png`) });
        }
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
