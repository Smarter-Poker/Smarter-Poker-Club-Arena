import { expect, type Page } from '@playwright/test';

export async function waitForLeaderboardEntryMotion(
  page: Page,
  boardSelector: string,
  state: string
): Promise<void> {
  // aria-busy ends when rows arrive; their approved entrance motion finishes later.
  // Inspect the settled palette without disabling, shortening or skipping animation.
  await expect
    .poll(
      async () =>
        page.locator(boardSelector).evaluate((root) => {
          const entries = [
            ...root.querySelectorAll<HTMLElement>('.podium-section, .leaderboard-entry'),
          ];
          return entries.filter(
            (entry) =>
              entry
                .getAnimations({ subtree: true })
                .some(
                  (motion) =>
                    Number.isFinite(Number(motion.effect?.getComputedTiming().endTime)) &&
                    (motion.playState === 'running' ||
                      motion.playState === 'paused' ||
                      motion.pending)
                ) || Number(getComputedStyle(entry).opacity) < 1
          ).length;
        }),
      {
        timeout: 10_000,
        message: `${state}: ranking entrance motion must complete before contrast certification`,
      }
    )
    .toBe(0);
}
