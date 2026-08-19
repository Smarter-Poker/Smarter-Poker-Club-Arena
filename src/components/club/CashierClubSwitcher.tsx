/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER CLUB SWITCHER — flip between club cashiers without leaving the page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact context bar at the top of CashierPage: shows which club's cashier
 * is open, and for multi-club users a dropdown to jump straight to another
 * club's cashier. Club list comes from the lobby's CLUBS_CACHE (no network);
 * with a cold cache or a single club it degrades to a static name chip, and
 * with no cached clubs at all it renders nothing.
 *
 * LAST_CLUB is updated by LastClubTracker on route change, so selections here
 * automatically become the lobby quick-link target too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import haptic from '../../services/HapticService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { STORAGE_KEYS } from '../../lib/storage';
import {
  eligibleQuickLinkClubs,
  clubParamToUuid,
  fetchClubChipBalances,
  fetchQuickLinkClubs,
  type QuickLinkClub,
} from '../../utils/clubQuickLink';
import styles from './CashierClubSwitcher.module.css';

interface CashierClubSwitcherProps {
  /** Route club identifier — UUID or 6-digit numeric club code. */
  clubId: string;
  /** Resolved display name from the page (fallback when the cache is cold). */
  clubName?: string;
}

function readCachedClubs(): QuickLinkClub[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? eligibleQuickLinkClubs(parsed) : [];
  } catch {
    return [];
  }
}

export default function CashierClubSwitcher({ clubId, clubName }: CashierClubSwitcherProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [balances, setBalances] = useState<Map<string, number> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const cachedClubs = useMemo(() => readCachedClubs(), []);
  const [fetchedClubs, setFetchedClubs] = useState<QuickLinkClub[] | null>(null);
  const clubs = fetchedClubs ?? cachedClubs;

  // Cold-cache fallback — a deep link straight into the cashier means the
  // lobby never populated CLUBS_CACHE; fetch memberships so switching works
  useEffect(() => {
    if (cachedClubs.length > 0 || !user?.id) return;
    let live = true;
    fetchQuickLinkClubs(user.id).then((list) => {
      if (live && list.length > 0) setFetchedClubs(list);
    });
    return () => {
      live = false;
    };
  }, [cachedClubs.length, user?.id]);

  // Per-club chip balances — lazy-loaded when the dropdown opens
  useEffect(() => {
    if (!menuOpen || !user?.id) return;
    let live = true;
    fetchClubChipBalances(user.id).then((b) => {
      if (live) setBalances(b);
    });
    return () => {
      live = false;
    };
  }, [menuOpen, user?.id]);
  const currentUuid = useMemo(() => clubParamToUuid(clubId), [clubId]);
  const currentClub = useMemo(
    () => clubs.find((c) => c.id === currentUuid || String(c.club_id) === clubId) || null,
    [clubs, currentUuid, clubId]
  );

  const displayName = currentClub?.name || clubName || '';
  const hasSwitch = clubs.length > 1;

  const openMenu = useCallback(() => {
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
      navigate(`/clubs/${club.id}/cashier`);
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

  // Nothing useful to show: no name resolved and nothing to switch to
  if (!displayName && !hasSwitch) return null;

  const logo = (club: QuickLinkClub | null, name: string) =>
    club?.logo_url ? (
      <img src={club.logo_url} alt="" className={styles.logo} loading="lazy" />
    ) : (
      <span className={styles.logoFallback} aria-hidden="true">
        {(name || '?').charAt(0).toUpperCase()}
      </span>
    );

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
          aria-label={`Switch club cashier. Current club: ${displayName || 'unknown'}`}
          title={displayName || undefined}
        >
          {logo(currentClub, displayName)}
          <span className={styles.name}>{displayName || 'Select club'}</span>
          <span className={styles.chevron} aria-hidden="true">
            {'▾'}
          </span>
        </button>
      ) : (
        <span
          className={`${styles.trigger} ${styles.triggerStatic}`}
          title={displayName || undefined}
        >
          {logo(currentClub, displayName)}
          <span className={styles.name}>{displayName}</span>
        </span>
      )}

      {menuOpen && (
        <>
          <div className={styles.overlay} onClick={() => closeMenu(false)} />
          <div
            className={styles.menu}
            role="menu"
            aria-label="Open cashier for club"
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
                {logo(club, club.name || '')}
                <span className={styles.itemText}>
                  <span className={styles.itemName}>{club.name || 'Unnamed Club'}</span>
                  {balances?.has(club.id) && (
                    <span className={styles.itemBalance}>
                      {(balances.get(club.id) as number).toLocaleString()} chips
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
