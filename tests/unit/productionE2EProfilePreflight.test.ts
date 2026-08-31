import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePlayableProfile } from '../e2e/support/ensurePlayableProfile';

const source = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');

function playablePage(
  options: {
    gateOpen?: boolean;
    gateReturnsAfterReload?: boolean;
    decisionUnavailable?: boolean;
  } = {}
) {
  const gateOpen = options.gateOpen ?? true;
  const gate = {
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
  const initialStatus = options.decisionUnavailable
    ? 'unavailable'
    : gateOpen
      ? 'incomplete'
      : 'complete';
  const persistedStatus = options.gateReturnsAfterReload ? 'incomplete' : 'complete';
  const decision = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi
      .fn()
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValueOnce(persistedStatus),
  };
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
    locator: vi.fn(() => decision),
    reload: vi.fn().mockResolvedValue(undefined),
  };

  return { page, gate, decision, selectAvatar, freeAvatar, apply, gallery, enterArena };
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
    expect(fixture.decision.waitFor).toHaveBeenCalledWith({
      state: 'attached',
      timeout: 60_000,
    });
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
    expect(fixture.decision.waitFor).toHaveBeenCalledTimes(2);
    expect(fixture.decision.getAttribute).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when successful-looking onboarding did not persist', async () => {
    const fixture = playablePage({ gateReturnsAfterReload: true });

    await expect(ensurePlayableProfile(fixture.page as unknown as Page)).rejects.toThrow(
      'Profile onboarding appeared again after its writes reported success.'
    );
  });

  it('fails once with the real cause when the profile query did not answer', async () => {
    const fixture = playablePage({ gateOpen: false, decisionUnavailable: true });

    await expect(ensurePlayableProfile(fixture.page as unknown as Page)).rejects.toThrow(
      'The production profile query did not answer; onboarding state is unknown.'
    );
    expect(fixture.selectAvatar.click).not.toHaveBeenCalled();
  });

  it('probes a protected layout route and exposes the server-backed decision', () => {
    expect(source('tests/e2e/global-setup.ts')).toContain("new URL('notifications', baseURL)");
    expect(source('tests/e2e/production-customization-realtime.spec.ts')).toContain(
      "new URL('notifications', baseURL)"
    );
    expect(source('tests/e2e/production-customization-commerce.spec.ts')).toContain(
      "new URL('notifications', baseURL)"
    );
    expect(source('src/components/layouts/AppLayout.tsx')).toContain(
      'data-profile-gate-status={profileStatus}'
    );
  });

  it('preflights the dedicated account through the real public club join flow', () => {
    expect(source('tests/e2e/global-setup.ts')).toContain('ensureClubMembership(');
    const helper = source('tests/e2e/support/ensureClubMembership.ts');
    expect(helper).toContain("getByRole('button', { name: 'Join Club', exact: true })");
    expect(helper).toContain("locator('.club-home')");
    expect(helper).toContain("locator('.invite-pending')");
    expect(helper).toContain("getByRole('button', { name: 'Try Again' })");
    expect(helper).toContain('CLUB_ROUTE_ATTEMPTS');
    expect(helper).toContain('Visible copy:');
  });

  it('keeps production lobby and mobile audits aligned with the shipped surfaces', () => {
    const lobby = source('tests/e2e/club-lobby.spec.ts');
    expect(lobby).toContain("if (kind === 'cash')");
    expect(lobby).toContain("locator('.arena-game-card')");
    expect(lobby).toContain('.lt-row[data-kind="cash"]');
    expect(lobby).toContain("locator('.agc-action--primary')");
    expect(lobby).toContain('test.setTimeout(75_000)');

    const mobile = source('tests/e2e/mobile-chrome-occlusion.spec.ts');
    expect(mobile).toContain("const CLUB_ARENA_PATH = '/hub/club-arena'");
    expect(mobile).toContain('routes outside Club Arena');
    expect(mobile).toContain('el.closest(\'[aria-hidden="true"]\')');
    expect(mobile).toContain("el.getAttribute('alt')");
    expect(mobile).toContain('TRANSIENT_DOCUMENT_ERROR');
    expect(mobile).toContain('attempt <= 3');
    expect(mobile).toContain('document did not stabilize after navigation');
    expect(mobile).toContain("scrollingStyle.scrollBehavior = 'auto'");
    expect(mobile).toContain('did not reach its scroll boundary');
    expect(mobile).toContain('clippedBottom <= clippedTop');
    expect(mobile).toContain('DOMRect.fromRect');
  });
});
