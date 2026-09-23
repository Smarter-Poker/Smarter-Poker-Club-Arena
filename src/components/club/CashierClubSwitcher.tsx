/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER CLUB SWITCHER — flip between club cashiers without leaving the page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact context bar at the top of CashierPage: shows which club's cashier
 * is open, and for multi-club users a dropdown to jump straight to another
 * club's cashier, with each club's own chip balance alongside it.
 *
 * Club list resolution:
 *   1. the lobby's CLUBS_CACHE (no network) — re-read whenever the dropdown
 *      opens so a join/leave in this session is picked up
 *   2. on a cold cache (deep link straight into a cashier), the user's
 *      memberships are fetched once
 *   3. with a single club it degrades to a static name chip; with nothing
 *      resolvable at all it renders nothing
 *
 * Unions are excluded everywhere — they are club_members rows too, but a
 * union is not a club cashier destination.
 *
 * LAST_CLUB is updated by LastClubTracker on route change, so selections here
 * automatically become the lobby quick-link target too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import haptic from '../../services/HapticService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import {
  eligibleQuickLinkClubs,
  clubParamToUuid,
  fetchClubChipBalances,
  clearClubChipBalanceCache,
  fetchQuickLinkClubs,
  readCachedQuickLinkClubs,
  rememberLastClub,
  CHIP_BALANCE_EVENTS,
  type QuickLinkClub,
} from '../../utils/clubQuickLink';
import styles from './CashierClubSwitcher.module.css';

interface CashierClubSwitcherProps {
  /** Route club identifier — UUID or 6-digit numeric club code. */
  clubId: string;
  /** Resolved display name from the page (fallback when the cache is cold). */
  clubName?: string;
}

export default function CashierClubSwitcher({ clubId, clubName }: CashierClubSwitcherProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [balances, setBalances] = useState<Map<string, number> | null>(null);
  const [balanceOwnerId, setBalanceOwnerId] = useState<string | null>(null);
  const [balanceNonce, setBalanceNonce] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setMenuOpen(false);
    setBalances(null);
    setBalanceOwnerId(null);
  }, [user?.id]);

  // Cached list, re-read on demand (cacheNonce) so a join/leave lands
  const [cacheNonce, setCacheNonce] = useState(0);
  const cachedClubs = useMemo(() => readCachedQuickLinkClubs(user?.id), [cacheNonce, user?.id]);
  const [fetchedClubs, setFetchedClubs] = useState<QuickLinkClub[] | null>(null);
  const [fetchedForUserId, setFetchedForUserId] = useState<string | null>(null);
  const sameUserFetchedClubs = fetchedForUserId === user?.id ? fetchedClubs : null;
  const clubs = useMemo(
    () =>
      eligibleQuickLinkClubs(cachedClubs.length > 0 ? cachedClubs : (sameUserFetchedClubs ?? [])),
    [cachedClubs, sameUserFetchedClubs]
  );

  // Cold-cache fallback — a deep link straight into the cashier means the
  // lobby never populated CLUBS_CACHE; fetch memberships so switching works
  useEffect(() => {
    if (cachedClubs.length > 0 || sameUserFetchedClubs !== null || !user?.id) return;
    const requestedUserId = user.id;
    let live = true;
    fetchQuickLinkClubs(requestedUserId).then((list) => {
      if (live) {
        setFetchedForUserId(requestedUserId);
        setFetchedClubs(list);
      }
    });
    return () => {
      live = false;
    };
  }, [cachedClubs.length, sameUserFetchedClubs, user?.id]);

  // Per-club chip balances — lazy-loaded when the dropdown opens
  useEffect(() => {
    if (!menuOpen) return;
    if (!user?.id) {
      setBalances(null);
      setBalanceOwnerId(null);
      return;
    }
    const requestedUserId = user.id;
    setBalances(null);
    setBalanceOwnerId(requestedUserId);
    let live = true;
    fetchClubChipBalances(requestedUserId).then((b) => {
      if (live) {
        setBalanceOwnerId(requestedUserId);
        setBalances(b);
      }
    });
    return () => {
      live = false;
    };
  }, [menuOpen, user?.id, balanceNonce]);

  // Chip movements (this page is where they happen) invalidate the memo
  useMasterBusSubscriptions([...CHIP_BALANCE_EVENTS], () => {
    clearClubChipBalanceCache();
    setBalanceNonce((n) => n + 1);
  });

  const currentUuid = useMemo(() => clubParamToUuid(clubId, user?.id), [clubId, user?.id]);
  const currentClub = useMemo(
    () => clubs.find((c) => c.id === currentUuid || String(c.club_id) === clubId) || null,
    [clubs, currentUuid, clubId]
  );

  const displayName = currentClub?.name || clubName || '';
  const hasSwitch = clubs.length > 1;
  const visibleBalances = balanceOwnerId === user?.id ? balances : null;

  // LastClubTracker can only resolve a UUID route param (or a numeric code
  // already present in the cache). Once this page has resolved the club for
  // real, record it — that closes the gap for a deep link that arrives with a
  // numeric club code on a cold cache.
  useEffect(() => {
    if (currentClub?.id) rememberLastClub(currentClub.id);
  }, [currentClub?.id]);

  const openMenu = useCallback(() => {
    setCacheNonce((n) => n + 1); // re-read CLUBS_CACHE on open
    const selected = currentClub ? clubs.findIndex((c) => c.id === currentClub.id) : 0;
    setActiveIndex(selected >= 0 ? selected : 0);
    setMenuOpen(true);
  }, [clubs, currentClub]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (menuOpen) itemRefs.current[activeIndex]?.focus();
  }, [menuOpen, activeIndex]);

  const handleSelect = useCallback(
    (club: QuickLinkClub) => {
      closeMenu(false);
      if (club.id === currentClub?.id) return;
      haptic.light();
      navigate(`/clubs/${club.slug || club.id}/cashier`);
    },
    [closeMenu, currentClub, navigate]
  );

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % clubs.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + clubs.length) % clubs.length);
          break;
        case 'Home':
          e.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setActiveIndex(clubs.length - 1);
          break;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          closeMenu(true);
          break;
        case 'Tab':
          closeMenu(false);
          break;
        default:
          break;
      }
    },
    [clubs.length, closeMenu]
  );

  // Drop refs for rows that no longer exist
  itemRefs.current.length = clubs.length;

  // Nothing useful to show: no name resolved and nothing to switch to
  if (!displayName && !hasSwitch) return null;

  /* A club's own logo when it has one. When it has none there is nothing
     here: the name is printed right beside it, and an initial in a tile is a
     placeholder box the master does not contain. */
  const logo = (club: QuickLinkClub | null) =>
    club?.logo_url ? (
      <img src={club.logo_url} alt="" className={styles.logo} loading="lazy" />
    ) : null;

  return (
    <div className={styles.bar}>
      <span className={styles.label}>Cashier</span>
      {hasSwitch ? (
        <button
          ref={triggerRef}
          className={styles.trigger}
          onClick={() => {
            haptic.light();
            if (menuOpen) closeMenu(false);
            else openMenu();
          }}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={`Switch Club Cashier. Current Club: ${displayName || 'Unknown'}`}
          title={displayName || undefined}
        >
          {logo(currentClub)}
          <span className={styles.name}>{displayName || 'Select Club'}</span>
          <span className={styles.choose} aria-hidden="true">
            Choose
          </span>
        </button>
      ) : (
        <span
          className={`${styles.trigger} ${styles.triggerStatic}`}
          title={displayName || undefined}
        >
          {logo(currentClub)}
          <span className={styles.name}>{displayName}</span>
        </span>
      )}

      {menuOpen && (
        <>
          <div className={styles.overlay} onClick={() => closeMenu(false)} />
          <div
            className={styles.menu}
            role="menu"
            aria-label="Open Cashier For Club"
            onKeyDown={handleMenuKeyDown}
          >
            <div className={styles.menuTitle}>Open Cashier For</div>
            {clubs.map((club, idx) => (
              <button
                key={club.id}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                role="menuitem"
                tabIndex={idx === activeIndex ? 0 : -1}
                className={`${styles.item} ${club.id === currentClub?.id ? styles.itemActive : ''}`}
                title={club.name || undefined}
                onClick={() => handleSelect(club)}
              >
                {logo(club)}
                <span className={styles.itemText}>
                  <span className={styles.itemName}>{club.name || 'Unnamed Club'}</span>
                  {visibleBalances?.has(club.id) && (
                    <span className={styles.itemBalance}>
                      {(visibleBalances.get(club.id) as number).toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}{' '}
                      Chips
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
