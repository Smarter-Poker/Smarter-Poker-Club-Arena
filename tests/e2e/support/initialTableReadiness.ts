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

interface InitialReadinessHistory {
  startedAt: number;
  deadline: number;
  stopped: boolean;
  samples: { observedAt: number; ready: boolean }[];
  stop: () => void;
}
type ReadinessWindow = Window & { __spInitialTableReadiness?: InitialReadinessHistory };

/** Finite browser sampling keeps runtime evidence independent of inspector delivery. */
export function startInitialTableReadiness({
  startedAt,
  deadline,
}: {
  startedAt: number;
  deadline: number;
}) {
  const target = window as ReadinessWindow;
  target.__spInitialTableReadiness?.stop();
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state: InitialReadinessHistory = {
    startedAt,
    deadline,
    stopped: false,
    samples: [],
    stop: () => {
      state.stopped = true;
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
  target.__spInitialTableReadiness = state;
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
  const sample = () => {
    if (state.stopped) return;
    const observedAt = Date.now();
    if (observedAt < startedAt || observedAt >= deadline) {
      state.stop();
      return;
    }
    const table = document.querySelector('.table-page');
    state.samples.push({
      observedAt,
      ready:
        visible(table) &&
        visible(table?.querySelector('.table-surface') ?? null) &&
        !visible(document.querySelector('[data-testid="table-connection-banner"]')),
    });
    if (state.samples.length > 1000) state.samples.shift();
    frame = requestAnimationFrame(sample);
  };
  sample();
  if (!state.stopped) timer = setTimeout(state.stop, Math.max(0, deadline - Date.now()));
}

/** An early banner grace period cannot prove readiness after the wire arrives. */
export function readInitialTableReadiness({
  startedAt,
  deadline,
  wireAt,
}: {
  startedAt: number;
  deadline: number;
  wireAt: number;
}): false | { kind: 'ready' | 'expired' | 'missing'; observedAt: number } {
  const state = (window as ReadinessWindow).__spInitialTableReadiness;
  if (!state || state.startedAt !== startedAt || state.deadline !== deadline)
    return { kind: 'missing', observedAt: Date.now() };
  const ready = state.samples.find(
    (sample) => sample.ready && sample.observedAt >= wireAt && sample.observedAt < deadline
  );
  if (ready) return { kind: 'ready', observedAt: ready.observedAt };
  if (state.stopped || Date.now() >= deadline) return { kind: 'expired', observedAt: Date.now() };
  return false;
}

/** Accept only a bounded UI sample after every required wire frame, even on late readback. */
export async function waitForInitialTableReadiness(
  page: Page,
  startedAt: number,
  budgetMs: number,
  protocolReady: Promise<readonly { at: number }[]> = Promise.resolve([{ at: startedAt }])
) {
  remainingInitialTableReadinessMs(startedAt, budgetMs);
  const deadline = startedAt + budgetMs;
  await page.evaluate(startInitialTableReadiness, { startedAt, deadline });
  try {
    const frames = await protocolReady;
    const wireAt = Math.max(...frames.map((frame) => frame.at));
    if (!Number.isFinite(wireAt) || wireAt < startedAt || wireAt >= deadline)
      throw new Error('Initial table readiness exceeded its navigation deadline');
    const proof = await page.waitForFunction(
      readInitialTableReadiness,
      { startedAt, deadline, wireAt },
      // Only reading retained browser evidence gets this allowance. Sampling
      // stops at the original deadline and can never record a late UI as ready.
      { timeout: Math.max(0, deadline - Date.now()) + 10_000, polling: 'raf' }
    );
    try {
      const observed = await proof.jsonValue();
      if (
        !observed ||
        observed.kind !== 'ready' ||
        observed.observedAt < wireAt ||
        observed.observedAt >= deadline
      )
        throw new Error('Initial table readiness exceeded its navigation deadline');
      return observed;
    } finally {
      await proof.dispose();
    }
  } finally {
    if (!page.isClosed())
      await page.evaluate((expectedStart) => {
        const target = window as ReadinessWindow;
        if (target.__spInitialTableReadiness?.startedAt !== expectedStart) return;
        target.__spInitialTableReadiness.stop();
        delete target.__spInitialTableReadiness;
      }, startedAt);
  }
}
