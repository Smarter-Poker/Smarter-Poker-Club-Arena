/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ☰ TABLE MENU — Hamburger Menu for Table Actions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Comprehensive table menu with:
 * - Quick actions (leave, sit out, rebuy)
 * - Settings access
 * - Hand history
 * - Help & feedback
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './TableMenu.css';
import { haptic, soundService } from '../../services/SoundService';
import {
  SitOutIcon,
  RebuyIcon,
  HandHistoryIcon,
  LeaderboardIcon,
  SessionStatsIcon,
  SettingsIcon,
  HelpIcon,
  LeaveTableIcon,
} from './TableMenuIcons';
import { reportError } from '../../utils/errorReporter';
import { isSoundAllowed } from '../../utils/soundGate';
import { STORAGE_KEYS } from '../../lib/storage';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { AvatarGallery } from '../customization/AvatarGallery';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { useButtonImage } from '../../hooks/useButtonImage';

// ─── SVG Icons for Identity section ─── */
const AvatarIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <circle cx="10" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <path d="M2 18c0-3.3 3.6-6 8-6s8 2.7 8 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
  </svg>
);

const NameTagIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <line x1="5" y1="10" x2="15" y2="10" stroke="currentColor" strokeWidth="1.5" />
    <line x1="5" y1="13" x2="11" y2="13" stroke="currentColor" strokeWidth="1" opacity="0.5" />
  </svg>
);

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MenuAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  badge?: string | number;
}

export interface MenuSection {
  title?: string;
  actions: MenuAction[];
}

export interface TableMenuObserver {
  id: string;
  name: string;
  avatar?: string;
}

export interface TableMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
  sections: MenuSection[];
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  tableName?: string;
  /** WebSocket connection status */
  connectionStatus?: 'connected' | 'disconnected' | 'reconnecting';
  /** Notification badge count on trigger */
  badgeCount?: number;
  /** Current hand number for display in header */
  handNumber?: number;
  /** Session duration string (e.g. "1h 23m") */
  sessionDuration?: string;
  /** Observers watching the table — shown in menu dropdown */
  observers?: TableMenuObserver[];
  /**
   * AUDIT 2026-08-25 — A HANDLER THAT REACHED NOTHING.
   *
   * `createDefaultMenuSections` DECLARED `onChangeAvatar`, `onToggleAlias` and
   * `aliasLabel` in its handlers object and then never put any of them on a
   * menu action. TableTabBar passed `onToggleAlias` (emitting
   * TABLE_MENU_ACTION / 'TOGGLE_ALIAS', which TablePage answers by opening
   * IdentityModal) and it was dropped on the floor, so the identity dialog was
   * unreachable from the only menu in the app that offers it.
   *
   * The Identity section is injected by THIS component, not by
   * `createDefaultMenuSections`, so the handler has to arrive here to be usable.
   * That is what this prop is. When it is absent the section still renders its
   * own real-name switch, so a standalone TableMenu is unchanged.
   */
  onOpenIdentity?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT MENU SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function createDefaultMenuSections(
  handlers: {
    onSitOut?: () => void;
    onStandUpBB?: () => void;
    onRebuy?: () => void;
    onAutoTopUp?: () => void;
    onAddOn?: () => void;
    onSessionStats?: () => void;
    onSettings?: () => void;
    onToggleSounds?: () => void;
    onToggleVibrations?: () => void;
    /** Dan 2026-08-30: hamburger switch "Multi Table Profit Tracking" ON/OFF. */
    onToggleProfitTracking?: () => void;
    onHandHistory?: () => void;
    onLeaderboard?: () => void;
    onHelp?: () => void;
    onLeaveTable?: () => void;
    /* `onChangeAvatar`, `onToggleAlias` and `aliasLabel` were declared here and
       used by nothing — see the note on TableMenuProps.onOpenIdentity. The
       Identity section belongs to TableMenu itself; the alias handler now
       arrives there as `onOpenIdentity`, and the avatar picker is TableMenu's
       own in-app AvatarGallery (a popup WINDOW at a live table, which the old
       CHANGE_AVATAR path opened, loses you the table). */
  },
  state?: {
    standUpBBBadge?: string;
    autoTopUpBadge?: string;
    soundsBadge?: string;
    vibrationsBadge?: string;
    profitTrackingBadge?: string;
  }
): MenuSection[] {
  return [
    {
      title: 'Quick Actions',
      actions: [
        {
          id: 'sitout',
          label: 'Sit Out Next Hand',
          icon: <SitOutIcon />,
          onClick: handlers.onSitOut || (() => {}),
        },
        {
          id: 'standup-bb',
          label: 'Stand Up Next Big Blind',
          icon: <SitOutIcon />,
          badge: state?.standUpBBBadge,
          onClick: handlers.onStandUpBB || (() => {}),
        },
        {
          id: 'rebuy',
          label: 'Add Chips',
          icon: <RebuyIcon />,
          onClick: handlers.onRebuy || (() => {}),
        },
        {
          id: 'auto-top-up',
          label: 'Auto Top Up',
          icon: <RebuyIcon />,
          badge: state?.autoTopUpBadge,
          onClick: handlers.onAutoTopUp || (() => {}),
        },
      ],
    },
    {
      title: 'Table Info',
      actions: [
        {
          id: 'history',
          label: 'Hand History',
          icon: <HandHistoryIcon />,
          onClick: handlers.onHandHistory || (() => {}),
        },
        {
          id: 'leaderboard',
          label: 'Leaderboard',
          icon: <LeaderboardIcon />,
          onClick: handlers.onLeaderboard || (() => {}),
        },
        ...(handlers.onSessionStats
          ? [
              {
                id: 'session-stats',
                label: 'Session Stats',
                icon: <SessionStatsIcon />,
                onClick: handlers.onSessionStats,
              },
            ]
          : []),
        {
          id: 'settings',
          label: 'Table Settings',
          icon: <SettingsIcon />,
          onClick: handlers.onSettings || (() => {}),
        },
        {
          id: 'sounds',
          label: 'Sounds',
          icon: <SettingsIcon />,
          badge: state?.soundsBadge,
          onClick: handlers.onToggleSounds || (() => {}),
        },
        {
          id: 'vibrations',
          label: 'Vibrations',
          icon: <SettingsIcon />,
          badge: state?.vibrationsBadge,
          onClick: handlers.onToggleVibrations || (() => {}),
        },
        /* Dan 2026-08-30: "IT SHOULD ALSO BE AN ON OFF SWITCH IN THE
           HAMBURGER MENU 'MULTI TABLE PROFIT TRACKING' ON / OFF." Only
           rendered when a handler arrives (MultiTablePage owns the setting);
           the profit chip is a cash-game-only feature either way. */
        ...(handlers.onToggleProfitTracking
          ? [
              {
                id: 'profit-tracking',
                label: 'Multi Table Profit Tracking',
                icon: <SettingsIcon />,
                badge: state?.profitTrackingBadge,
                onClick: handlers.onToggleProfitTracking,
              },
            ]
          : []),
      ],
    },
    {
      title: 'Support',
      actions: [
        {
          id: 'help',
          label: 'Game Rules',
          icon: <HelpIcon />,
          onClick: handlers.onHelp || (() => {}),
        },
      ],
    },
    {
      actions: [
        {
          id: 'leave',
          label: 'Leave Table',
          icon: <LeaveTableIcon />,
          onClick: handlers.onLeaveTable || (() => {}),
          danger: true,
        },
      ],
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableMenu({
  isOpen,
  onClose,
  onToggle,
  sections: propSections,
  position = 'top-right',
  tableName,
  connectionStatus = 'connected',
  badgeCount = 0,
  handNumber,
  sessionDuration,
  observers = [],
  onOpenIdentity,
}: TableMenuProps) {
  const hamburgerIcon = useButtonImage('icon-hamburger');
  /* `activeSection` / `setActiveSection` deleted 2026-08-25: state written by
     nobody and read by nobody since the file was written. */
  const menuRef = useRef<HTMLDivElement>(null);
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  // LAZY INITIALIZER (2026-08-28): the stored value was read one tick later
  // in an effect, so the menu's "Real Name / Username" badge flashed wrong on
  // mount. TablePage reads the very same key in its initializer — TableMenu
  // now matches. (isVip stays async by design: entitlements are not cached
  // locally, see useHeaderDataStore's cosmetics note.)
  const [useRealName, setUseRealName] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME) === 'true';
    } catch {
      return false;
    }
  });
  const [isVip, setIsVip] = useState(false);
  const { user } = useAuthUser();
  const avatarUrl = useHeaderDataStore((s) => s.avatarUrl);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    const useReal = localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME);
    if (useReal !== null) setUseRealName(useReal === 'true');
    // Fetch VIP status once
    if (user?.id) {
      supabase
        .from('profiles')
        .select('is_vip, tier')
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) setIsVip(data.is_vip || data.tier === 'vip' || false);
        });
    }
  }, [user?.id]);

  const handleUseRealNameToggle = () => {
    const newValue = !useRealName;
    setUseRealName(newValue);

    // Optimistic local storage update
    localStorage.setItem(STORAGE_KEYS.USE_REAL_NAME, String(newValue));
    masterBus.emit('SETTINGS_CHANGED', { setting: 'useRealName', value: newValue });

    if (user?.id) {
      const updateRealName = async () => {
        try {
          const { error } = await supabase
            .from('profiles')
            .update({ use_real_name: newValue } as any)
            .eq('id', user.id);
          if (error) throw error;
        } catch (err: any) {
          reportError(err, 'TableMenu.Error_updating_use_real_name');
          localStorage.setItem(STORAGE_KEYS.USE_REAL_NAME, String(!newValue));
          setUseRealName(!newValue);
        }
      };
      updateRealName();
    }
  };

  // Inject Identity section dynamically into the passed sections
  const sections: MenuSection[] = [
    {
      title: 'Identity',
      actions: [
        {
          id: 'avatar',
          label: 'Change Avatar',
          icon: avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Avatar"
              style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'contain' }}
            />
          ) : (
            <AvatarIcon />
          ),
          onClick: () => setShowAvatarGallery(true),
        },
        /* Two DIFFERENT identity settings live here, and until this pass one of
           them was unreachable while the other called itself by the other's
           name.

           `use_real_name` (this row) picks between the player's real name and
           their username, is read by utils/playerDisplayName and by TablePage's
           hero-name derivation, and is genuinely live. Its old label —
           "Using Real Name (vs Alias)" — called the USERNAME an alias, which is
           the term the OTHER setting uses, so the two were indistinguishable in
           a list. Relabelled to what it actually switches, with the current
           value as the badge.

           `use_alias` / `table_alias` (the row below) is a club alias worn at
           the table, and it wins over both of the above on the felt. It is
           edited in IdentityModal, which is what `onOpenIdentity` opens. */
        {
          id: 'display-name',
          label: 'Display Name',
          icon: <NameTagIcon />,
          badge: useRealName ? 'Real Name' : 'Username',
          onClick: handleUseRealNameToggle,
        },
        ...(onOpenIdentity
          ? [
              {
                id: 'table-alias',
                label: 'Table Alias',
                icon: <NameTagIcon />,
                onClick: onOpenIdentity,
              },
            ]
          : []),
      ] as MenuAction[],
    },
    ...propSections,
  ];

  // Sound cue on menu open
  // SOUND IMPROVEMENT 2026-08-19: this used to spin up a BRAND NEW
  // AudioContext on every menu open (browsers cap concurrent contexts at ~6
  // on Safari — a heavy session could exhaust them and silence the whole
  // table). Route through the shared SoundService, which also respects the
  // real mute/volume settings instead of a fourth localStorage key.
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      // AUDIT 2026-08-20: this read 'table_sound_muted', a key NOTHING in the
      // app has ever written — so the check was always false and gated nothing.
      if (isSoundAllowed()) {
        try {
          soundService.playButtonClick();
        } catch (e) {
          reportError(e, 'TableMenu.openSound');
        }
      }
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);
  // CSS handles the animation now

  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE AVATAR PICKER IS NOT "OUTSIDE" (Dan 2026-08-31, binding)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Dan: "you cant ... hit anything inside the avatar selection and keep it
   * up, it auto closes."
   *
   * AvatarGallery is rendered as a CHILD of this menu (bottom of this file)
   * but portals itself to document.body (AvatarGallery.tsx, createPortal). Its
   * DOM therefore sits outside BOTH `menuRef` and `dropdownRef`, so the very
   * first mousedown on an avatar tile satisfied the test below, closed the
   * menu, and unmounted the gallery along with it. Every click inside the
   * picker was being read as a click outside the menu.
   *
   * While the gallery is open this menu is not the thing being interacted
   * with, so neither dismissal applies: the gallery runs its own focus trap
   * and owns the Escape key, and it has its own backdrop. Closing it returns
   * `showAvatarGallery` to false and both listeners resume.
   */
  useEffect(() => {
    if (showAvatarGallery) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose, showAvatarGallery]);

  // Close on escape — but not while the avatar picker owns the keyboard.
  useEffect(() => {
    if (showAvatarGallery) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose, showAvatarGallery]);

  const handleActionClick = useCallback(
    (action: MenuAction) => {
      if (action.disabled) return;
      // FIX 198: Bible V8 §5.4 — use haptic service, not raw navigator.vibrate
      haptic.light();
      action.onClick();
      onClose();
    },
    [onClose]
  );

  return (
    <div className={`table-menu table-menu--${position}`} ref={menuRef}>
      {/* Hamburger Button */}
      <button
        className={`table-menu__trigger ${isOpen ? 'table-menu__trigger--active' : ''}`}
        onClick={onToggle}
        aria-label="Table Menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <img src={hamburgerIcon} className="table-menu__trigger-img" alt="" draggable={false} />
        {/* Notification badge */}
        {badgeCount != null && badgeCount > 0 && (
          <span className="table-menu__badge" aria-label={`${badgeCount} Notifications`}>
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {/* Backdrop overlay for mobile focus */}
      {isOpen &&
        createPortal(
          <>
            <div className="table-menu__backdrop" onClick={onClose} aria-hidden="true" />
            <div
              ref={dropdownRef}
              className="table-menu__dropdown"
              role="menu"
              aria-label={tableName || 'Table menu'}
            >
              {/* Header */}
              {/* Header with table name, connection, and hand info */}
              {(tableName || connectionStatus) && (
                <div className="table-menu__header">
                  <div className="table-menu__header-row">
                    {tableName && <span className="table-menu__table-name">{tableName}</span>}
                    {connectionStatus && (
                      <span className={`table-menu__conn table-menu__conn--${connectionStatus}`}>
                        <span className="table-menu__conn-dot" />
                        {connectionStatus === 'connected'
                          ? 'Live'
                          : connectionStatus === 'reconnecting'
                            ? 'Reconnecting…'
                            : 'Offline'}
                      </span>
                    )}
                  </div>
                  {(handNumber != null || sessionDuration) && (
                    <div className="table-menu__header-meta">
                      {handNumber != null && <span>Hand #{handNumber}</span>}
                      {handNumber != null && sessionDuration && (
                        <span className="table-menu__meta-sep">·</span>
                      )}
                      {sessionDuration && <span>{sessionDuration}</span>}
                    </div>
                  )}
                </div>
              )}

              {/* Sections */}
              <div className="table-menu__body">
                {sections.map((section, sIdx) => (
                  <div
                    key={sIdx}
                    className="table-menu__section"
                    role="group"
                    aria-label={section.title}
                  >
                    {section.title && (
                      <span className="table-menu__section-title">{section.title}</span>
                    )}
                    {section.actions.map((action, i) => {
                      /* `sections.indexOf(section)` (object identity, O(n^2))
                         replaced with the index the map already hands us. Two
                         sections that happened to be the same object reference
                         would have shared a stagger origin. */
                      const actionIndex =
                        sections.slice(0, sIdx).reduce((n, s) => n + s.actions.length, 0) + i;
                      return (
                        <button
                          key={action.id}
                          role="menuitem"
                          className={`table-menu__action ${action.danger ? 'table-menu__action--danger' : ''} ${action.disabled ? 'table-menu__action--disabled' : ''}`}
                          onClick={() => handleActionClick(action)}
                          disabled={action.disabled}
                          style={{ '--stagger-idx': actionIndex } as React.CSSProperties}
                        >
                          <span className="table-menu__action-icon">{action.icon}</span>
                          <span className="table-menu__action-label">{action.label}</span>
                          {action.badge != null && (
                            <span className="table-menu__action-badge">{action.badge}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* Observers Section */}
              {observers.length > 0 && (
                <div className="table-menu__observers">
                  <span className="table-menu__observers-title">
                    <span className="table-menu__observers-icon">◉</span>
                    {observers.length} Watching
                  </span>
                  <div className="table-menu__observers-list">
                    {observers.map((obs) => (
                      <span key={obs.id} className="table-menu__observer-name">
                        {obs.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>,
          document.body
        )}

      {/* Avatar Gallery Modal */}
      {user && (
        <AvatarGallery
          isOpen={showAvatarGallery}
          onClose={() => setShowAvatarGallery(false)}
          userId={user.id}
          currentAvatarUrl={avatarUrl || ''}
          isVip={isVip}
        />
      )}
    </div>
  );
}

export default TableMenu;
