import { expect, type Page } from '@playwright/test';

/** How many ranking entries exist and how many are still entering. Rows for a
 * large field can mount after an earlier wait settled, so a contrast reading is
 * only valid if this is unchanged and still-free of motion after the reading. */
export async function leaderboardMotionSnapshot(
  page: Page,
  boardSelector: string
): Promise<{ entries: number; moving: number }> {
  return page.locator(boardSelector).evaluate((root) => {
    const entries = [...root.querySelectorAll<HTMLElement>('.podium-section, .leaderboard-entry')];
    const moving = entries.filter(
      (entry) =>
        entry
          .getAnimations({ subtree: true })
          .some(
            (motion) =>
              Number.isFinite(Number(motion.effect?.getComputedTiming().endTime)) &&
              (motion.playState === 'running' || motion.playState === 'paused' || motion.pending)
          ) || Number(getComputedStyle(entry).opacity) < 1
    ).length;
    return { entries: entries.length, moving };
  });
}

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
