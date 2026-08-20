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
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT MENU SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function createDefaultMenuSections(handlers: {
  onSitOut?: () => void;
  onRebuy?: () => void;
  onAddOn?: () => void;
  onSessionStats?: () => void;
  onSettings?: () => void;
  onHandHistory?: () => void;
  onLeaderboard?: () => void;
  onHelp?: () => void;
  onLeaveTable?: () => void;
  onChangeAvatar?: () => void;
  onToggleAlias?: () => void;
  aliasLabel?: string;
}): MenuSection[] {
  return [
    {
      title: 'Identity',
      actions: [
        {
          id: 'avatar',
          label: 'Change Avatar',
          icon: <AvatarIcon />,
          onClick: handlers.onChangeAvatar || (() => {}),
        },
        {
          id: 'display-name',
          label: handlers.aliasLabel || 'Display Name',
          icon: <NameTagIcon />,
          onClick: handlers.onToggleAlias || (() => {}),
        },
      ],
    },
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
          id: 'rebuy',
          label: 'Add Chips',
          icon: <RebuyIcon />,
          onClick: handlers.onRebuy || (() => {}),
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
          label: 'Settings',
          icon: <SettingsIcon />,
          onClick: handlers.onSettings || (() => {}),
        },
      ],
    },
    {
      title: 'Support',
      actions: [
        {
          id: 'help',
          label: 'Help & Rules',
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
}: TableMenuProps) {
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [useRealName, setUseRealName] = useState(false);
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
      title: 'Identity Component',
      actions: [
        {
          id: 'avatar',
          label: 'Change Avatar',
          icon: <AvatarIcon />,
          onClick: () => setShowAvatarGallery(true),
        },
        {
          id: 'alias-toggle',
          label: useRealName ? 'Using Real Name (vs Alias)' : 'Using Alias (vs Real Name)',
          icon: <NameTagIcon />,
          onClick: handleUseRealNameToggle,
        },
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
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!isOpen) {
      // Reset animation state when menu closes so items animate in on next open
      setVisibleItems(new Set());
      return;
    }
    const allActions = sections.flatMap((s) => s.actions);
    const timeouts = allActions.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 40)
    );
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [isOpen, sections.length]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

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
        aria-label="Table menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="table-menu__hamburger">
          <span />
          <span />
          <span />
        </span>
        {/* Notification badge */}
        {badgeCount != null && badgeCount > 0 && (
          <span className="table-menu__badge" aria-label={`${badgeCount} notifications`}>
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {/* Backdrop overlay for mobile focus */}
      {isOpen && <div className="table-menu__backdrop" onClick={onClose} aria-hidden="true" />}

      {/* Dropdown */}
      {isOpen && (
        <div className="table-menu__dropdown" role="menu" aria-label={tableName || 'Table menu'}>
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
                  const actionIndex =
                    sections.slice(0, sections.indexOf(section)).flatMap((s) => s.actions).length +
                    i;
                  return (
                    <button
                      key={action.id}
                      role="menuitem"
                      className={`table-menu__action ${action.danger ? 'table-menu__action--danger' : ''} ${action.disabled ? 'table-menu__action--disabled' : ''}`}
                      onClick={() => handleActionClick(action)}
                      disabled={action.disabled}
                      style={{
                        opacity: visibleItems.has(actionIndex) ? 1 : 0,
                        transform: visibleItems.has(actionIndex)
                          ? 'translateY(0)'
                          : 'translateY(8px)',
                        transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      }}
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
