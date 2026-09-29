import type { Locator, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({ expect: vi.fn(), chromium: {} }));

import {
  DIAMOND_DECLINE_CLICK_TIMEOUT_MS,
  DIAMOND_DECLINE_STALL_EXTENSION_MS,
  registerDiamondInvitationDismissal,
} from '../e2e/support/cashLobbyOverlays';

/**
 * Production run 36533736673 (WebKit, cash case): the invitation's Not Now
 * click died on "element is not stable" after the old 10s budget. The trace
 * shows the first stability check took 5.0s to answer and the retry took the
 * rest, while the card itself settles in 409ms in isolation (real Modal and
 * SpadeConsole, 390x664, main thread held 180ms of every 200ms as well).
 * A covered plate is a different failure and must stay a 10s report
 * (mobile-lobby-chrome.spec.ts "an unowned layer over the invitation").
 */
function fixture(...clickErrors: Error[]) {
  const click = vi.fn();
  for (const error of clickErrors) click.mockRejectedValueOnce(error);
  // First read is the handler's stack check (nothing covers the plate); any
  // later one is the failure report's frame-clock question.
  const notNow = { evaluate: vi.fn(), click };
  const dialog = { getByRole: vi.fn(() => notNow) };
  const handlers: Array<() => Promise<void>> = [];
  const page = {
    getByRole: vi.fn(() => dialog),
    addLocatorHandler: vi.fn(async (_locator: Locator, handler: () => Promise<void>) => {
      handlers.push(handler);
    }),
  };
  return { page: page as unknown as Page, notNow, handlers };
}

const notStable = (ms: number) =>
  new Error(
    `locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for element to be visible, enabled and stable\n  - element is not stable`
  );

describe('the Diamond Spins Not Now click waits for the page, and says what the page did', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the covered-plate report at 10s and sizes the extension past two measured 5s stalls', () => {
    expect(DIAMOND_DECLINE_CLICK_TIMEOUT_MS).toBe(10_000);
    expect(DIAMOND_DECLINE_STALL_EXTENSION_MS).toBeGreaterThanOrEqual(20_000);
    expect(DIAMOND_DECLINE_STALL_EXTENSION_MS).toBeGreaterThan(2 * 5_000);
  });

  it('gives a plate that never got a settled frame a second real click, then reports the frame clock', async () => {
    const first = notStable(10_000);
    const second = notStable(20_000);
    const { page, notNow, handlers } = fixture(first, second);
    notNow.evaluate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('3 animation frames in 1s, plate 67,372 122x41 -> 67,372 122x41');
    const failures: unknown[] = [];
    await registerDiamondInvitationDismissal(page, { onFailure: (e) => failures.push(e) });
    await handlers[0]();

    expect(notNow.click.mock.calls).toEqual([
      [{ timeout: DIAMOND_DECLINE_CLICK_TIMEOUT_MS }],
      [{ timeout: DIAMOND_DECLINE_STALL_EXTENSION_MS }],
    ]);
    expect(failures).toHaveLength(1);
    const failure = failures[0] as Error;
    expect(failure.message).toContain('The Diamond Spins Not Now click failed after 30000ms');
    expect(failure.message).toContain('element is not stable');
    expect(failure.message).toContain('3 animation frames in 1s');
    expect(failure.cause).toBe(second);
  });

  it('reports a covering layer after the first 10s, with its own call log and no second wait', async () => {
    const covered = new Error(
      'locator.click: Timeout 10000ms exceeded.\nCall log:\n  - <div id="unowned"></div> intercepts pointer events'
    );
    const { page, notNow, handlers } = fixture(covered);
    notNow.evaluate.mockResolvedValueOnce(null);
    const failures: unknown[] = [];
    await registerDiamondInvitationDismissal(page, { onFailure: (e) => failures.push(e) });
    await handlers[0]();

    expect(notNow.click).toHaveBeenCalledTimes(1);
    expect(notNow.evaluate).toHaveBeenCalledTimes(1);
    const failure = failures[0] as Error;
    expect(failure.message).toContain('failed after 10000ms');
    expect(failure.message).toContain('intercepts pointer events');
    expect(failure.cause).toBe(covered);
  });

  it('names a page that gives no answer at all instead of hanging the report', async () => {
    vi.useFakeTimers();
    const { page, notNow, handlers } = fixture(notStable(10_000), notStable(20_000));
    notNow.evaluate.mockResolvedValueOnce(null).mockReturnValueOnce(new Promise(() => undefined));
    const failures: unknown[] = [];
    await registerDiamondInvitationDismissal(page, { onFailure: (e) => failures.push(e) });
    const run = handlers[0]();
    await vi.advanceTimersByTimeAsync(3_100);
    await run;
    expect((failures[0] as Error).message).toContain('main thread blocked');
  });
});
