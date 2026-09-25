/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  /marketplace: ONE MARKETPLACE (Dan, 2026-09-21)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "CLUB ARENA MARKETPLACE, SHOULD BE THE EXACT SAME PAGES AS THE MARKETPLACE
 *  THAT EXISTS IN THE WORLD HUB."
 *
 * Every way into the Club Arena marketplace (the club footer's Market tab, the
 * hamburger, the lobby tile, every Buy Diamonds button, a bookmarked
 * /hub/club-arena/marketplace?club=...&tab=diamonds) lands on this route, and
 * on the web this route hands the player to the World Hub marketplace page
 * that shows the same thing (src/utils/hubMarketplace.ts has the map). There is
 * one storefront, and it is the Hub's.
 *
 * How it leaves is the one every World Hub destination in this app uses
 * (GlobalHeader.navigateToHub):
 *   - with a live table open, the page opens in a hub tab BESIDE the game
 *     (OPEN_HUB_TAB), because a full navigation would unmount every felt;
 *   - otherwise it is a full navigation that REPLACES this entry, so Back
 *     returns to the page the player came from, not to a page that bounces.
 *
 * The in-app storefront (`storefront`, MarketplacePage) is still rendered in
 * the native app, and on the web for the two addresses only it can finish: a
 * card checkout coming back to be verified, and a top-up that owes the player
 * a way back (?next=). See hubMarketplace.ts for why each of those must stay.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { LoadingState } from '../components/common/EmptyState';
import { masterBus } from '../core/MasterBus';
import { leaveForHub } from '../lib/openExternal';
import { useUserStore } from '../stores/useUserStore';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import {
  hubMarketplaceDestination,
  hubMarketplaceNeedsClub,
  marketplaceClubParam,
  marketplaceKeepsInAppStorefront,
  usesInAppStorefront,
} from '../utils/hubMarketplace';

/** MultiTablePage publishes its live TABLE count on <body> (GlobalHeader reads the same). */
const liveTablesOpen = (): boolean =>
  typeof document !== 'undefined' && Number(document.body?.dataset.caLiveTables ?? '0') > 0;

const onMarketplaceRoute = (): boolean =>
  typeof window !== 'undefined' && /\/marketplace\/?$/.test(window.location.pathname);

export default function MarketplaceRoute({ storefront }: { storefront: ReactNode }) {
  const [searchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const search = searchParams.toString();
  const keepsStorefront = marketplaceKeepsInAppStorefront(searchParams);
  // A verified checkout return strips its own ?purchase= / ?session_id= from
  // the address (a REPLACE) while its receipt and Continue button are still on
  // screen, so the storefront stays for that. A fresh arrival (the footer's
  // Market tab, the hamburger, Back) is the player asking for the marketplace
  // again, and that goes to the Hub like every other visit.
  const [heldByReceipt, setHeldByReceipt] = useState(keepsStorefront);
  useEffect(() => {
    if (!heldByReceipt || keepsStorefront || navigationType === 'REPLACE') return;
    setHeldByReceipt(false);
  }, [heldByReceipt, keepsStorefront, navigationType, search]);

  if (usesInAppStorefront() || keepsStorefront || heldByReceipt) return <>{storefront}</>;
  return <LeaveForHubMarketplace search={search} />;
}

function LeaveForHubMarketplace({ search }: { search: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // One hand-off per destination, so a re-render or a StrictMode double effect
  // cannot open the same page twice.
  const sentTo = useRef<string | null>(null);
  const isFirstEntry = location.key === 'default';

  useEffect(() => {
    let cancelled = false;

    const handOff = async () => {
      // ?club= may be a slug, a 6-digit club code or a UUID (clubScopedPath.ts
      // passes it through unchanged). The Hub Club Shop takes a UUID only, and
      // only the Club Shop destinations are about a club at all.
      let clubId: string | null = null;
      const rawClub = hubMarketplaceNeedsClub(search) ? marketplaceClubParam(search) : null;
      if (rawClub) {
        try {
          clubId = await resolveClubUUID(rawClub);
        } catch (error) {
          // Unresolvable is not a dead end: the marketplace still opens, and
          // the Club Shop picks the player's own club on the server.
          reportError(error, 'MarketplaceRoute.resolveClub', { rawClub });
        }
      }
      if (cancelled) return;

      const destination = hubMarketplaceDestination(search, clubId);
      if (sentTo.current === destination) return;
      sentTo.current = destination;

      if (liveTablesOpen()) {
        masterBus.emit('OPEN_HUB_TAB', {
          path: destination,
          requestedBy: useUserStore.getState().user?.id,
        });
        // MultiTablePage shows the new hub tab by REPLACING this entry with a
        // table address, synchronously inside the emit. Still being here means
        // it refused (every screen is taken, and it said so with its own
        // toast): go back to the page the player was on, or to the lobby when
        // this route is where they came in.
        if (onMarketplaceRoute()) {
          if (isFirstEntry) navigate('/', { replace: true });
          else navigate(-1);
        }
        return;
      }

      leaveForHub(destination, { replace: true });
    };

    void handOff();
    return () => {
      cancelled = true;
    };
  }, [search, navigate, isFirstEntry]);

  return <LoadingState message="Opening The Marketplace" />;
}
