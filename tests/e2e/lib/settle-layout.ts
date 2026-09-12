import type { Page } from '@playwright/test';

/** Wait for fonts and finite layout entrances, leaving decorative loops running. */
export async function settleLayout(page: Page, timeoutMs = 5_000): Promise<void> {
  await page.evaluate(async (deadlineMs) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Layout did not settle before its deadline')),
        deadlineMs
      );
    });
    const settled = async () => {
      await document.fonts.ready;
      const entrances = document.getAnimations().filter((animation) => {
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === 'number' && Number.isFinite(end);
      });
      await Promise.all(entrances.map((animation) => animation.finished.catch(() => undefined)));
      // Allow the real ResizeObserver height publisher to consume the final frame.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    try {
      await Promise.race([settled(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }, timeoutMs);
}
