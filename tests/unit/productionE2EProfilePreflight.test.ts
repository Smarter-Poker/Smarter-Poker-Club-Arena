import type { Page } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePlayableProfile } from '../e2e/support/ensurePlayableProfile';

function playablePage(options: { gateOpen?: boolean; gateReturnsAfterReload?: boolean } = {}) {
  const gateOpen = options.gateOpen ?? true;
  const gateWaitFor = vi.fn();

  if (!gateOpen) {
    gateWaitFor.mockRejectedValue(new Error('not visible'));
  } else {
    gateWaitFor
      .mockResolvedValueOnce(undefined) // initial visible gate
      .mockResolvedValueOnce(undefined); // gate hidden after Enter Arena
    if (options.gateReturnsAfterReload) {
      gateWaitFor.mockResolvedValueOnce(undefined);
    } else {
      gateWaitFor.mockRejectedValueOnce(new Error('persisted gate is absent'));
    }
  }

  const gate = { waitFor: gateWaitFor };
  const selectAvatar = { click: vi.fn().mockResolvedValue(undefined) };
  const freeAvatar = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
  };
  const apply = { click: vi.fn().mockResolvedValue(undefined) };
  const gallery = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn((selector: string) =>
      selector === 'button.ag-apply' ? apply : { first: () => freeAvatar }
    ),
  };
  const enterArena = { click: vi.fn().mockResolvedValue(undefined) };
  const page = {
    getByRole: vi.fn((role: string, locatorOptions: { name: string | RegExp }) => {
      if (role === 'heading') return gate;
      if (role === 'dialog') return gallery;
      if (locatorOptions.name === 'Enter Arena') return enterArena;
      return selectAvatar;
    }),
    reload: vi.fn().mockResolvedValue(undefined),
  };

  return { page, gate, selectAvatar, freeAvatar, apply, gallery, enterArena };
}

describe('authenticated production account preflight', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves an already complete account untouched', async () => {
    const fixture = playablePage({ gateOpen: false });

    await expect(ensurePlayableProfile(fixture.page as unknown as Page)).resolves.toBe(false);
    expect(fixture.selectAvatar.click).not.toHaveBeenCalled();
    expect(fixture.page.reload).not.toHaveBeenCalled();
  });

  it('uses the real avatar and profile controls, then proves the gate stays gone', async () => {
    const fixture = playablePage();

    await expect(ensurePlayableProfile(fixture.page as unknown as Page)).resolves.toBe(true);
    expect(fixture.selectAvatar.click).toHaveBeenCalledOnce();
    expect(fixture.freeAvatar.click).toHaveBeenCalledOnce();
    expect(fixture.apply.click).toHaveBeenCalledOnce();
    expect(fixture.enterArena.click).toHaveBeenCalledOnce();
    expect(fixture.page.reload).toHaveBeenCalledOnce();
    expect(fixture.gate.waitFor).toHaveBeenLastCalledWith({
      state: 'visible',
      timeout: 12_000,
    });
  });

  it('fails loudly when successful-looking onboarding did not persist', async () => {
    const fixture = playablePage({ gateReturnsAfterReload: true });

    await expect(ensurePlayableProfile(fixture.page as unknown as Page)).rejects.toThrow(
      'Profile onboarding appeared again after its writes reported success.'
    );
  });
});
