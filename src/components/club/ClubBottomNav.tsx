/**
 * Club Arena's authoritative global footer.
 *
 * The approved artwork is the visual source of truth. The DOM above it only
 * supplies six semantic, full-cell navigation targets; it does not redraw or
 * substitute the approved icons, labels, leather, metal, or lighting.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  fetchQuickLinkClubs,
  readCachedQuickLinkClubs,
  resolveTargetClub,
} from '../../utils/clubQuickLink';
import { clubIdFromPath } from './clubIdFromPath';
import { activeTabForPath, type TabKey } from './clubBottomNavTabs';
import { useHideFooterOnScroll } from './useHideFooterOnScroll';
import styles from './ClubBottomNav.module.css';

interface ClubBottomNavProps {
  clubId?: string;
}

interface FooterDestination {
  key: TabKey;
  label: string;
  to: string;
}

interface AccountResolvedClub {
  userId: string | null;
  clubId: string | null;
}

const APPROVED_FOOTER_ART = `${import.meta.env.BASE_URL}images/club-footer/club-arena-footer-v2.webp`;

function useResolvedClubId(explicit?: string, routeClubId?: string | null): string | null {
  const { user } = useAuthUser();
  const currentUserId = user?.id ?? null;
  const [resolved, setResolved] = useState<AccountResolvedClub>(() => ({
    userId: currentUserId,
    clubId:
      explicit ||
      routeClubId ||
      resolveTargetClub(readCachedQuickLinkClubs(currentUserId))?.id ||
      null,
  }));

  useEffect(() => {
    if (explicit || routeClubId) return;

    const fromCache = resolveTargetClub(readCachedQuickLinkClubs(currentUserId))?.id ?? null;
    if (fromCache) {
      setResolved({ userId: currentUserId, clubId: fromCache });
      return;
    }
    setResolved({ userId: currentUserId, clubId: null });
    if (!currentUserId) return;

    const requestedUserId = currentUserId;
    let cancelled = false;
    void fetchQuickLinkClubs(requestedUserId).then((clubs) => {
      if (!cancelled) {
        setResolved({ userId: requestedUserId, clubId: resolveTargetClub(clubs)?.id ?? null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentUserId, explicit, routeClubId]);

  // Effects run after paint. Scope the rendered value too, otherwise an in-app
  // account switch gives account B one frame of account A's club hrefs before
  // the effect above clears the old state.
  const sameAccountResolved = resolved.userId === currentUserId ? resolved.clubId : null;
  return explicit || routeClubId || sameAccountResolved;
}

/**
 * THE FOOTER PUBLISHES THE HEIGHT IT IS CURRENTLY OCCUPYING (Dan 2026-09-04):
 * "what I want is for the box above it to snap lock to the footer when the
 * footer disappears below it."
 *
 * Fixed bars that stack on this footer - the cashier's Claim Back / Send
 * Ticket / Send Out bar and its selection bar - sat on a CSS constant,
 * `--bottom-nav-stack-base`, the footer's DESIGNED height. useHideFooterOnScroll
 * drops the footer off the bottom edge with translateY(100%); the constant
 * did not move, so the bar hung a footer's height above the edge with rows
 * showing through the gap.
 *
 * This writes the footer's OCCUPIED height to the root as
 * `--ca-bottom-chrome-h`: its measured height while shown, 0px while hidden
 * by scroll, 0px once unmounted. A ResizeObserver keeps the measured value
 * current across viewport changes. No transition anywhere - the footer's
 * own rule is "real time instant change", and the bar that follows it
 * snaps on the same frame.
 */
export const BOTTOM_CHROME_HEIGHT_VAR = '--ca-bottom-chrome-h';

function usePublishBottomChromeHeight(ref: React.RefObject<HTMLElement | null>, hidden: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) return;
    const write = () =>
      root.style.setProperty(BOTTOM_CHROME_HEIGHT_VAR, hidden ? '0px' : `${el.offsetHeight}px`);
    write();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(write) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
    };
  }, [ref, hidden]);
  // Unmount is its own case: a route with no footer must read 0, not the
  // last value the previous route published.
  useLayoutEffect(
    () => () => document.documentElement.style.setProperty(BOTTOM_CHROME_HEIGHT_VAR, '0px'),
    []
  );
}

export default function ClubBottomNav({ clubId }: ClubBottomNavProps) {
  const location = useLocation();
  const routeClubId = useMemo(() => clubIdFromPath(location.pathname), [location.pathname]);
  const resolvedClubId = useResolvedClubId(clubId, routeClubId);
  const activeTab = useMemo(() => activeTabForPath(location.pathname), [location.pathname]);
  const { hidden, reveal } = useHideFooterOnScroll(location.pathname);
  const navRef = useRef<HTMLElement | null>(null);
  usePublishBottomChromeHeight(navRef, hidden);

  const destinations = useMemo<FooterDestination[]>(() => {
    const clubRoot = resolvedClubId ? `/clubs/${resolvedClubId}` : null;
    return [
      { key: 'profile', label: 'Settings', to: clubRoot ? `${clubRoot}/settings` : '/settings' },
      { key: 'players', label: 'Players', to: clubRoot ? `${clubRoot}/members` : '/players' },
      { key: 'cashier', label: 'Cashier', to: clubRoot ? `${clubRoot}/cashier` : '/cashier' },
      { key: 'marketplace', label: 'Market', to: '/marketplace' },
      { key: 'data', label: 'Data', to: clubRoot ? `${clubRoot}/data` : '/data' },
      { key: 'stats', label: 'Stats', to: '/stats' },
    ];
  }, [resolvedClubId]);

  return (
    <nav
      ref={navRef}
      className={styles.bottomNav}
      aria-label="Club Arena"
      data-footer-hidden={hidden ? 'true' : 'false'}
      /* Keyboard focus has no scroll direction to read, so tabbing into a
         footer that scroll has parked off-screen would move focus somewhere
         invisible. Reaching it brings it back. */
      onFocusCapture={reveal}
      style={{
        /* Its own height, straight down, and nothing else. No transition:
           "real time instant change" is the requirement, not a detail.
           See useHideFooterOnScroll. */
        transform: hidden ? 'translateY(100%)' : 'none',
      }}
    >
      <div className={styles.viewport}>
        <div className={styles.artwork}>
          <img
            className={styles.artworkImage}
            src={APPROVED_FOOTER_ART}
            alt=""
            width="1916"
            height="256"
            decoding="async"
            draggable={false}
          />
          <ul className={styles.navItems}>
            {destinations.map((destination) => (
              <li key={destination.key} className={styles.navCell}>
                <Link
                  className={styles.navItem}
                  to={destination.to}
                  aria-label={destination.label}
                  aria-current={activeTab === destination.key ? 'page' : undefined}
                  data-footer-control={destination.key}
                >
                  <span className={styles.visuallyHidden}>{destination.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </nav>
  );
}
