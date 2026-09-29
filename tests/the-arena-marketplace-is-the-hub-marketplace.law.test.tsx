/**
 * LAW: the Club Arena marketplace is the World Hub marketplace.
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, 2026-09-21: "CLUB ARENA MARKETPLACE, SHOULD BE THE EXACT SAME PAGES AS
 * THE MARKETPLACE THAT EXISTS IN THE WORLD HUB."
 *
 * He opened /hub/club-arena/marketplace?club=a41434bb-...&tab=diamonds and
 * /hub/marketplace side by side and they were two different storefronts. This
 * law pins that every web visit to the Club Arena marketplace is handed to the
 * World Hub page that shows the same thing, that it leaves the way every other
 * Hub destination leaves (a hub tab beside a live table, else a replacing
 * navigation), and that the in-app storefront survives only where it must:
 * the native app (StoreKit / Play Billing) and a card checkout returning to be
 * verified.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  native: false,
  leaveForHub: vi.fn(),
  emit: vi.fn(),
  resolveClubUUID: vi.fn(async (value: string) => value),
  reportError: vi.fn(),
}));

vi.mock('../src/lib/appBase', () => ({
  IS_NATIVE_BUILD: false,
  isNativePlatform: () => fixture.native,
}));
vi.mock('../src/lib/openExternal', () => ({
  leaveForHub: fixture.leaveForHub,
  openInBrowser: vi.fn(),
}));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: fixture.emit } }));
vi.mock('../src/utils/clubIdResolver', () => ({ resolveClubUUID: fixture.resolveClubUUID }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: fixture.reportError }));
vi.mock('../src/stores/useUserStore', () => ({
  useUserStore: { getState: () => ({ user: { id: 'player-1' } }) },
}));

import MarketplaceRoute from '../src/pages/MarketplaceRoute';
import {
  HUB_MARKETPLACE_PATHS,
  hubMarketplaceDestination,
  hubMarketplaceNeedsClub,
  isMarketplaceCheckoutReturn,
  marketplaceClubParam,
  marketplaceContinuationPath,
  marketplaceKeepsInAppStorefront,
} from '../src/utils/hubMarketplace';
import { isHubPath } from '../src/utils/hubTab';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The exact club in the address Dan reported. */
const DAN_CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

function Storefront() {
  return <div data-testid="in-app-storefront">In-App Storefront</div>;
}

/** Prints where the router is, so a test can see a Back step happen. */
function Where() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

/** Lets a test move the router the way the storefront itself would. */
let routerNavigate: ReturnType<typeof useNavigate> | null = null;
function NavigateHandle() {
  routerNavigate = useNavigate();
  return null;
}

function renderMarketplace(entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <NavigateHandle />
      <Where />
      <Routes>
        <Route path="/marketplace" element={<MarketplaceRoute storefront={<Storefront />} />} />
        <Route path="*" element={<div data-testid="elsewhere">Elsewhere</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  fixture.native = false;
  fixture.leaveForHub.mockReset();
  fixture.emit.mockReset();
  fixture.reportError.mockReset();
  fixture.resolveClubUUID.mockReset();
  fixture.resolveClubUUID.mockImplementation(async (value: string) => value);
  routerNavigate = null;
  delete document.body.dataset.caLiveTables;
  window.history.replaceState(null, '', '/hub/club-arena/marketplace');
});

afterEach(() => {
  cleanup();
  delete document.body.dataset.caLiveTables;
});

describe('every Club Arena marketplace address maps to the World Hub page that shows it', () => {
  it("sends the address Dan reported to the Hub's Diamonds page", () => {
    expect(hubMarketplaceDestination(`?club=${DAN_CLUB}&tab=diamonds`)).toBe('/hub/diamond-store');
  });

  it('sends Membership to the Hub VIP page, keeping only a plan the Hub knows', () => {
    expect(hubMarketplaceDestination('?tab=membership')).toBe('/hub/vip-membership');
    expect(hubMarketplaceDestination('?tab=membership&plan=vip-yearly')).toBe(
      '/hub/vip-membership?plan=vip-yearly'
    );
    expect(hubMarketplaceDestination('?tab=membership&plan=free-diamonds')).toBe(
      '/hub/vip-membership'
    );
  });

  it.each([
    ['store', ''],
    ['my_items', '&view=my-purchases'],
    ['manage', '&view=manage'],
  ])('sends the %s view of a club shop to that view of the Hub Club Shop', (tab, view) => {
    expect(hubMarketplaceDestination(`?club=${DAN_CLUB}&tab=${tab}`)).toBe(
      `/hub/club-shop?clubId=${DAN_CLUB}${view}`
    );
    expect(hubMarketplaceDestination(`?tab=${tab}`)).toBe(
      view ? `/hub/club-shop?${view.slice(1)}` : '/hub/club-shop'
    );
  });

  it('asks for the club only where the destination is about one', () => {
    expect(hubMarketplaceNeedsClub('?tab=diamonds')).toBe(false);
    expect(hubMarketplaceNeedsClub('?tab=membership')).toBe(false);
    expect(hubMarketplaceNeedsClub('?tab=store')).toBe(true);
    expect(hubMarketplaceNeedsClub('?tab=manage')).toBe(true);
    expect(hubMarketplaceNeedsClub('')).toBe(true);
  });

  it('opens on the club shop inside a club, and on the marketplace itself outside one', () => {
    expect(hubMarketplaceDestination(`?club=${DAN_CLUB}`)).toBe(
      `/hub/club-shop?clubId=${DAN_CLUB}`
    );
    expect(hubMarketplaceDestination('')).toBe('/hub/diamond-store');
    expect(hubMarketplaceDestination(null)).toBe('/hub/diamond-store');
    expect(hubMarketplaceDestination('?tab=no-such-tab')).toBe('/hub/diamond-store');
  });

  it('accepts the older ?clubId= spelling and never hands the Hub a club that is not a UUID', () => {
    expect(marketplaceClubParam(`?clubId=${DAN_CLUB}`)).toBe(DAN_CLUB);
    expect(hubMarketplaceDestination(`?clubId=${DAN_CLUB.toUpperCase()}&tab=store`)).toBe(
      `/hub/club-shop?clubId=${DAN_CLUB}`
    );
    // A slug the caller could not resolve is dropped, not forwarded to a page
    // whose API refuses anything but a UUID.
    expect(hubMarketplaceDestination('?club=deep-stack-society&tab=store')).toBe('/hub/club-shop');
    expect(hubMarketplaceDestination('?club=deep-stack-society&tab=store', null)).toBe(
      '/hub/club-shop'
    );
    // A club resolved by the caller wins over the raw parameter.
    expect(hubMarketplaceDestination('?club=deep-stack-society&tab=store', DAN_CLUB)).toBe(
      `/hub/club-shop?clubId=${DAN_CLUB}`
    );
  });

  it('only ever names World Hub pages a hub tab will open', () => {
    const destinations = [
      '?tab=diamonds',
      '?tab=membership&plan=vip-lifetime',
      `?tab=store&club=${DAN_CLUB}`,
      '?tab=manage',
      '',
    ].map((search) => hubMarketplaceDestination(search));
    for (const destination of destinations) {
      expect(isHubPath(destination), destination).toBe(true);
      expect(destination.startsWith('/hub/club-arena')).toBe(false);
    }
    expect(Object.values(HUB_MARKETPLACE_PATHS)).toEqual([
      '/hub/diamond-store',
      '/hub/vip-membership',
      '/hub/club-shop',
    ]);
  });

  it('recognises a card checkout coming back to be verified', () => {
    expect(isMarketplaceCheckoutReturn('?purchase=success&session_id=cs_test_abc123')).toBe(true);
    expect(isMarketplaceCheckoutReturn('?purchase=canceled&checkout_request_id=x')).toBe(true);
    expect(isMarketplaceCheckoutReturn('?checkout_request_id=x')).toBe(true);
    expect(isMarketplaceCheckoutReturn(`?club=${DAN_CLUB}&tab=diamonds`)).toBe(false);
    expect(isMarketplaceCheckoutReturn('')).toBe(false);
  });

  it('recognises a top-up that owes the player a way back, and validates it', () => {
    expect(marketplaceContinuationPath('?tab=diamonds&next=%2Fclubs%2Fdiamond-arena')).toBe(
      '/clubs/diamond-arena'
    );
    // The sign-in redirect's validator: no other origin, no protocol-relative
    // address, and never a loop back through /auth.
    expect(marketplaceContinuationPath('?next=https%3A%2F%2Fevil.example%2Fx')).toBeNull();
    expect(marketplaceContinuationPath('?next=%2F%2Fevil.example')).toBeNull();
    expect(marketplaceContinuationPath('?next=%2Fauth')).toBeNull();
    expect(marketplaceContinuationPath('?tab=diamonds')).toBeNull();
  });

  it('keeps only the two addresses the in-app storefront alone can finish', () => {
    expect(marketplaceKeepsInAppStorefront('?purchase=success&session_id=cs_test_abc')).toBe(true);
    expect(marketplaceKeepsInAppStorefront('?tab=diamonds&next=%2Fclubs%2Fdiamond-arena')).toBe(
      true
    );
    expect(marketplaceKeepsInAppStorefront(`?club=${DAN_CLUB}&tab=diamonds`)).toBe(false);
    expect(marketplaceKeepsInAppStorefront('?tab=manage')).toBe(false);
  });
});

describe('the /marketplace route hands the web to the World Hub marketplace', () => {
  it('replaces itself with the Hub Diamonds page for the address Dan reported', async () => {
    renderMarketplace([`/marketplace?club=${DAN_CLUB}&tab=diamonds`]);

    await waitFor(() =>
      expect(fixture.leaveForHub).toHaveBeenCalledWith('/hub/diamond-store', { replace: true })
    );
    expect(fixture.leaveForHub).toHaveBeenCalledTimes(1);
    expect(fixture.emit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('in-app-storefront')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Opening The Marketplace');
  });

  it('never spends a club lookup on a page that is not about a club', async () => {
    renderMarketplace(['/marketplace?club=shark-club&tab=diamonds']);

    await waitFor(() =>
      expect(fixture.leaveForHub).toHaveBeenCalledWith('/hub/diamond-store', { replace: true })
    );
    expect(fixture.resolveClubUUID).not.toHaveBeenCalled();
  });

  it('resolves a club slug before opening that club in the Hub Club Shop', async () => {
    fixture.resolveClubUUID.mockImplementation(async (value: string) =>
      value === 'shark-club' ? DAN_CLUB : value
    );
    renderMarketplace(['/marketplace?club=shark-club']);

    await waitFor(() =>
      expect(fixture.leaveForHub).toHaveBeenCalledWith(`/hub/club-shop?clubId=${DAN_CLUB}`, {
        replace: true,
      })
    );
    expect(fixture.resolveClubUUID).toHaveBeenCalledWith('shark-club');
  });

  it('still opens the marketplace when the club cannot be resolved', async () => {
    fixture.resolveClubUUID.mockRejectedValue(new Error('network down'));
    renderMarketplace(['/marketplace?club=shark-club&tab=store']);

    await waitFor(() =>
      expect(fixture.leaveForHub).toHaveBeenCalledWith('/hub/club-shop', { replace: true })
    );
    expect(fixture.reportError).toHaveBeenCalledTimes(1);
  });

  it('opens the Hub page in a hub tab beside a live table instead of unmounting it', async () => {
    document.body.dataset.caLiveTables = '2';
    // MultiTablePage reveals the new hub tab by replacing this entry with a
    // table address, synchronously inside the emit.
    fixture.emit.mockImplementation(() => {
      window.history.replaceState(null, '', '/hub/club-arena/table/table-1');
    });
    renderMarketplace(['/lobby', '/marketplace?tab=membership']);

    await waitFor(() =>
      expect(fixture.emit).toHaveBeenCalledWith('OPEN_HUB_TAB', {
        path: '/hub/vip-membership',
        requestedBy: 'player-1',
      })
    );
    expect(fixture.leaveForHub).not.toHaveBeenCalled();
    // The container took over; this route does not step back as well.
    expect(screen.getByTestId('where').textContent).toBe('/marketplace?tab=membership');
  });

  it('steps back to where the player was when every screen is already taken', async () => {
    document.body.dataset.caLiveTables = '4';
    // The container refuses (it raises its own "close one first" toast) and
    // leaves the address alone.
    fixture.emit.mockImplementation(() => undefined);
    renderMarketplace(['/lobby', '/marketplace?tab=diamonds']);

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/lobby'));
    expect(fixture.emit).toHaveBeenCalledTimes(1);
    expect(fixture.leaveForHub).not.toHaveBeenCalled();
  });

  it('goes to the lobby, never nowhere, when the refusal lands on the first page of the visit', async () => {
    document.body.dataset.caLiveTables = '4';
    fixture.emit.mockImplementation(() => undefined);
    // One entry: a shared link or a reload, with nothing behind it to step to.
    renderMarketplace(['/marketplace?tab=diamonds']);

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    expect(fixture.leaveForHub).not.toHaveBeenCalled();
  });

  it('keeps the in-app storefront in the native app, where the stores must sell', async () => {
    fixture.native = true;
    renderMarketplace([`/marketplace?club=${DAN_CLUB}&tab=diamonds`]);

    expect(screen.getByTestId('in-app-storefront')).toBeTruthy();
    await Promise.resolve();
    expect(fixture.leaveForHub).not.toHaveBeenCalled();
    expect(fixture.emit).not.toHaveBeenCalled();
  });

  it('keeps a returning card checkout on the storefront that verifies it, even after the return is cleared', async () => {
    renderMarketplace([
      '/marketplace?tab=diamonds&purchase=success&session_id=cs_test_abc123&checkout_request_id=5b2c6f7e-8d9a-4b1c-9e2f-3a4b5c6d7e8f',
    ]);
    expect(screen.getByTestId('in-app-storefront')).toBeTruthy();

    // The storefront strips its transport parameters once the receipt is
    // verified (a REPLACE). The receipt and its Continue button are still on
    // screen, so the route must not hand the player to the Hub underneath it.
    routerNavigate!('/marketplace?tab=diamonds', { replace: true });
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/marketplace?tab=diamonds')
    );
    expect(screen.getByTestId('in-app-storefront')).toBeTruthy();
    expect(fixture.leaveForHub).not.toHaveBeenCalled();
  });

  it('lets the receipt go the moment the player asks for the marketplace again', async () => {
    renderMarketplace([
      '/marketplace?purchase=success&session_id=cs_test_abc123&checkout_request_id=5b2c6f7e-8d9a-4b1c-9e2f-3a4b5c6d7e8f',
    ]);
    expect(screen.getByTestId('in-app-storefront')).toBeTruthy();
    routerNavigate!('/marketplace', { replace: true });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/marketplace'));
    expect(screen.getByTestId('in-app-storefront')).toBeTruthy();

    // The club footer's Market tab, the hamburger, the lobby tile: a PUSH, not
    // the storefront tidying its own address. One storefront, and it is the
    // Hub's.
    routerNavigate!(`/marketplace?club=${DAN_CLUB}`);
    await waitFor(() =>
      expect(fixture.leaveForHub).toHaveBeenCalledWith(`/hub/club-shop?clubId=${DAN_CLUB}`, {
        replace: true,
      })
    );
    expect(screen.queryByTestId('in-app-storefront')).toBeNull();
  });

  it('keeps the storefront for a top-up that owes the player a way back', async () => {
    // The wallet sends a player who is short of the cheapest Diamond Arena
    // seat here; only this page carries that continuation through checkout.
    renderMarketplace(['/marketplace?tab=diamonds&next=%2Fclubs%2Fdiamond-arena']);

    expect(screen.getByTestId('in-app-storefront')).toBeTruthy();
    await Promise.resolve();
    expect(fixture.leaveForHub).not.toHaveBeenCalled();
    expect(fixture.emit).not.toHaveBeenCalled();
  });

  it('is not fooled into the old storefront by a ?next= that goes nowhere', async () => {
    renderMarketplace(['/marketplace?tab=diamonds&next=https%3A%2F%2Fevil.example']);

    await waitFor(() =>
      expect(fixture.leaveForHub).toHaveBeenCalledWith('/hub/diamond-store', { replace: true })
    );
    expect(screen.queryByTestId('in-app-storefront')).toBeNull();
  });
});

describe('the wiring that makes it true for every entry point', () => {
  it('routes /marketplace through MarketplaceRoute, with the guarded storefront behind it', () => {
    const app = read('src/App.tsx');
    const route = app.match(/<Route\s+path="marketplace"[\s\S]*?\/>\s*\n\s*<Route/);
    expect(route, 'the /marketplace route must exist').toBeTruthy();
    expect(route![0]).toContain('<MarketplaceRoute');
    // The guard belongs on the storefront: the Hub marketplace reads signed
    // out, and a shared link must reach it rather than a Club Arena login.
    expect(route![0].replace(/\s+/g, ' ')).toContain(
      'storefront={ <AuthGuard> <MarketplacePage /> </AuthGuard> }'
    );
    expect(app).toContain("lazyWithRetry(() => import('./pages/MarketplaceRoute'))");
  });

  it('warms the route, and the storefront only where the app still renders it', () => {
    const preloader = read('src/utils/ChunkPreloader.ts');
    expect(preloader).toContain("return import('../pages/MarketplaceRoute');");
    expect(preloader).toContain(
      "if (IS_NATIVE_BUILD) void import('../pages/MarketplacePage').catch(() => {});"
    );
  });

  it("opens that table's club shop from the felt, at the address the Hub actually serves", () => {
    const table = read('src/pages/TablePage.tsx');
    expect(table).toContain("import { hubMarketplaceDestination } from '../utils/hubMarketplace';");
    expect(table).toContain("path: hubMarketplaceDestination('', actualClubIdRef.current),");
    // /hub/marketplace is a 308 to /hub/diamond-store, so a hub tab opened on
    // it no longer matches its own address and the next press opens a second.
    expect(table).not.toContain("path: '/hub/marketplace'");
  });

  it('leaves the way every other World Hub destination leaves', () => {
    const route = read('src/pages/MarketplaceRoute.tsx');
    expect(route).toContain("masterBus.emit('OPEN_HUB_TAB'");
    expect(route).toContain('leaveForHub(destination, { replace: true })');
    expect(route).toContain('dataset.caLiveTables');
    // No second iframe: CLAUDE.md 1.3 allows exactly one, HubFrame.tsx.
    expect(route).not.toMatch(/<iframe/i);
  });
});
