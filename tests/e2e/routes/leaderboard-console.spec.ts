import { expect, test } from '@playwright/test';

// Read-only production coverage. The post-deploy workflow already runs routes/.
// Never publish a program or invoke settlement against a real account here.
for (const width of [393, 1440]) {
  test(`Leaderboard Console Is Painted And Reachable At ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('leaderboard');
    const board = page.locator('[data-arena-surface="leaderboard-console"]');
    await expect(board).toBeVisible({ timeout: 30000 });
    await expect(board.locator('.sc')).toHaveCount(1);
    await expect(board.locator('.sc__head')).toHaveCSS(
      'background-image',
      /spade-console-v1\/top\.png/
    );
    await expect(board.getByRole('heading', { name: 'Leaderboards', level: 1 })).toBeAttached();
    await expect(board.getByRole('tab', { name: 'Rankings' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await board.getByRole('button', { name: 'Global', exact: true }).click();
    await expect(board.getByRole('button', { name: 'Global', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(board.getByRole('tab', { name: 'Tournament Stats' })).toHaveCount(0);
    await expect(board.locator('.lb-prize-program')).toHaveCount(0);
    await board.getByRole('button', { name: 'Hands Played', exact: true }).click();
    await expect(board.getByRole('button', { name: 'Hands Played', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30000,
    });
    await expect(board.locator('.lb-error-state')).toHaveCount(0);

    const geometry = await board.evaluate((root) => ({
      width: root.querySelector('.sc')!.getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      clipped: [...root.querySelectorAll<HTMLElement>('.sc-zone > span')]
        .filter((el) => el.scrollWidth > el.clientWidth + 2)
        .map((el) => el.textContent),
    }));
    expect(geometry.width).toBeLessThanOrEqual(1000);
    expect(geometry.overflow).toBe(false);
    expect(geometry.clipped).toEqual([]);
    await expect(board.locator('.lb-hero, .podium-crown, .podium-bar, .empty-icon')).toHaveCount(0);

    await board.getByRole('button', { name: 'My Clubs', exact: true }).click();
    await board.getByRole('tab', { name: 'Tournament Stats' }).click();
    await expect(board.getByText('All Recorded Tournaments', { exact: true })).toBeVisible();
    await expect(board.getByRole('button', { name: 'Previous Period' })).toHaveCount(0);
    await expect(board.locator('.lb-prize-program, .lb-settlement-card')).toHaveCount(0);
  });
}
