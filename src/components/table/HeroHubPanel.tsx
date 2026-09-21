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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONSOLE (#ClubArenaConsole). The panel was a 16px rounded card with its
 * own border and a 48px drop shadow, carrying an avatar disc, a rounded tab
 * strip with a 10px-cornered active tab, a square close button, a grid of
 * figure tiles, a card per launcher and a pill switch per quick setting.
 *
 * It is now Dan's approved spade master: the player's name is the eyebrow,
 * PLAYER HUB is engraved in the header well, their stack sits in the well's
 * painted pill slot, the four tabs and every figure, launcher and switch print
 * as ROWS on the black glass, and Close is a lit word above the flat closing
 * cap. Nothing is drawn - no avatar disc, no tiles, no pills.
 *
 * WHAT DID NOT MOVE: the dialog semantics (Escape, focus in, focus trapped,
 * focus handed back), the roving-tabindex tab pattern, the session tab memory,
 * every launcher, every label, and the yield behaviour below.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ThrowableSelector } from './ThrowableSelector';
import type { Throwable } from '../../services/ThrowableService';
import { SpadeConsole } from '../console/SpadeConsole';
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
   * NOTHING THE PLAYER OPENED EVER CLOSES ITSELF (Dan 2026-08-31, BINDING):
   * "you cant click on the stats, or hit anything inside the avatar selection
   * and keep it up, it auto closes when action is on you and that shouldn't
   * happen... it should NEVER auto close."
   *
   * The code this replaces called `onClose()` from an effect the instant the
   * turn arrived, reasoning that a modal must never cost a player their hand.
   * The hazard was real; the remedy was not. The hazard is that the hub COVERS
   * the action buttons — so the fix is to stop covering them, not to stop
   * showing the hub.
   *
   * When this is true the overlay YIELDS instead of closing: the backdrop goes
   * transparent and stops taking pointer events, and the panel lifts clear of
   * `--sp-action-reserve` (the height the action bar owns). The hub stays
   * exactly where the player put it, the buttons underneath are visible and
   * clickable, and no turn is ever spent because a menu took itself away.
   *
   * Do not reintroduce a close here, under any flag, for any duration. Pinned
   * by tests/unit/heroHubDialogBehaviour.test.tsx.
   */
  isHeroTurn?: boolean;
  /**
   * The high-frequency table settings, shown inline on the Table tab
   * (2026-08-30). Sourced from TABLE_SETTINGS_META's `quick` flag and written
   * through the SAME `toggleSetting` the full panel uses — the hub adds a
   * surface, never a second owner or a second persisted copy (the rule
   * `tests/unit/settingsHaveOneOwner.test.ts` exists to defend).
   */
  quickSettings?: Array<{ key: string; label: string; description: string; value: boolean }>;
  onToggleQuickSetting?: (key: string) => void;
}

/**
 * One figure in the Stats tab, printed as a ROW on the glass: the name in the
 * master's lit blue on the left, the number in engraved silver on the right.
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
  stats,
  isHeroTurn = false,
  quickSettings,
  onToggleQuickSetting,
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

  /*
   * THERE IS DELIBERATELY NO AUTO-CLOSE EFFECT HERE.
   *
   * `useEffect(() => { if (isOpen && isHeroTurn) onClose(); })` used to live on
   * this line. Dan 2026-08-31: "IT SHOULD NEVER AUTO CLOSE." The turn is
   * handled by yielding the felt (see the `isHeroTurn` prop note and the
   * `--yield` modifier below), not by taking the panel away from the player who
   * opened it. Anything you are tempted to add here belongs in CSS.
   */

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

  /* WHOSE HUB IS THIS (2026-08-29). The panel was called "Player hub" and
     showed no player. The name is the eyebrow and the stack is the word in the
     header well's painted pill slot - a stack at the felt is NEVER abbreviated
     (Dan 2026-08-28), so it is printed whole and the slot's own fitter shrinks
     it to the painted face rather than shortening the number. */
  const stackPill =
    stats?.stack != null
      ? stats.stack.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : undefined;

  return (
    <div
      /* --yield: the hero is on the clock. The backdrop stops painting and
         stops taking clicks so the action bar underneath is both visible and
         pressable; the panel itself keeps its own pointer-events and simply
         sits above the bar. See the isHeroTurn prop note. */
      className={`hero-hub__overlay${isHeroTurn ? ' hero-hub__overlay--yield' : ''}`}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="hero-hub"
        role="dialog"
        aria-modal="true"
        aria-label="Player Hub"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          as="div"
          className="hero-hub__console"
          eyebrow={heroName}
          title="Player Hub"
          pill={stackPill}
          pillInk="silver"
          foot="foot"
        >
          <div
            className="hero-hub__tabs"
            role="tablist"
            aria-label="Player Hub Sections"
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
              {/* THE SWITCHES YOU REACH FOR MID-SESSION, HERE (2026-08-30).
                  This tab used to be one button that closed the hub and opened
                  SettingsPanel — the same weakness the Stats tab had. These
                  write through the settings' single owner; the full panel is
                  still one tap below for everything else. */}
              {quickSettings && quickSettings.length > 0 && (
                <div className="hero-hub__toggles">
                  {quickSettings.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      role="switch"
                      aria-checked={s.value}
                      className={`hero-hub__toggle${s.value ? ' is-on' : ''}`}
                      onClick={() => onToggleQuickSetting?.(s.key)}
                      title={s.description}
                    >
                      <span className="hero-hub__toggle-label">{s.label}</span>
                      {/* The state is a word. The master paints no switch, and
                          a 999px track with a round thumb is the drawn control
                          the standard exists to delete; `aria-checked` above
                          carries the semantics either way. */}
                      <span className="hero-hub__toggle-state" aria-hidden="true">
                        {s.value ? 'On' : 'Off'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {item(
                'All Table Settings',
                'Gameplay, Display, Sound And Customization',
                onOpenTableSettings
              )}
            </div>
          )}

          {/* One action, so the foot is the flat closing cap and Close is a lit
              word - the master paints BOTH plates, and a single action would
              leave one of them painted and empty. */}
          <button type="button" className="hero-hub__close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default HeroHubPanel;
