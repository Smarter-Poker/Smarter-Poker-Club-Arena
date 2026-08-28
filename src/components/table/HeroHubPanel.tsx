/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HERO HUB — the tabbed panel behind the hero's own avatar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, verbatim: "REMOVE THE STATS BUTTON FROM THE UPPER LEFT HAND
 * CORNER, AND MOVE IT TO THE HERO AVATAR. WHEN YOU CLICK THE AVATAR ... YOU
 * SHOULD SEE MULTIPLE TABS: THE THROWABLE, STATS, PROFILE SETTINGS, AND TABLE
 * SETTINGS."
 *
 * Tapping the hero's avatar opens this hub. The Throwables tab renders the
 * existing ThrowableSelector inline (that component is pinned by
 * tests/protected-features.json and stays a leaf — it is wrapped, never
 * forked). The other three tabs are launchers into the surfaces that already
 * exist: RealTimeResultPanel / TournamentInfoPanel for stats, the avatar
 * gallery + IdentityModal + ClubProfileModal for profile, and SettingsPanel
 * for table settings. Each launcher closes the hub first so two overlays
 * never stack.
 *
 * The upper-left stats button (MiniStatsCard's cash icon) is gone from the
 * HUD in the same commit — this hub is its replacement. The tournament
 * variants of MiniStatsCard stay: the 4-figure bar and the spectator lobby
 * button serve people with no seat and therefore no hero avatar to tap.
 */

import { useState } from 'react';
import { ThrowableSelector } from './ThrowableSelector';
import type { Throwable } from '../../services/ThrowableService';
import './HeroHubPanel.css';

export type HeroHubTab = 'throwables' | 'stats' | 'profile' | 'settings';

export interface HeroHubPanelProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  /** v8Settings.emoji_enabled — same gate the standalone selector obeys. */
  emojiEnabled: boolean;
  isTournament: boolean;
  /** The existing throw pipeline (useTableAnimations.handleThrowableSelect). */
  onThrowableSelect: (throwable: Throwable) => void;
  onOpenStats: () => void;
  onOpenTournamentInfo: () => void;
  onOpenProfileView: () => void;
  onOpenAvatarPicker: () => void;
  onOpenIdentity: () => void;
  onOpenTableSettings: () => void;
}

const TABS: Array<{ id: HeroHubTab; label: string }> = [
  { id: 'throwables', label: 'Throwables' },
  { id: 'stats', label: 'Stats' },
  { id: 'profile', label: 'Profile' },
  { id: 'settings', label: 'Table' },
];

export function HeroHubPanel({
  isOpen,
  onClose,
  userId,
  emojiEnabled,
  isTournament,
  onThrowableSelect,
  onOpenStats,
  onOpenTournamentInfo,
  onOpenProfileView,
  onOpenAvatarPicker,
  onOpenIdentity,
  onOpenTableSettings,
}: HeroHubPanelProps) {
  const [tab, setTab] = useState<HeroHubTab>('throwables');

  if (!isOpen) return null;

  /** Launchers close the hub first so two full overlays never stack. */
  const launch = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const item = (label: string, sub: string, fn: () => void) => (
    <button key={label} type="button" className="hero-hub__item" onClick={launch(fn)}>
      <span className="hero-hub__item-label">{label}</span>
      <span className="hero-hub__item-sub">{sub}</span>
    </button>
  );

  return (
    <div className="hero-hub__overlay" onClick={onClose} role="presentation">
      <div
        className="hero-hub"
        role="dialog"
        aria-label="Player hub"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hero-hub__tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`hero-hub__tab${tab === t.id ? ' hero-hub__tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button type="button" className="hero-hub__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {tab === 'throwables' &&
          (emojiEnabled ? (
            <div className="hero-hub__throwables">
              {/* The leaf selector, unchanged. Its onClose closes the whole
                  hub — after a throw there is nothing left to pick. */}
              <ThrowableSelector userId={userId} onSelect={onThrowableSelect} onClose={onClose} />
            </div>
          ) : (
            <div className="hero-hub__empty">Throwables Are Disabled In Table Settings</div>
          ))}

        {tab === 'stats' && (
          <div className="hero-hub__menu">
            {item('Session Stats', 'Live P&L, Hands, VPIP And Analytics', onOpenStats)}
            {isTournament &&
              item('Tournament Info', 'Standings, Payouts And Blind Clock', onOpenTournamentInfo)}
          </div>
        )}

        {tab === 'profile' && (
          <div className="hero-hub__menu">
            {item('View Profile', 'Your Table Identity And Session', onOpenProfileView)}
            {item('Change Avatar', 'Pick A New Table Avatar', onOpenAvatarPicker)}
            {item('Display Name', 'Real Name Or Alias At The Table', onOpenIdentity)}
          </div>
        )}

        {tab === 'settings' && (
          <div className="hero-hub__menu">
            {item(
              'Table Settings',
              'Gameplay, Display, Sound And Customization',
              onOpenTableSettings
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default HeroHubPanel;
