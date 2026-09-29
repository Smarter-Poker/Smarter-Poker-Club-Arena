import type { Locator, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({ expect: vi.fn(), chromium: {} }));

import {
  DIAMOND_DECLINE_CLICK_TIMEOUT_MS,
  registerDiamondInvitationDismissal,
} from '../e2e/support/cashLobbyOverlays';

/**
 * Production run 36533736673 (WebKit, cash case): the invitation's Not Now
 * click died on "element is not stable" after the old 10s budget. The trace
 * shows the first stability check took 5.0s to answer and the retry took the
 * rest, while the card itself settles in 409ms in isolation (real Modal and
 * SpadeConsole, 390x664, main thread held 180ms of every 200ms as well).
 */
function fixture(clickError: Error) {
  const notNow = {
    // First read is the handler's stack check (nothing covers the plate); the
    // second is the failure report's frame-clock question.
    evaluate: vi.fn(),
    click: vi.fn().mockRejectedValue(clickError),
  };
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

describe('the Diamond Spins Not Now click waits for the page, and says what the page did', () => {
  afterEach(() => vi.useRealTimers());

  it('sizes the wait past two measured 5s stability stalls', () => {
    expect(DIAMOND_DECLINE_CLICK_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(DIAMOND_DECLINE_CLICK_TIMEOUT_MS).toBeGreaterThan(2 * 5_000 + 8_000);
  });

  it('clicks the real control with that budget and reports the frame clock on failure', async () => {
    const stable = new Error(
      'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - element is not stable'
    );
    const { page, notNow, handlers } = fixture(stable);
    notNow.evaluate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('3 animation frames in 1s, plate 67,372 122x41 -> 67,372 122x41');
    const failures: unknown[] = [];
    await registerDiamondInvitationDismissal(page, { onFailure: (e) => failures.push(e) });
    await handlers[0]();

    expect(notNow.click).toHaveBeenCalledWith({ timeout: DIAMOND_DECLINE_CLICK_TIMEOUT_MS });
    expect(failures).toHaveLength(1);
    const failure = failures[0] as Error;
    expect(failure.message).toContain(
      `The Diamond Spins Not Now click failed after ${DIAMOND_DECLINE_CLICK_TIMEOUT_MS}ms`
    );
    expect(failure.message).toContain('locator.click: Timeout 30000ms exceeded.');
    expect(failure.message).toContain('3 animation frames in 1s');
    expect(failure.cause).toBe(stable);
  });

  it('names a page that gives no answer at all instead of hanging the report', async () => {
    vi.useFakeTimers();
    const { page, notNow, handlers } = fixture(
      new Error('locator.click: Timeout 30000ms exceeded')
    );
    notNow.evaluate.mockResolvedValueOnce(null).mockReturnValueOnce(new Promise(() => undefined));
    const failures: unknown[] = [];
    await registerDiamondInvitationDismissal(page, { onFailure: (e) => failures.push(e) });
    const run = handlers[0]();
    await vi.advanceTimersByTimeAsync(3_100);
    await run;
    expect((failures[0] as Error).message).toContain('main thread blocked');
  });
});
