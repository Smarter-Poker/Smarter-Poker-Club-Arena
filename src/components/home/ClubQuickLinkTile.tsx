/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB QUICK LINK TILE — lobby tile that deep-links into a specific club
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Used by the Cashier and Marketplace bottom-row tiles. The target club's
 * name is carried by the tile's aria-label and title (the v8 tile art owns
 * the full visual). Multi-club users open a quick-switch popover with club
 * logos, per-club chip balances, keyboard navigation, and managed focus.
 *
 * Tap tile           -> onSelect(targetClub), or onEmpty() with no clubs
 * Hold / right-click -> popover: ArrowUp/Down/Home/End navigate, Enter/Space
 *                       select, Escape closes and returns focus to the tile
 *
 * Chips are per club (club_members.chip_balance) — the popover shows the
 * balance for each club so the user can see where their chips are before
 * jumping. Balances refresh whenever the bus reports a chip movement.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import haptic from '../../services/HapticService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { preloadRoute } from '../../utils/ChunkPreloader';
import type { LobbyTile } from '../../config/lobbyTiles.config';
import {
  fetchClubChipBalances,
  clearClubChipBalanceCache,
  CHIP_BALANCE_EVENTS,
  isUnionEntity,
  type QuickLinkClub,
} from '../../utils/clubQuickLink';
import styles from '../../pages/HomePage.module.css';

const LONG_PRESS_MS = 500;

interface ClubQuickLinkTileProps<T extends QuickLinkClub> {
  tile: LobbyTile;
  /** Eligible wallet entities. Cashier may include an owner-only union. */
  clubs: T[];
  /** Club the tile opens on tap; null when the user has no eligible clubs. */
  targetClub: T | null;
  /** Popover heading, e.g. "Open Cashier For". */
  menuTitle: string;
  /** Navigate to the destination for this club. */
  onSelect: (club: T) => void;
  /** Tap behavior when the user has no eligible clubs. */
  onEmpty: () => void;
  /** Optional ChunkPreloader route to warm on hover/press (e.g. '/cashier'). */
  preloadPath?: string;
}

export default function ClubQuickLinkTile<T extends QuickLinkClub>({
  tile,
  clubs,
  targetClub,
  menuTitle,
  onSelect,
  onEmpty,
  preloadPath,
}: ClubQuickLinkTileProps<T>) {
  const { user } = useAuthUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [balances, setBalances] = useState<Map<string, number> | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState(false);
  const [balanceNonce, setBalanceNonce] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const preloaded = useRef(false);

  // The gesture is a wallet directory, not merely a multi-club switcher. Keep
  // it available for one eligible wallet too so every permitted role can use
  // the exact right-click / hold interaction the Cashier tile advertises.
  const hasSwitch = clubs.length > 0;
  const hasClubWallet = clubs.some((club) => !isUnionEntity(club));

  // Warm the destination chunk the first time the user shows intent
  const handlePreload = useCallback(() => {
    if (preloaded.current || !preloadPath) return;
    preloaded.current = true;
    preloadRoute(preloadPath);
  }, [preloadPath]);

  // Per-club chip balances — lazy-loaded when the popover opens, and re-read
  // when a chip movement invalidates the memo while the popover is open
  useEffect(() => {
    if (!menuOpen || !user?.id) return;
    // An owner may legitimately have a union-only directory. Union treasury
    // balances are rendered by the union wallet itself, so do not issue an
    // unrelated club_members read (or show a false balance failure) here.
    if (!hasClubWallet) {
      setBalances(new Map());
      setBalancesLoading(false);
      setBalancesError(false);
      return;
    }
    let live = true;
    setBalancesLoading(true);
    setBalancesError(false);
    void fetchClubChipBalances(user.id)
      .then((b) => {
        if (!live) return;
        setBalances(b);
        setBalancesError(b === null);
      })
      .catch(() => {
        if (live) setBalancesError(true);
      })
      .finally(() => {
        if (live) setBalancesLoading(false);
      });
    return () => {
      live = false;
    };
  }, [menuOpen, user?.id, balanceNonce, hasClubWallet]);

  // Any chip movement invalidates the 30s memo so the next open is accurate
  useMasterBusSubscriptions([...CHIP_BALANCE_EVENTS], () => {
    clearClubChipBalanceCache();
    setBalanceNonce((n) => n + 1);
  });

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Never leave a pending long-press timer behind on unmount
  useEffect(() => clearLongPress, [clearLongPress]);

  const openMenu = useCallback(() => {
    const selected = targetClub ? clubs.findIndex((c) => c.id === targetClub.id) : 0;
    setActiveIndex(selected >= 0 ? selected : 0);
    setMenuOpen(true);
  }, [clubs, targetClub]);

  const retryBalances = useCallback(() => {
    clearClubChipBalanceCache();
    setBalanceNonce((nonce) => nonce + 1);
  }, []);

  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      setMenuOpen(false);
      // Clear the long-press latch here too: when the popover is dismissed by
      // the overlay (rather than by a click landing back on the tile), the
      // latch would otherwise stay set and swallow the user's NEXT tile tap.
      longPressFired.current = false;
      clearLongPress();
      if (returnFocus) triggerRef.current?.focus();
    },
    [clearLongPress]
  );

  // Focus follows the active item while the menu is open
  useEffect(() => {
    if (menuOpen) itemRefs.current[activeIndex]?.focus();
  }, [menuOpen, activeIndex]);

  const handlePointerDown = useCallback(() => {
    if (!hasSwitch) return;
    longPressFired.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      haptic.medium();
      openMenu();
    }, LONG_PRESS_MS);
  }, [hasSwitch, clearLongPress, openMenu]);

  const handleTileClick = useCallback(() => {
    if (longPressFired.current) {
      // The hold already opened the popover — swallow the synthetic click
      longPressFired.current = false;
      return;
    }
    if (targetClub) onSelect(targetClub);
    else onEmpty();
  }, [targetClub, onSelect, onEmpty]);

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

  const clubName = targetClub?.name || undefined;
  // Drop refs for rows that no longer exist (club left / list shrank)
  itemRefs.current.length = clubs.length;

  return (
    <div className={styles.cashierTileWrap}>
      <button
        ref={triggerRef}
        className={styles.tileCard}
        onClick={handleTileClick}
        onPointerEnter={handlePreload}
        onFocus={handlePreload}
        onPointerDown={() => {
          handlePreload();
          handlePointerDown();
        }}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
        onContextMenu={(e) => {
          if (hasSwitch) {
            e.preventDefault();
            openMenu();
          }
        }}
        onKeyDown={(e) => {
          if (
            hasSwitch &&
            (e.key === 'ArrowDown' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))
          ) {
            e.preventDefault();
            openMenu();
          }
        }}
        aria-haspopup={hasSwitch ? 'menu' : undefined}
        aria-expanded={hasSwitch ? menuOpen : undefined}
        aria-keyshortcuts={hasSwitch ? 'ArrowDown Shift+F10' : undefined}
        aria-label={
          clubName
            ? `${tile.alt} For ${clubName} (Press ${tile.shortcutKey}${hasSwitch ? ', Hold To Choose A Wallet' : ''})`
            : `${tile.alt} (Press ${tile.shortcutKey})`
        }
        title={clubName ? `${tile.alt} - ${clubName}` : tile.alt}
      >
        <div className={styles.tilePedestal}></div>
        <div className={styles.tileImageWrapper}>
          <img
            src={tile.img}
            alt={tile.alt}
            className={styles.tileImage}
            loading="eager"
            width={640}
            height={1024}
          />
        </div>
      </button>

      {menuOpen && (
        <>
          <div className={styles.cashierSwitchOverlay} onClick={() => closeMenu(true)} />
          <div className={styles.cashierSwitchMenu} onKeyDown={handleMenuKeyDown}>
            <div className={styles.cashierSwitchTitle}>{menuTitle}</div>
            {balancesLoading && (
              <div className={styles.cashierSwitchStatus} role="status" aria-live="polite">
                Reading Wallet Balances...
              </div>
            )}
            {!balancesLoading && balancesError && (
              <div className={styles.cashierSwitchStatus} role="alert">
                Wallet Balances Unavailable.
                <button type="button" onClick={retryBalances}>
                  Retry
                </button>
              </div>
            )}
            <div className={styles.cashierSwitchItems} role="menu" aria-label={menuTitle}>
              {clubs.map((club, idx) => (
                <button
                  key={club.id}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  role="menuitem"
                  tabIndex={idx === activeIndex ? 0 : -1}
                  className={`${styles.cashierSwitchItem} ${
                    club.id === targetClub?.id ? styles.cashierSwitchItemActive : ''
                  }`}
                  title={club.name || undefined}
                  onClick={() => {
                    closeMenu(false);
                    onSelect(club);
                  }}
                >
                  {club.logo_url ? (
                    <img
                      src={club.logo_url}
                      alt=""
                      className={styles.cashierSwitchLogo}
                      loading="lazy"
                    />
                  ) : (
                    <span className={styles.cashierSwitchLogoFallback} aria-hidden="true">
                      {(club.name || '?').charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className={styles.cashierSwitchItemText}>
                    <span className={styles.cashierSwitchItemName}>
                      {club.name || 'Unnamed Club'}
                    </span>
                    {isUnionEntity(club) && (
                      <span className={styles.cashierSwitchItemBalance}>Union Wallet</span>
                    )}
                    {!isUnionEntity(club) && balances?.has(club.id) && (
                      <span className={styles.cashierSwitchItemBalance}>
                        {(balances.get(club.id) as number).toLocaleString()} Chips
                      </span>
                    )}
                    {!isUnionEntity(club) && !balancesLoading && balancesError && (
                      <span className={styles.cashierSwitchItemBalance}>Balance Unavailable</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
