import type { Page } from '@playwright/test';

/** One initial navigation budget, including rendering after the wire is ready. */
export function remainingInitialTableReadinessMs(
  startedAt: number,
  budgetMs: number,
  now = Date.now()
): number {
  const remaining = startedAt + budgetMs - now;
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(budgetMs) ||
    !Number.isFinite(now) ||
    budgetMs <= 0 ||
    now < startedAt ||
    remaining <= 0
  ) {
    throw new Error('Initial table readiness exceeded its navigation deadline');
  }
  return remaining;
}

/** One browser observation, rather than serial assertion transport round trips. */
export function observeInitialTableReadiness({
  startedAt,
  deadline,
}: {
  startedAt: number;
  deadline: number;
}): false | { kind: 'ready' | 'expired'; observedAt: number } {
  const observedAt = Date.now();
  if (observedAt < startedAt || observedAt >= deadline) return { kind: 'expired', observedAt };
  const visible = (element: Element | null) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const table = document.querySelector('.table-page');
  const felt = table?.querySelector('.table-surface') ?? null;
  const banner = document.querySelector('[data-testid="table-connection-banner"]');
  if (!visible(table) || !visible(felt) || visible(banner)) return false;
  return { kind: 'ready', observedAt };
}

/** The accepted time is sampled in the browser; returning its proof may take longer. */
export async function waitForInitialTableReadiness(
  page: Page,
  startedAt: number,
  budgetMs: number
) {
  const remaining = remainingInitialTableReadinessMs(startedAt, budgetMs);
  const deadline = startedAt + budgetMs;
  const proof = await page.waitForFunction(
    observeInitialTableReadiness,
    { startedAt, deadline },
    // This allowance only retrieves an already bounded observation. The browser
    // predicate returns expired at the original deadline, even if the UI is ready.
    { timeout: remaining + 10_000, polling: 'raf' }
  );
  try {
    const observed = await proof.jsonValue();
    if (
      !observed ||
      observed.kind !== 'ready' ||
      observed.observedAt < startedAt ||
      observed.observedAt >= deadline
    )
      throw new Error('Initial table readiness exceeded its navigation deadline');
    return observed;
  } finally {
    await proof.dispose();
  }
}
