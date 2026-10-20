import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** JSON reporter bodies are embedded, so retain files for the release artifact too. */
async function attachMobileProof(
  testInfo: TestInfo,
  name: string,
  body: Buffer,
  contentType: string
) {
  const path = testInfo.outputPath(`${name}.${contentType === 'image/png' ? 'png' : 'json'}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await testInfo.attach(name, { path, contentType });
}

/** Read the deployed table through the isolated spectator's real mobile UI. */
export async function certifyMobileLiveTableLayout(page: Page, testInfo: TestInfo) {
  const originalViewport = page.viewportSize();
  try {
    for (const width of [375, 393, 430]) {
      await page.setViewportSize({ width, height: 852 });
      // Commit the resize and its observer-driven layout before measuring.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
          )
      );
      await expect(page.locator('.table-art-cover:visible')).toHaveCount(0);
      const read = () =>
        page.evaluate(() => {
          const table = Array.from(document.querySelectorAll<HTMLElement>('.table-page')).find(
            (element) => element.getBoundingClientRect().width > 0
          );
          if (!table) return { violations: ['Missing Table'], occupied: 0 };
          const box = (element: Element) => element.getBoundingClientRect();
          const visible = (element: Element) => box(element).width > 0 && box(element).height > 0;
          const intersects = (a: DOMRect, b: DOMRect) =>
            a.left < b.right - 0.5 &&
            a.right > b.left + 0.5 &&
            a.top < b.bottom - 0.5 &&
            a.bottom > b.top + 0.5;
          const plates = Array.from(table.querySelectorAll('.seat__info')).filter(visible);
          const protectedNodes = Array.from(
            table.querySelectorAll(
              '.community-area, .pot-display, .seat__info, .seat__bet-chips, .seat__strength, .action-panel'
            )
          ).filter(visible);
          const cards = Array.from(
            table.querySelectorAll('.seat__cards--revealed .seat__card')
          ).filter(visible);
          const violations: string[] = [];
          for (const plate of plates) {
            const rect = box(plate);
            if (rect.width > innerWidth * 0.3 || rect.left < -1 || rect.right > innerWidth + 1)
              violations.push('Player Plate Outside Its Mobile Lane');
          }
          for (const card of cards) {
            const rect = box(card);
            if (rect.left < -1 || rect.right > innerWidth + 1)
              violations.push('Card Outside Viewport');
            for (const node of protectedNodes)
              if (intersects(rect, box(node))) violations.push(`Card Covers ${node.className}`);
          }
          const board = table.querySelector('.community-area');
          if (board && visible(board)) {
            for (const node of table.querySelectorAll(
              '.seat__info, .seat__avatar-img, .seat__action, .seat__bet-chips'
            ))
              if (visible(node) && intersects(box(node), box(board)))
                violations.push(`Player Or Bet Covers Board: ${node.className}`);
          }
          const mini = table.querySelector('.bbj-mini-plate');
          const head = table.querySelector('.seat-wrapper--top .seat__avatar-img');
          const topGap = mini && head && visible(head) ? box(head).top - box(mini).bottom : null;
          if (topGap !== null && (topGap < -1 || topGap > 12))
            violations.push('Top Player Does Not Sit Immediately Below Mini BBJ');
          return {
            violations,
            occupied: plates.length,
            width: innerWidth,
            plateWidths: plates.map((plate) => box(plate).width),
            revealedCards: cards.length,
            topGap,
            boards: table.querySelectorAll('.community-cards__card').length,
          };
        });
      await expect
        .poll(async () => (await read()).violations, {
          timeout: 10_000,
          message: `${width}px live mobile table containment`,
        })
        .toEqual([]);
      const measured = await read();
      expect(
        measured.occupied,
        'Mobile proof requires actual occupied seats'
      ).toBeGreaterThanOrEqual(2);
      console.log(`MOBILE_LIVE_TABLE_LAYOUT ${JSON.stringify(measured)}`);
      await attachMobileProof(
        testInfo,
        `mobile-live-table-${width}`,
        await page.screenshot(),
        'image/png'
      );
      await attachMobileProof(
        testInfo,
        `mobile-live-table-${width}-measurements`,
        Buffer.from(JSON.stringify(measured)),
        'application/json'
      );
    }
    const menu = page.getByRole('button', { name: 'Table Menu', exact: true });
    await menu.click();
    const toggle = page.getByRole('menuitemcheckbox', { name: /Seat Change/ });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(page.locator('.cch-seat-change-control:visible')).toHaveCount(0);
    await menu.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await menu.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await attachMobileProof(
      testInfo,
      'mobile-live-table-seat-change-toggle',
      await page.screenshot(),
      'image/png'
    );
    await page.keyboard.press('Escape');
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}

/** Observe real payouts during the existing hand/reconnect case; never inject a hand. */
export async function installMobileAwardJournal(page: Page) {
  await page.evaluate(() => {
    const evidence = {
      landings: [] as Array<{ distance: number; recipient: string }>,
      violations: [] as string[],
      multiBoardSamples: 0,
    };
    const seen = new Set<string>();
    const active = new Map<
      string,
      { chip: HTMLElement; recipient: string; distance: number | null }
    >();
    let frame = 0;
    let stopped = false;
    const inspect = () => {
      for (const chip of document.querySelectorAll<HTMLElement>('[data-chip-recipient]')) {
        const id = chip.dataset.chipFlight ?? '';
        if (!id) continue;
        const recipient = chip.dataset.chipRecipient ?? '';
        const flight = active.get(id) ?? { chip, recipient, distance: null };
        active.set(id, flight);
        const seat = Array.from(document.querySelectorAll<HTMLElement>('[data-player-id]')).find(
          (node) => node.dataset.playerId === recipient
        );
        const target = seat?.querySelector('.seat__info')?.getBoundingClientRect();
        if (!target || !target.width) {
          if (chip.dataset.chipPhase === 'landed' && !seen.has(id)) {
            seen.add(id);
            evidence.violations.push('Payout Has No Rendered Recipient');
          }
          continue;
        }
        const actual = chip.getBoundingClientRect();
        const distance = Math.hypot(
          actual.left + actual.width / 2 - target.left - target.width / 2,
          actual.top + actual.height / 2 - target.top - target.height / 2
        );
        flight.distance = distance;
        // Keep the explicit endpoint witness, and also retain the last visible
        // position when a short-lived state attribute was not observed.
        if (!seen.has(id) && chip.dataset.chipPhase === 'landed') {
          seen.add(id);
          evidence.landings.push({ distance, recipient });
          if (distance > 2) evidence.violations.push('Payout Missed Its Rendered Recipient');
        }
      }
      for (const [id, flight] of active) {
        if (flight.chip.isConnected) continue;
        active.delete(id);
        if (flight.distance === null || flight.distance > 2) {
          evidence.violations.push('Payout Disappeared Before Reaching Its Recipient');
        } else if (!seen.has(id)) {
          evidence.landings.push({ distance: flight.distance, recipient: flight.recipient });
        }
        seen.add(id);
      }
      for (const run of document.querySelectorAll('.community-area__run')) {
        if (!run.querySelector('.community-area__run-winner')) continue;
        evidence.multiBoardSamples++;
        if (
          run.querySelectorAll('.community-cards__card').length < 5 ||
          run.querySelector('.card-squeeze-host[data-rs-animating="true"]')
        )
          evidence.violations.push('Run Award Appeared Before Its River Finished');
      }
      if (!stopped && active.size && !frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          inspect();
        });
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-chip-phase', 'data-rs-animating'],
    });
    (window as any).__mobileAwardJournal = {
      evidence,
      stop: () => {
        stopped = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        inspect();
        observer.disconnect();
        return evidence;
      },
    };
  });
}
export async function certifyMobileAwardJournal(page: Page, testInfo: TestInfo) {
  const evidence = await page.evaluate(() => (window as any).__mobileAwardJournal.stop());
  console.log(`MOBILE_LIVE_PAYOUT_PROOF ${JSON.stringify(evidence)}`);
  await attachMobileProof(
    testInfo,
    'mobile-live-table-payout-measurements',
    Buffer.from(JSON.stringify(evidence)),
    'application/json'
  );
  expect(evidence.violations, 'Actual mobile payout and river ordering').toEqual([]);
  expect(evidence.landings.length, 'Live proof requires an actual payout landing').toBeGreaterThan(
    0
  );
}
