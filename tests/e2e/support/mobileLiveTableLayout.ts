import { expect, type Page, type TestInfo } from '@playwright/test';

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
      await testInfo.attach(`mobile-live-table-${width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await testInfo.attach(`mobile-live-table-${width}-measurements`, {
        body: Buffer.from(JSON.stringify(measured)),
        contentType: 'application/json',
      });
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
    await testInfo.attach('mobile-live-table-seat-change-toggle', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}
