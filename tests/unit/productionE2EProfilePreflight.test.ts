import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateAcrossDocumentReplacement } from '../e2e/support/evaluateAcrossDocumentReplacement';
import { ensureClubMembership } from '../e2e/support/ensureClubMembership';
import { ensureAcceptedTerms } from '../e2e/support/ensureAcceptedTerms';
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

function termsPage(statuses: Array<'accepted' | 'not_accepted' | 'unknown'>, responseStatus = 200) {
  const remainingStatuses = [...statuses];
  const decision = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockImplementation(async () => remainingStatuses.shift() ?? null),
  };
  const acceptedMarker = { waitFor: vi.fn().mockResolvedValue(undefined) };
  const heading = { waitFor: vi.fn().mockResolvedValue(undefined) };
  const agreement = { check: vi.fn().mockResolvedValue(undefined) };
  const accept = { click: vi.fn().mockResolvedValue(undefined) };
  const response = {
    request: () => ({ method: () => 'POST' }),
    url: () => 'https://smarter.poker/api/club-arena/accept-tos',
    ok: () => responseStatus >= 200 && responseStatus < 300,
    status: () => responseStatus,
  };
  const page = {
    locator: vi.fn((selector: string) =>
      selector === '[data-tos-gate-status="accepted"]' ? acceptedMarker : decision
    ),
    getByRole: vi.fn((role: string) => {
      if (role === 'heading') return heading;
      if (role === 'checkbox') return agreement;
      return accept;
    }),
    waitForResponse: vi.fn(async (predicate: (candidate: typeof response) => boolean) => {
      expect(predicate(response)).toBe(true);
      return response;
    }),
    reload: vi.fn().mockResolvedValue(undefined),
  };
  return { page, decision, acceptedMarker, heading, agreement, accept };
}

describe('authenticated production account preflight', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves an account with durably accepted Terms untouched', async () => {
    const fixture = termsPage(['accepted']);

    await expect(ensureAcceptedTerms(fixture.page as unknown as Page)).resolves.toBe(false);
    expect(fixture.decision.waitFor).toHaveBeenCalledWith({
      state: 'attached',
      timeout: 60_000,
    });
    expect(fixture.agreement.check).not.toHaveBeenCalled();
    expect(fixture.page.reload).not.toHaveBeenCalled();
  });

  it('accepts Terms through the public endpoint before proving the canonical read persists', async () => {
    const fixture = termsPage(['not_accepted', 'accepted']);

    await expect(ensureAcceptedTerms(fixture.page as unknown as Page)).resolves.toBe(true);
    expect(fixture.heading.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 30_000,
    });
    expect(fixture.agreement.check).toHaveBeenCalledOnce();
    expect(fixture.page.waitForResponse).toHaveBeenCalledOnce();
    expect(fixture.accept.click).toHaveBeenCalledOnce();
    expect(fixture.acceptedMarker.waitFor).toHaveBeenCalledWith({
      state: 'attached',
      timeout: 30_000,
    });
    expect(fixture.page.reload).toHaveBeenCalledWith({
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(fixture.decision.getAttribute).toHaveBeenCalledTimes(2);
    expect(fixture.acceptedMarker.waitFor.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.page.reload.mock.invocationCallOrder[0]
    );
  });

  it('does not call a failed Terms write accepted or persist a client-only decision', async () => {
    const fixture = termsPage(['not_accepted'], 500);

    await expect(ensureAcceptedTerms(fixture.page as unknown as Page)).rejects.toThrow(
      'Terms Of Service acceptance failed in production (500).'
    );
    expect(fixture.acceptedMarker.waitFor).not.toHaveBeenCalled();
    expect(fixture.page.reload).not.toHaveBeenCalled();
  });

  it('fails loudly when the canonical Terms decision is unavailable', async () => {
    const fixture = termsPage(['unknown']);

    await expect(ensureAcceptedTerms(fixture.page as unknown as Page)).rejects.toThrow(
      'The production Terms Of Service query did not answer; acceptance is unknown.'
    );
    expect(fixture.agreement.check).not.toHaveBeenCalled();
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
    const setup = source('tests/e2e/global-setup.ts');
    expect(setup).toContain("new URL('notifications', baseURL)");
    expect(setup).toContain('ensureAcceptedTerms(page)');
    expect(setup.indexOf('ensureAcceptedTerms(page)')).toBeLessThan(
      setup.indexOf('ensurePlayableProfile(page)')
    );
    expect(setup).toContain("const AUTH_STORAGE_KEY = 'smarter-poker-auth'");
    expect(setup).toContain('client.auth.signInWithPassword({ email, password })');
    expect(setup).toContain('localStorage.setItem(authKey, JSON.stringify(session))');
    expect(source('tests/e2e/production-customization-realtime.spec.ts')).toContain(
      "new URL('notifications', baseURL)"
    );
    expect(source('tests/e2e/production-customization-commerce.spec.ts')).toContain(
      "new URL('notifications', baseURL)"
    );
    expect(source('src/components/layouts/AppLayout.tsx')).toContain(
      'data-profile-gate-status={profileStatus}'
    );
    expect(source('src/components/legal/TOSGuard.tsx')).toContain(
      "data-tos-gate-status={isHydrating || !user?.id ? 'checking' : state}"
    );
  });

  it('preflights the dedicated account through the real public club join flow', () => {
    const setup = source('tests/e2e/global-setup.ts');
    expect(setup).toContain('ensureClubMembership(');
    expect(setup).toContain('dismissClubEntryMessage(page)');
    expect(setup).toContain('/rest/v1/rpc/fn_dismiss_club_message');
    expect(setup).toContain("name: 'Do Not Show Me This Message Again'");
    const helper = source('tests/e2e/support/ensureClubMembership.ts');
    expect(helper).toContain("getByRole('button', { name: 'Join Club', exact: true })");
    expect(helper).toContain("locator('.club-home')");
    expect(helper).toContain("locator('.invite-pending')");
    expect(helper).toContain("getByRole('button', { name: 'Try Again' })");
    expect(helper).toContain("waitUntil: 'commit'");
    expect(helper).toContain('CLUB_ROUTE_ATTEMPTS');
    expect(helper).toContain('club navigation timed out; retrying');
    expect(helper).toContain('did not commit after ${CLUB_ROUTE_ATTEMPTS} attempts');
    expect(helper).toContain('POST_JOIN_DECISION_SELECTOR');
    expect(helper).toContain("textContent({ timeout: 1_000 }).catch(() => '')");
    expect(helper).not.toContain(
      'await error.textContent())?.trim() || (await workspaceError.textContent()'
    );
    expect(helper).toContain('Visible copy:');
  });

  it('retries a club navigation that never commits before trusting the route', async () => {
    const lobby = { isVisible: vi.fn().mockResolvedValue(true) };
    const hidden = { isVisible: vi.fn().mockResolvedValue(false) };
    const routeDecision = { waitFor: vi.fn().mockResolvedValue(undefined) };
    const page = {
      goto: vi
        .fn()
        .mockRejectedValueOnce(new Error('upstream reset before commit'))
        .mockResolvedValueOnce(null),
      locator: vi.fn((selector: string) => {
        if (selector === '.club-home') return lobby;
        if (selector.includes('.club-home,')) return { first: () => routeDecision };
        return hidden;
      }),
      getByRole: vi.fn((role: string) => {
        if (role === 'alert') return { filter: () => hidden };
        return hidden;
      }),
    };

    await expect(
      ensureClubMembership(
        page as unknown as Page,
        'https://smarter.poker/hub/club-arena/',
        'fixture-club'
      )
    ).resolves.toBe(false);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(routeDecision.waitFor).toHaveBeenCalledWith({
      state: 'visible',
      timeout: 60_000,
    });
  });

  it('keeps production lobby and mobile audits aligned with the shipped surfaces', () => {
    const lobby = source('tests/e2e/club-lobby.spec.ts');
    expect(lobby).toContain("if (kind === 'cash')");
    expect(lobby).toContain("locator('.arena-game-card')");
    expect(lobby).toContain('.lt-row[data-kind="cash"]');
    expect(lobby).toContain("locator('.agc-action--primary')");
    expect(lobby).toContain('test.setTimeout(75_000)');
    expect(lobby).toContain(
      "import { prepareCashLobbyActions } from './support/cashLobbyOverlays'"
    );
    expect(lobby).toMatch(
      /async function lobbySettled\(page: Page\)[\s\S]*await prepareCashLobbyActions\(page\);/
    );

    const liveMobileLobby = source('tests/e2e/production-mobile-lobby-chrome.spec.ts');
    expect(liveMobileLobby).toContain(
      "import { prepareCashLobbyActions } from './support/cashLobbyOverlays'"
    );
    expect(liveMobileLobby).toMatch(
      /async function openLobby\(page: Page\)[\s\S]*await prepareCashLobbyActions\(page\);[\s\S]*lobby-wallets-trigger/
    );

    const mobile = source('tests/e2e/mobile-chrome-occlusion.spec.ts');
    expect(mobile).toContain("const CLUB_ARENA_PATH = '/hub/club-arena'");
    expect(mobile).toContain('evaluateAcrossDocumentReplacement');
    expect(mobile).toContain('execution context was destroyed');
    expect(mobile).toContain('stableBottomSamples >= 2');
    expect(mobile).toContain('document height did not settle at its reachable bottom');
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

    const mobileFit = source('tests/e2e/mobile-fit-audit.spec.ts');
    expect(mobileFit).toContain('evaluateAcrossDocumentReplacement');
    expect(mobileFit).toContain("test.describe('Club Arena Mobile Fit At 375px'");
    expect(mobileFit).toContain('for (const route of ROUTES)');
    expect(mobileFit).toContain("test(`${route || 'home'} has no horizontal page overflow`");
    expect(mobileFit).not.toContain('test.setTimeout(ROUTES.length');
    expect(mobileFit).not.toContain('ROUTES.length * 12_000 + 120_000');
    const documentReplacement = source('tests/e2e/support/evaluateAcrossDocumentReplacement.ts');
    expect(documentReplacement).toContain('execution context was destroyed');
    expect(documentReplacement).toContain('attempt <= 3');
    expect(documentReplacement).toContain('document did not stabilize after navigation');

    const riverSqueeze = source('tests/e2e/river-squeeze-interactive.spec.ts');
    expect(riverSqueeze).toContain('settledRiver');
    expect(riverSqueeze).toContain('settledRiverFaceUp');
    expect(riverSqueeze).toContain(
      'openedBeforeUnmount || (end.gone && end.settledRiver && end.settledRiverFaceUp)'
    );
    expect(riverSqueeze).toContain('released river did not settle face up');
  });

  it('measures the destination document after an auth or role redirect', async () => {
    const destination = { scrollWidth: 375, vw: 375 };
    const page = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(new Error('Execution context was destroyed because of navigation'))
        .mockResolvedValueOnce(destination),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      evaluateAcrossDocumentReplacement(page as unknown as Page, () => destination)
    ).resolves.toEqual(destination);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');
    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
  });

  it('does not retry a real geometry or application error', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('overflow probe is invalid')),
      waitForLoadState: vi.fn(),
      waitForTimeout: vi.fn(),
    };

    await expect(
      evaluateAcrossDocumentReplacement(page as unknown as Page, () => undefined)
    ).rejects.toThrow('overflow probe is invalid');
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('fails after three replaced documents instead of passing an unmeasured route', async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockRejectedValue(new Error('Cannot find context with specified id after navigation')),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      evaluateAcrossDocumentReplacement(page as unknown as Page, () => undefined)
    ).rejects.toThrow('Club Arena document did not stabilize after navigation');
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(3);
  });
});
