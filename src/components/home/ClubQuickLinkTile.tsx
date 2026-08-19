/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB QUICK LINK TILE — lobby tile that deep-links into a specific club
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Used by the Cashier and Marketplace bottom-row tiles. Renders the target
 * club's name on the tile, and for multi-club users a quick-switch button
 * (also reachable by long-pressing the tile) that opens a club popover with
 * logos, full keyboard navigation, and managed focus.
 *
 * Tap tile          -> onSelect(targetClub), or onEmpty() with no clubs
 * Tap switch / hold -> popover: ArrowUp/Down/Home/End navigate, Enter/Space
 *                      select, Escape closes and returns focus to the trigger
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import haptic from '../../services/HapticService';
import type { LobbyTile } from '../../config/lobbyTiles.config';
import type { QuickLinkClub } from '../../utils/clubQuickLink';
import styles from '../../pages/HomePage.module.css';

const LONG_PRESS_MS = 500;

interface ClubQuickLinkTileProps<T extends QuickLinkClub> {
  tile: LobbyTile;
  /** Eligible clubs (already union-filtered). */
  clubs: T[];
  /** Club the tile opens on tap; null when the user has no eligible clubs. */
  targetClub: T | null;
  /** Popover heading, e.g. "Open Cashier For". */
  menuTitle: string;
  /** Navigate to the destination for this club. */
  onSelect: (club: T) => void;
  /** Tap behavior when the user has no eligible clubs. */
  onEmpty: () => void;
}

export default function ClubQuickLinkTile<T extends QuickLinkClub>({
  tile,
  clubs,
  targetClub,
  menuTitle,
  onSelect,
  onEmpty,
}: ClubQuickLinkTileProps<T>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const hasSwitch = clubs.length > 1;

  const openMenu = useCallback(() => {
    const selected = targetClub ? clubs.findIndex((c) => c.id === targetClub.id) : 0;
    setActiveIndex(selected >= 0 ? selected : 0);
    setMenuOpen(true);
  }, [clubs, targetClub]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Focus follows the active item while the menu is open
  useEffect(() => {
    if (menuOpen) itemRefs.current[activeIndex]?.focus();
  }, [menuOpen, activeIndex]);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

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

  return (
    <div className={styles.cashierTileWrap}>
      <button
        className={styles.tileCard}
        onClick={handleTileClick}
        onPointerDown={handlePointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onContextMenu={(e) => {
          if (hasSwitch) {
            e.preventDefault();
            openMenu();
          }
        }}
        aria-label={
          clubName
            ? `${tile.alt} for ${clubName} (press ${tile.shortcutKey}${hasSwitch ? ', hold to switch clubs' : ''})`
            : `${tile.alt} (press ${tile.shortcutKey})`
        }
        title={clubName ? `${tile.alt} — ${clubName}` : tile.alt}
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
          <span className={styles.tileLabel}>
            {tile.alt}
            {clubName && <span className={styles.tileClubName}>{clubName}</span>}
          </span>
        </div>
      </button>

      {hasSwitch && (
        <button
          ref={triggerRef}
          className={styles.cashierSwitchBtn}
          onClick={(e) => {
            e.stopPropagation();
            haptic.light();
            if (menuOpen) closeMenu(false);
            else openMenu();
          }}
          aria-label={`Switch club for ${tile.alt}`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="Switch club"
        >
          {'⇄'}
        </button>
      )}

      {menuOpen && (
        <>
          <div className={styles.cashierSwitchOverlay} onClick={() => closeMenu(false)} />
          <div
            className={styles.cashierSwitchMenu}
            role="menu"
            aria-label={menuTitle}
            onKeyDown={handleMenuKeyDown}
          >
            <div className={styles.cashierSwitchTitle}>{menuTitle}</div>
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
                <span className={styles.cashierSwitchItemName}>{club.name || 'Unnamed Club'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
