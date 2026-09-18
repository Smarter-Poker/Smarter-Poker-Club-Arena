import type { Page } from '@playwright/test';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { dismissClubEntryMessage } from '../e2e/global-setup';

vi.mock('@playwright/test', () => ({ chromium: {} }));

function fixture(response: Promise<unknown>, click = vi.fn().mockResolvedValue(undefined)) {
  const dialog = { waitFor: vi.fn().mockResolvedValue(undefined) };
  const dismiss = { waitFor: vi.fn().mockResolvedValue(undefined), click };
  const page = {
    getByRole: vi.fn((role: string) => (role === 'dialog' ? dialog : dismiss)),
    waitForResponse: vi.fn(() => response),
    addLocatorHandler: vi.fn().mockResolvedValue(undefined),
  };
  return { page: page as unknown as Page, dialog, dismiss };
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
});
