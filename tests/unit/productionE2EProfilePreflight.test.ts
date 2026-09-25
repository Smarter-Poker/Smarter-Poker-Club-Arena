import type { Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateAcrossDocumentReplacement } from '../e2e/support/evaluateAcrossDocumentReplacement';
import { ensureClubMembership } from '../e2e/support/ensureClubMembership';
import { ensureAcceptedTerms } from '../e2e/support/ensureAcceptedTerms';
import { ensurePlayableProfile } from '../e2e/support/ensurePlayableProfile';
import { observeSetupFailure } from '../e2e/support/setupFailureObservation';

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

  it('records the original Terms HTTP failure and script rejection without private inputs', () => {
    const page = Object.assign(new EventEmitter(), { mainFrame: () => 'main' });
    const observation = observeSetupFailure(
      page as unknown as Page,
      'https://smarter.poker/hub/club-arena/',
      'https://project.supabase.co'
    );
    observation.stage('terms');
    const request = {
      url: () =>
        'https://project.supabase.co/rest/v1/profiles?select=club_arena_tos_accepted_at&id=eq.private-account&token=private-token#private-fragment',
      resourceType: () => 'fetch',
      failure: () => ({ errorText: 'net::ERR_HTTP2_PROTOCOL_ERROR private-token' }),
    };
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 503 });
    page.emit('requestfailed', request);
    page.emit('console', {
      type: () => 'error',
      text: () => '[ProfileService.getTOSStatus] TypeError: Failed to fetch private-token',
    });
    const script = {
      url: () =>
        'https://smarter.poker/hub/club-arena/assets/ProfileService-secret.js?token=private-token',
      resourceType: () => 'script',
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
    };
    page.emit('requestfailed', script);
    page.emit('console', {
      type: () => 'error',
      text: () =>
        '[TOSGuard.status_check_failed] Failed to fetch dynamically imported module: https://private-user:private-password@example.com/private-account',
    });
    const result = observation.snapshot();
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'response',
          kind: 'terms-query',
          status: 503,
          request: 1,
        }),
        expect.objectContaining({
          event: 'requestfailed',
          kind: 'terms-query',
          errorClass: 'ERR_HTTP2_PROTOCOL_ERROR',
          request: 1,
        }),
        expect.objectContaining({
          event: 'requestfailed',
          kind: 'script',
          errorClass: 'ERR_CONNECTION_RESET',
          request: 2,
        }),
        expect.objectContaining({
          event: 'reported-error',
          kind: 'terms-query',
          errorClass: 'FetchError',
        }),
        expect.objectContaining({
          event: 'reported-error',
          kind: 'terms-status-chain',
          errorClass: 'ModuleImportError',
        }),
      ])
    );
    expect(JSON.stringify(result)).not.toMatch(/private-|secret|\?|#|id=|token=/);
    expect(result.events.every((event) => event.stage === 'terms')).toBe(true);
    observation.dispose();
  });

  it('distinguishes navigation failure from a successful Terms response and premature close', () => {
    const page = Object.assign(new EventEmitter(), { mainFrame: () => 'main' });
    const observation = observeSetupFailure(
      page as unknown as Page,
      'https://smarter.poker/hub/club-arena/',
      'https://project.supabase.co'
    );
    observation.stage('protected-navigation');
    const navigation = {
      url: () => 'https://private-account.example.test/private-id?token=secret',
      resourceType: () => 'document',
      isNavigationRequest: () => true,
      frame: () => 'main',
      failure: () => ({ errorText: 'net::ERR_SECRET_TOKEN' }),
    };
    page.emit('requestfailed', navigation);
    page.emit('framenavigated', 'main');
    observation.stage('terms');
    const terms = {
      url: () => 'https://project.supabase.co/rest/v1/profiles?select=club_arena_tos_accepted_at',
      resourceType: () => 'fetch',
    };
    page.emit('response', { request: () => terms, status: () => 200 });
    page.emit('close');
    const result = observation.snapshot();
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'requestfailed',
          stage: 'protected-navigation',
          kind: 'navigation',
          host: '[other-origin]',
          path: '/[document]',
          errorClass: 'NetworkError',
        }),
        expect.objectContaining({ event: 'response', kind: 'terms-query', status: 200 }),
        expect.objectContaining({ event: 'page-closed' }),
      ])
    );
    expect(JSON.stringify(result)).not.toMatch(/private|SECRET|secret/);
    observation.dispose();
  });

  it('ignores unrelated traffic and console data and bounds the retained failure evidence', () => {
    const page = Object.assign(new EventEmitter(), { mainFrame: () => 'main' });
    const observation = observeSetupFailure(
      page as unknown as Page,
      'https://smarter.poker/hub/club-arena/',
      'https://project.supabase.co'
    );
    page.emit('console', {
      type: () => 'error',
      text: () => 'Authorization: Bearer secret-token user@example.com',
    });
    page.emit('requestfailed', {
      url: () => 'https://project.supabase.co/auth/v1/token?access_token=secret',
      resourceType: () => 'fetch',
      isNavigationRequest: () => false,
      headers: () => {
        throw new Error('must never read headers');
      },
    });
    page.emit('pageerror', new Error('private-account private-token'));
    expect(observation.snapshot().events).toEqual([]);
    for (let index = 0; index < 70; index += 1)
      page.emit(
        'pageerror',
        new Error('Failed to fetch dynamically imported module: private-token')
      );
    expect(observation.snapshot().events).toHaveLength(64);
    expect(observation.snapshot().discarded).toBe(6);
    expect(JSON.stringify(observation.snapshot())).not.toMatch(/private|secret|Bearer/);
    observation.dispose();
    expect(page.eventNames()).toEqual([]);
    page.emit('close');
    expect(observation.snapshot().events).toHaveLength(64);
  });

  it('attaches failure observation before navigation and preserves the original failure exit', () => {
    const setup = source('tests/e2e/global-setup.ts');
    expect(setup.indexOf('observation = observeSetupFailure(')).toBeLessThan(
      setup.indexOf('await page.goto(baseURL')
    );
    expect(setup).toContain("observation.stage('terms');\n    await ensureAcceptedTerms(page)");
    const catchBlock = setup.slice(
      setup.indexOf('  } catch (err) {', setup.indexOf('export default'))
    );
    expect(catchBlock.indexOf('observation?.snapshot()')).toBeLessThan(
      catchBlock.indexOf('throw err;')
    );
    expect(catchBlock).toContain("if (process.env.E2E_REQUIRE_AUTH === '1') {\n      throw err;");
    expect(catchBlock).toContain('if (authenticated) {');
    expect(catchBlock.indexOf('observation?.dispose()')).toBeLessThan(
      catchBlock.indexOf('await browser.close()')
    );
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
    // Every fresh lobby context can take the cold read, including the first
    // shell case. A timeout inside only one test does not protect its siblings.
    expect(lobby).toMatch(
      /test\.describe\('Club lobby', \(\) => \{\s*(?:\/\*[\s\S]*?\*\/\s*)?test\.describe\.configure\(\{ timeout: 75_000 \}\);/
    );
    const settle = lobby.slice(
      lobby.indexOf('async function lobbySettled'),
      lobby.indexOf("test.describe('Club lobby'")
    );
    expect(settle).toContain("waitFor({ state: 'visible', timeout: 45000 });");
    expect(settle).not.toContain('.catch(');
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
