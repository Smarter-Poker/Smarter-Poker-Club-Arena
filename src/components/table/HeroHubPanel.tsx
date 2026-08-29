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
 * HUD in the same commit — this hub is its replacement.
 *
 * Updated 2026-08-28: MiniStatsCard's four-figure tournament bar is gone too.
 * Dan: "STATS SHOULD LIVE INSIDE THE HERO AVATAR ... STATS ICON IS NOT THE
 * TOURNAMENT LOBBY BUTTON." The upper-right corner on a tournament is now one
 * button that opens the full tournament lobby (TournamentLobbyModal), and the
 * Stats tab below is the only place a player's own figures are shown. A
 * spectator has no hero avatar to tap and therefore no stats — which is
 * correct, they have no session to have stats about; the lobby button in the
 * corner is what serves them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ThrowableSelector } from './ThrowableSelector';
import type { Throwable } from '../../services/ThrowableService';
import './HeroHubPanel.css';

export type HeroHubTab = 'throwables' | 'stats' | 'profile' | 'settings';

/**
 * 2026-08-29 hardening pass: the hub reopens on the tab the player last used,
 * for this session. A grinder who lives in Stats stops paying one extra tap
 * per open; a fresh session still lands on Throwables, the most-tapped tab.
 * sessionStorage on purpose — a preference this light should not follow the
 * player across devices or outlive the session, and it must never throw the
 * panel (private mode, blocked storage), hence the try/catch on both sides.
 */
export const HERO_HUB_TAB_KEY = 'ca_hero_hub_tab';
const TAB_IDS: readonly HeroHubTab[] = ['throwables', 'stats', 'profile', 'settings'];

export function readInitialHubTab(): HeroHubTab {
  try {
    const raw = sessionStorage.getItem(HERO_HUB_TAB_KEY);
    if (raw && (TAB_IDS as readonly string[]).includes(raw)) return raw as HeroHubTab;
  } catch {
    /* storage unavailable — land on the default */
  }
  return 'throwables';
}

export function rememberHubTab(tab: HeroHubTab): void {
  try {
    sessionStorage.setItem(HERO_HUB_TAB_KEY, tab);
  } catch {
    /* storage unavailable — remembering is a convenience, never a requirement */
  }
}

/**
 * The figures the Stats tab shows WITHOUT sending the player anywhere
 * (2026-08-29). Before this, "Stats" was a tab containing one button that
 * closed the hub and opened a different panel — two taps and a context switch
 * to learn your own stack. Everything here is already computed on the page;
 * the hub just stopped hiding it. `null` fields render as "-" rather than a
 * fabricated zero (house rule: never print a number you do not have).
 */
export interface HeroHubStats {
  stack: number | null;
  /** Session P&L in chips; negative is a loss. Cash tables only. */
  profitLoss: number | null;
  handsPlayed: number | null;
  vpipPercent: number | null;
  pfrPercent: number | null;
  /** Big blinds won/lost this session — the figure grinders actually read. */
  bigBlindsWon: number | null;
}

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
  /** Identity header — who this hub belongs to. */
  heroName?: string;
  heroAvatarUrl?: string;
  /** Inline figures for the Stats tab. */
  stats?: HeroHubStats;
  /**
   * True while the hero is the seat on the clock.
   *
   * A MODAL MUST NEVER COST A PLAYER THEIR HAND (2026-08-29). Observed live:
   * the hub opens over the action buttons, and the turn timer does not care
   * that you are reading your own VPIP. When the turn ARRIVES while the hub is
   * open, the hub closes itself and hands the felt back. This is not a
   * preference being changed behind the player's back — it is the one moment
   * where staying open has a cost measured in chips. (It is also not the
   * `no-auto-table-switch` law: nothing switches tables, and `activeIndex` is
   * never touched.)
   */
  isHeroTurn?: boolean;
}

/**
 * One figure in the Stats tab.
 *
 * House rule 5: numbers are formatted with toLocaleString, never padded or
 * concatenated by hand. And a value we do not have prints "-" — a fabricated
 * 0 in a P&L column is worse than an honest blank, because 0 is a claim.
 */
function statFigure(
  label: string,
  value: number | null | undefined,
  opts: { signed?: boolean; suffix?: string; decimals?: number } = {}
) {
  const has = typeof value === 'number' && Number.isFinite(value);
  const decimals = opts.decimals ?? 0;
  let text = '-';
  if (has) {
    const v = value as number;
    text =
      (opts.signed && v > 0 ? '+' : '') +
      v.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) +
      (opts.suffix ?? '');
  }
  const tone = opts.signed && has ? ((value as number) >= 0 ? ' is-up' : ' is-down') : '';
  return (
    <div className={`hero-hub__figure${tone}`} key={label}>
      <span className="hero-hub__figure-label">{label}</span>
      <span className="hero-hub__figure-value">{text}</span>
    </div>
  );
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
  heroName,
  heroAvatarUrl,
  stats,
  isHeroTurn = false,
}: HeroHubPanelProps) {
  const [tab, setTab] = useState<HeroHubTab>(readInitialHubTab);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  /** The element focus came FROM, so closing hands it back (the hero avatar). */
  const returnFocusRef = useRef<Element | null>(null);

  /** Select a tab and remember it for the next open this session. */
  const selectTab = useCallback((next: HeroHubTab) => {
    setTab(next);
    rememberHubTab(next);
  }, []);

  /**
   * ESC CLOSES, FOCUS IS TRAPPED, AND FOCUS COMES BACK (2026-08-29).
   *
   * This opened as a bare div: Escape did nothing, focus stayed behind the
   * overlay on the felt (so Tab walked the table underneath a modal covering
   * it), and closing left focus nowhere. Three standard dialog behaviours,
   * none of which existed.
   */
  useEffect(() => {
    if (!isOpen) return;
    returnFocusRef.current = document.activeElement;
    // Focus the panel itself rather than the first tab: announcing the dialog
    // beats announcing "Throwables, tab 1 of 4" with no context.
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = panelRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const back = returnFocusRef.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
  }, [isOpen, onClose]);

  /**
   * The turn arrived while the hub was open — hand the felt back. See the
   * `isHeroTurn` prop note: a menu must never be the reason a hand times out.
   */
  useEffect(() => {
    if (isOpen && isHeroTurn) onClose();
  }, [isOpen, isHeroTurn, onClose]);

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

  /**
   * WAI-ARIA tab pattern: Left/Right move between tabs, Home/End jump to the
   * ends. Without this the tablist announced itself as a tablist and then
   * behaved like a row of unrelated buttons.
   */
  const onTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(TABS[next].id);
    tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')?.[next]?.focus();
  };

  return (
    <div className="hero-hub__overlay" onClick={onClose} role="presentation">
      <div
        className="hero-hub"
        role="dialog"
        aria-modal="true"
        aria-label="Player hub"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* WHOSE HUB IS THIS (2026-08-29). The panel was called "Player hub"
            and showed no player — no name, no avatar, no stack. */}
        {(heroName || heroAvatarUrl) && (
          <div className="hero-hub__identity">
            {heroAvatarUrl ? (
              <img className="hero-hub__identity-avatar" src={heroAvatarUrl} alt="" />
            ) : null}
            <span className="hero-hub__identity-name">{heroName}</span>
            {stats?.stack != null && (
              <span className="hero-hub__identity-stack">
                {stats.stack.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            )}
          </div>
        )}

        <div
          className="hero-hub__tabs"
          role="tablist"
          aria-label="Player hub sections"
          ref={tablistRef}
          onKeyDown={onTablistKeyDown}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`hero-hub-tab-${t.id}`}
              aria-controls={`hero-hub-panel-${t.id}`}
              aria-selected={tab === t.id}
              /* Roving tabindex: the tablist is ONE tab stop, arrows move
                 within it — the pattern screen-reader users expect. */
              tabIndex={tab === t.id ? 0 : -1}
              className={`hero-hub__tab${tab === t.id ? ' hero-hub__tab--active' : ''}`}
              onClick={() => selectTab(t.id)}
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
            <div
              className="hero-hub__throwables"
              role="tabpanel"
              id="hero-hub-panel-throwables"
              aria-labelledby="hero-hub-tab-throwables"
            >
              {/* The leaf selector, unchanged. Its onClose closes the whole
                  hub — after a throw there is nothing left to pick. (Its own
                  × is hidden by HeroHubPanel.css while embedded: two close
                  buttons that do the same thing read as a bug. The component
                  is NOT forked — it is pinned by protected-features.json.) */}
              <ThrowableSelector userId={userId} onSelect={onThrowableSelect} onClose={onClose} />
            </div>
          ) : (
            <div
              className="hero-hub__empty"
              role="tabpanel"
              id="hero-hub-panel-throwables"
              aria-labelledby="hero-hub-tab-throwables"
            >
              Throwables Are Disabled In Table Settings
            </div>
          ))}

        {tab === 'stats' && (
          <div
            className="hero-hub__menu"
            role="tabpanel"
            id="hero-hub-panel-stats"
            aria-labelledby="hero-hub-tab-stats"
          >
            {/* THE FIGURES, HERE, NOT ONE TAP AWAY (2026-08-29). This tab used
                to hold a single button that closed the hub and opened another
                panel — a "Stats" tab with no stats in it. Everything below is
                already computed on the page. A missing value prints "-", never
                a fabricated 0. */}
            {stats && (
              <div className="hero-hub__figures">
                {statFigure('Stack', stats.stack, { decimals: 2 })}
                {!isTournament &&
                  statFigure('Session', stats.profitLoss, { signed: true, decimals: 2 })}
                {!isTournament &&
                  statFigure('BB Won', stats.bigBlindsWon, { signed: true, decimals: 1 })}
                {statFigure('Hands', stats.handsPlayed)}
                {statFigure('VPIP', stats.vpipPercent, { suffix: '%' })}
                {statFigure('PFR', stats.pfrPercent, { suffix: '%' })}
              </div>
            )}
            {item('Full Session Stats', 'Trajectory Graph And Deeper Analytics', onOpenStats)}
            {isTournament &&
              item('Tournament Info', 'Standings, Payouts And Blind Clock', onOpenTournamentInfo)}
          </div>
        )}

        {tab === 'profile' && (
          <div
            className="hero-hub__menu"
            role="tabpanel"
            id="hero-hub-panel-profile"
            aria-labelledby="hero-hub-tab-profile"
          >
            {item('View Profile', 'Your Table Identity And Session', onOpenProfileView)}
            {item('Change Avatar', 'Pick A New Table Avatar', onOpenAvatarPicker)}
            {item('Display Name', 'Real Name Or Alias At The Table', onOpenIdentity)}
          </div>
        )}

        {tab === 'settings' && (
          <div
            className="hero-hub__menu"
            role="tabpanel"
            id="hero-hub-panel-settings"
            aria-labelledby="hero-hub-tab-settings"
          >
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
