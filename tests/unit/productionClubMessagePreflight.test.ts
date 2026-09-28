import type { Page } from '@playwright/test';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { dismissClubEntryMessage } from '../e2e/global-setup';

vi.mock('@playwright/test', () => ({ chromium: {} }));

type Handler = () => Promise<void>;

function fixture(response: Promise<unknown>, click = vi.fn().mockResolvedValue(undefined)) {
  // The invitation's Not Now; its evaluate is the handler's stack read.
  const notNow = { evaluate: vi.fn().mockResolvedValue(null), click: vi.fn() };
  const dialog = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(false),
    getByRole: vi.fn(() => notNow),
  };
  const dismiss = { waitFor: vi.fn().mockResolvedValue(undefined), click };
  const handlers: Handler[] = [];
  const page = {
    getByRole: vi.fn((role: string) => (role === 'dialog' ? dialog : dismiss)),
    waitForResponse: vi.fn(() => response),
    addLocatorHandler: vi.fn(async (_locator: unknown, handler: Handler) => {
      handlers.push(handler);
    }),
    removeLocatorHandler: vi.fn().mockResolvedValue(undefined),
  };
  return { page: page as unknown as Page, dialog, dismiss, notNow, handlers };
}

describe('production club-message setup', () => {
  it('preserves a failed click when browser cleanup rejects the pending response', async () => {
    let rejectResponse!: (error: Error) => void;
    // Playwright runs in Node. Use its native promise semantics here rather
    // than happy-dom's browser rejection handling.
    const NodePromise = runInNewContext('Promise') as PromiseConstructor;
    const response = new NodePromise((_, reject) => {
      rejectResponse = reject;
    });
    const blockedClick = new Error('Club message click was intercepted');
    const { page } = fixture(response, vi.fn().mockRejectedValue(blockedClick));

    await expect(dismissClubEntryMessage(page)).rejects.toBe(blockedClick);
    // This is the real global-setup finally path: closing the browser rejects
    // outstanding response waits. It must not become an unhandled rejection
    // that terminates the reporter and masks the original click failure.
    rejectResponse(new Error('Target page, context or browser has been closed'));
    await setImmediate();
  });

  it('requires successful server persistence before accepting dismissal', async () => {
    const { page, dialog } = fixture(
      Promise.resolve({
        ok: () => true,
        status: () => 200,
        json: async () => ({ ok: true }),
      })
    );
    await expect(dismissClubEntryMessage(page)).resolves.toBe(true);
    expect(dialog.waitFor).toHaveBeenCalledWith({ state: 'hidden', timeout: 10_000 });
  });

  it('refuses a visually closed message when the server rejected persistence', async () => {
    const { page, dialog } = fixture(
      Promise.resolve({
        ok: () => false,
        status: () => 403,
        json: async () => ({ ok: false }),
      })
    );
    await expect(dismissClubEntryMessage(page)).rejects.toThrow('dismissal did not persist (403');
    expect(dialog.waitFor).not.toHaveBeenCalled();
  });

  it('reports a failed invitation decline through setup, never as an unhandled rejection', async () => {
    // Run 36364137556: the handler's Not Now click was still retrying when the
    // setup gave up and closed the browser. Playwright runs handlers from an
    // event listener, so that rejection had no owner and Node exited with it,
    // hiding the error of the click that was actually running.
    const NodePromise = runInNewContext('Promise') as PromiseConstructor;
    const clubClickTimeout = new Error('locator.click: Timeout 10000ms exceeded');
    const click = vi.fn(async () => {
      // As Playwright does: the pending action triggers the handler first.
      await fx.handlers[0]();
      throw clubClickTimeout;
    });
    const fx = fixture(new NodePromise(() => undefined), click);
    fx.notNow.evaluate.mockRejectedValue(
      new Error('locator.evaluate: Target page, context or browser has been closed')
    );

    const failure = await dismissClubEntryMessage(fx.page).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^Club entry message dismissal failed; the Diamond Spins invitation could not be declined: locator\.evaluate: Target page/
    );
    expect((failure as Error).cause).toBe(clubClickTimeout);
    // A handler invocation after setup has already failed is absorbed too.
    await expect(fx.handlers[0]()).resolves.toBeUndefined();
    await setImmediate();
  });

  it('yields to a greeting stacked above the invitation, then declines it once on top', async () => {
    const { page, handlers, notNow, dialog } = fixture(
      Promise.resolve({
        ok: () => true,
        status: () => 200,
        json: async () => ({ ok: true }),
      }),
      vi.fn(async () => {
        await handlers[0]();
      })
    );
    notNow.evaluate.mockResolvedValue({
      dialog: 'Club Message From Fixture Club',
      element: '<button>Do Not Show Me This Message Again</button>',
    });
    const options = vi.mocked(page.addLocatorHandler);
    await expect(dismissClubEntryMessage(page)).resolves.toBe(true);
    // Yielding must not be a spent handler or a wait on the covered offer.
    expect(options.mock.calls[0][2]).toEqual({ noWaitAfter: true });
    expect(notNow.click).not.toHaveBeenCalled();
    expect(page.removeLocatorHandler).toHaveBeenCalledTimes(1);
    expect(dialog.isVisible).toHaveBeenCalled();
  });
});
