/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTINGS PANEL — Table Preferences
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Table preferences on the spade console (#ClubArenaConsole, 2026-09-13):
 * - Auto-muck losing hands
 * - Sound controls
 * - Card display preferences
 * - Animation speed
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AvatarGallery } from '../customization/AvatarGallery';
import { TableSettingsPanel } from './TableSettingsPanel';
import { ThemeSettingsModal } from './ThemeSettingsModal';
import { useUserTableSettings } from '../../hooks/useUserTableSettings';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { resolveAvatarDisplay } from '../../utils/avatarUtils';
import { SpadeConsole } from '../console/SpadeConsole';
import './SettingsPanel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableSettings {
  autoMuckLosers: boolean;
  autoMuckWinners: boolean;
  autoPostBlinds: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  hapticEnabled: boolean;
  // FIX 199: showHandStrength REMOVED — not allowed for live online gameplay
  showPotOdds: boolean;
  animationSpeed: 'slow' | 'normal' | 'fast';
  fourColorDeck: boolean;
  showStackInBB: boolean;
  showBetSizePresets: boolean;
  confirmAllIn: boolean;
  sitOutNextHand: boolean;
  /** Dan 2026-08-28: the scrolling tournament/announcement ticker. */
  showTicker: boolean;
}

export interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  settings: TableSettings;
  onSettingsChange: (settings: Partial<TableSettings>) => void;
  // Customization props
  userId?: string;
  currentAvatarUrl?: string;
  isVip?: boolean;
  onAvatarChanged?: (url: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_TABLE_SETTINGS: TableSettings = {
  autoMuckLosers: true,
  /* Dan 2026-08-23: "auto muck should be on by default, you should never ask
     if they want to show cards." This was the ONLY switch keeping the
     post-hand "show your cards?" modal alive: it fired on an uncontested win
     when the setting was false, which it was for every player who had never
     opened the settings panel. Default true, and the modal is gone with it —
     see the note where the toggle used to be. */
  autoMuckWinners: true,
  autoPostBlinds: true,
  soundEnabled: true,
  soundVolume: 70,
  hapticEnabled: true,
  showPotOdds: false,
  animationSpeed: 'normal',
  fourColorDeck: false,
  showStackInBB: false,
  showBetSizePresets: true,
  confirmAllIn: true,
  sitOutNextHand: false,
  showTicker: true,
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RESET TO DEFAULTS MAY ONLY WRITE WHAT THIS PANEL OFFERS A CONTROL FOR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-29. `handleReset` sent the WHOLE `DEFAULT_TABLE_SETTINGS` object, and
 * TablePage's `onSettingsChange` acts on any key that is `!== undefined`. Three
 * things came along that nobody asked to reset:
 *
 *   confirmAllIn, autoMuckWinners — no control on this panel. Their toggles
 *     were deliberately removed; the values were still being written, so the
 *     one button that promises to restore what you can see silently rewrote two
 *     things you cannot.
 *
 *   sitOutNextHand — the serious one. It is not a display preference. Sending
 *     `false` fires a real `setSitOut(tableId, false)` round trip, so a player
 *     who was sitting out and tapped Reset To Defaults to tidy up their card
 *     colours was PUT BACK IN THE GAME, blinds and all, as a side effect.
 *
 * The same shape as tests/settings-only-write-what-they-offer.test.ts, which is
 * about the notifications upsert on /settings: a save path grew a key that no
 * control on the page governs.
 *
 * So the payload is built from an explicit list. A new toggle must be added
 * here to be resettable, which is the right way round — a control you can see
 * is the thing Reset is promising to restore.
 */
const RESETTABLE_KEYS = [
  'autoMuckLosers',
  'autoPostBlinds',
  'showPotOdds',
  'fourColorDeck',
  'showBetSizePresets',
  'showTicker',
  'animationSpeed',
  'soundEnabled',
  'soundVolume',
  'hapticEnabled',
] as const satisfies readonly (keyof TableSettings)[];

/**
 * `sitOutNextHand` has a control on this panel and is still EXCLUDED, on
 * purpose. Sitting out is a live table action with a server round trip, not a
 * preference — see the note above. Restoring appearance defaults must never
 * seat or unseat anybody.
 */
export function resetPayload(): Partial<TableSettings> {
  const out: Partial<TableSettings> = {};
  for (const key of RESETTABLE_KEYS) {
    (out as Record<string, unknown>)[key] = DEFAULT_TABLE_SETTINGS[key];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SettingsPanel({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  userId = '',
  currentAvatarUrl = '',
  isVip = false,
  onAvatarChanged,
}: SettingsPanelProps) {
  const [visibleSections, setVisibleSections] = useState<boolean[]>([]);
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [showThemeSettings, setShowThemeSettings] = useState(false);

  // Bible V8 §11.1: User table settings (12 toggles) from Supabase
  const { user: authUser } = useAuthUser();
  const {
    settings: v8Settings,
    loading: v8Loading,
    toggleSetting: v8Toggle,
  } = useUserTableSettings(authUser?.id);

  // VIP status for the asset gates below.
  //
  // TableModalsLayer renders this panel without an isVip prop, so the default
  // (false) was the only value it ever had: ThemeSettingsModal locked every
  // VIP-only theme behind a padlock and an upsell for PAYING VIPs. Resolving
  // it here rather than threading a prop fixes it for every call site, and
  // matches what TableMenu already does for the avatar gallery.
  const [resolvedVip, setResolvedVip] = useState(isVip);
  useEffect(() => {
    if (isVip) {
      setResolvedVip(true);
      return;
    }
    const id = authUser?.id || userId;
    if (!isOpen || !id) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('is_vip, tier')
      .eq('id', id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setResolvedVip(data.is_vip === true || data.tier === 'vip');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isVip, authUser?.id, userId]);

  useEffect(() => {
    if (isOpen) {
      setVisibleSections([]);
      [0, 1, 2, 3].forEach((i) => {
        setTimeout(() => {
          setVisibleSections((prev) => [...prev, true]);
        }, i * 80);
      });
    }
  }, [isOpen]);

  // Handle toggle change
  const handleToggle = useCallback(
    (key: keyof TableSettings) => {
      onSettingsChange({ [key]: !settings[key] });
    },
    [settings, onSettingsChange]
  );

  // Handle slider change
  const handleSlider = useCallback(
    (key: keyof TableSettings, value: number) => {
      onSettingsChange({ [key]: value });
    },
    [onSettingsChange]
  );

  // Handle select change
  const handleSelect = useCallback(
    (key: keyof TableSettings, value: string) => {
      onSettingsChange({ [key]: value });
    },
    [onSettingsChange]
  );

  // Reset to defaults
  const handleReset = useCallback(() => {
    onSettingsChange(resetPayload());
  }, [onSettingsChange]);

  if (!isOpen) return null;

  /* ONE CONSOLE (#ClubArenaConsole, 2026-09-13). The side sheet is gone: the
     panel is the spade master with its rails bridged flat (no crest - a
     preferences sheet, not a showpiece), every setting a row on the black
     glass with an engraved rule between rows, every switch a lit word (ON
     burns green, OFF sits muted), the animation speed three lit words, and
     the one slider the art cannot paint drawn to run UP AND DOWN (a sideways
     drag at the felt is the table-switch gesture). The two painted plates in
     the foot are its actions: Reset To Defaults on steel, Close on the blue
     glass. Every handler, key and default above is untouched; the staggered
     section reveal still plays, at the same 80ms cadence. */
  const sectionStyle = (i: number): React.CSSProperties => ({
    opacity: visibleSections[i] ? 1 : 0,
    transform: visibleSections[i] ? 'translateY(0)' : 'translateY(8px)',
    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  });

  return (
    <div
      className="settings-overlay"
      /**
       * ONLY THE BACKDROP ITSELF DISMISSES (Dan 2026-08-31).
       *
       * This was `onClick={onClose}`. AvatarGallery and ThemeSettingsModal are
       * rendered as children of this div (below the footer) but each portals to
       * document.body — and a React portal still bubbles its events up the
       * REACT tree, not the DOM tree. So the first click on an avatar tile
       * reached this handler and closed the whole settings panel, taking the
       * picker with it: "you cant hit anything inside the avatar selection and
       * keep it up, it auto closes."
       *
       * Comparing target to currentTarget means only a click that landed on the
       * scrim itself closes. The panel's own stopPropagation on the line below
       * stays — it stops clicks on the panel body, which is a different path
       * from the portaled children.
       */
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-settings-title"
      >
        <SpadeConsole
          onClose={onClose}
          eyebrow="Table Preferences"
          title="Table Settings"
          titleId="table-settings-title"
          crest="flat"
          pill={settings.soundEnabled ? 'Sound On' : 'Muted'}
          pillInk={settings.soundEnabled ? 'green' : 'muted'}
          plates={{
            secondary: { label: 'Reset To Defaults', ink: 'silver', onClick: handleReset },
            primary: {
              label: 'Close',
              ink: 'white',
              onClick: onClose,
              'aria-label': 'Close Table Settings',
            },
          }}
          className="stp__console"
        >
          {/* Gameplay Section */}
          <div className="stp__section" style={sectionStyle(0)}>
            <h3 className="stp__heading sc-ink--blue">Gameplay</h3>

            {/* ── SHOWDOWN follow-up 2026-08-25 (Dan spec section 37) ──
                The auto-muck toggle RETURNS, because both of the reasons it
                was removed are gone:

                2026-08-18 removed it as a dead switch — nothing read the
                `autoMuck` key and every showdown hand was turned face up
                anyway. The engine now genuinely mucks beaten hands at
                showdown (HandController.applyShowdownRevealRules), so the
                switch controls a real behaviour.

                2026-08-23 removed it to keep prompts dead ("you should never
                ask if they want to show cards"). That rule stands: this
                toggle asks NOTHING mid-hand. ON (default) keeps the engine's
                muck — a beaten hand stays private. OFF means "always table
                my hand": the client answers the engine's muck ruling with
                the voluntary-show call and the hand turns face up, no
                question asked. The setting can never muck a winner (the
                engine auto-tables winners and ties) and can never hide an
                all-in showdown (every live all-in hand is force-exposed). */}
            <SettingToggle
              label="Auto-Muck Losing Hands"
              description="Keep A Beaten Hand Private At Showdown. Off Always Shows Your Hand"
              checked={settings.autoMuckLosers}
              onChange={() => handleToggle('autoMuckLosers')}
            />

            <SettingToggle
              label="Auto-Post Blinds"
              description="Automatically Post Blinds When In Position"
              checked={settings.autoPostBlinds}
              onChange={() => handleToggle('autoPostBlinds')}
            />

            {/* Dan 2026-08-19, bug list item 12: "do NOT add a confirm-all-in
                button - accept the action." Control removed so it cannot be
                switched back on. Do not reintroduce. */}

            <SettingToggle
              label="Sit Out Next Hand"
              description="Automatically Sit Out After This Hand"
              checked={settings.sitOutNextHand}
              onChange={() => handleToggle('sitOutNextHand')}
            />
          </div>

          {/* Display Section */}
          <div className="stp__section" style={sectionStyle(1)}>
            <h3 className="stp__heading sc-ink--blue">Display</h3>

            {/* FIX 199: Hand strength toggle REMOVED — not allowed for live online gameplay */}

            <SettingToggle
              label="Show Pot Odds"
              description="Display Pot Odds For Decisions"
              checked={settings.showPotOdds}
              onChange={() => handleToggle('showPotOdds')}
            />

            <SettingToggle
              label="Four-Color Deck"
              description="Hearts (Red), Diamonds (Blue), Clubs (Green), Spades (Black)"
              checked={settings.fourColorDeck}
              onChange={() => handleToggle('fourColorDeck')}
            />

            {/* FIX 220: Legacy showStackInBB toggle REMOVED — Bible V8 §11.1
                show_stack_in_bb is now handled by TableSettingsPanel (line ~388)
                which persists to Supabase user_table_settings. Keeping both
                created a duplicate toggle with competing state sources. */}

            <SettingToggle
              label="Bet Size Presets"
              description="Show Quick Bet Size Buttons"
              checked={settings.showBetSizePresets}
              onChange={() => handleToggle('showBetSizePresets')}
            />

            {/* Dan 2026-08-28: "add a toggle in the table settings... to turn
                the ticker on or off." Governs the scrolling tournament and
                announcement marquee at the top of club and table pages. */}
            <SettingToggle
              label="Announcement Ticker"
              description="Show The Scrolling Tournament And Announcement Ticker"
              checked={settings.showTicker}
              onChange={() => handleToggle('showTicker')}
            />

            {/* Three lit words, not a drawn dropdown: the art paints no select.
                Same handler, same three values. Speed SCALES every animation
                (--animation-speed); none of these can switch one off. */}
            <div className="stp__row" role="group" aria-labelledby="stp-animation-speed">
              <div className="stp__info">
                <span id="stp-animation-speed" className="stp__label sc-ink--silver">
                  Animation Speed
                </span>
              </div>
              <div className="stp__choices">
                {(['slow', 'normal', 'fast'] as const).map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    className={`stp-word stp-word--choice ${settings.animationSpeed === speed ? 'sc-ink--white' : 'sc-ink--muted'}`}
                    aria-pressed={settings.animationSpeed === speed}
                    onClick={() => handleSelect('animationSpeed', speed)}
                  >
                    {speed === 'slow' ? 'Slow' : speed === 'normal' ? 'Normal' : 'Fast'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Sound Section */}
          <div className="stp__section" style={sectionStyle(2)}>
            <h3 className="stp__heading sc-ink--blue">Sound</h3>

            <SettingToggle
              label="Sound Effects"
              description="Play Sounds For Actions And Events"
              checked={settings.soundEnabled}
              onChange={() => handleToggle('soundEnabled')}
            />

            {/* THE ONE THING DRAWN. The art paints no slider, so this is the
                only control here that is not a lit word - and it runs UP AND
                DOWN (Dan: "THE SLIDER NEEDS TO GO UP AND DOWN, NOT SIDE TO
                SIDE"). Top is loud. Same key, same range, same disable. */}
            <div className="stp__row stp__row--slider">
              <div className="stp__info">
                <span className="stp__label sc-ink--silver">Volume</span>
                <span className="stp__value sc-ink--blue">{settings.soundVolume}%</span>
              </div>
              <input
                type="range"
                className="settings-item__slider"
                min={0}
                max={100}
                value={settings.soundVolume}
                onChange={(e) => handleSlider('soundVolume', parseInt(e.target.value))}
                disabled={!settings.soundEnabled}
                aria-label="Sound Volume Percent"
                aria-orientation="vertical"
              />
            </div>

            <SettingToggle
              label="Haptic Feedback"
              description="Vibrate On Actions, Wins, And Alerts"
              checked={settings.hapticEnabled}
              onChange={() => handleToggle('hapticEnabled')}
            />
          </div>

          {/* Customization Section */}
          <div className="stp__section" style={sectionStyle(3)}>
            <h3 className="stp__heading sc-ink--blue">Customization</h3>

            {/* Avatar Button */}
            <div className="stp__row">
              <div className="stp__info">
                <span className="stp__label sc-ink--silver">Avatar</span>
                <span className="stp__desc">Change Your Table Avatar</span>
              </div>
              <button
                type="button"
                className="stp-word stp-word--avatar sc-ink--blue"
                onClick={() => setShowAvatarGallery(true)}
                aria-label="Change Avatar"
              >
                <img
                  loading="lazy"
                  decoding="async"
                  src={resolveAvatarDisplay(currentAvatarUrl, userId)}
                  alt=""
                  className="settings-avatar-preview"
                />
                Change
              </button>
            </div>

            <div className="stp__row">
              <div className="stp__info">
                <span className="stp__eyebrow sc-ink--blue">Appearance Suite</span>
                <span className="stp__label sc-ink--silver">Table Studio</span>
                <span className="stp__desc">Tables, Backgrounds, Buttons And Card Backs</span>
              </div>
              <button
                type="button"
                className="stp-word sc-ink--white"
                onClick={() => setShowThemeSettings(true)}
                aria-label="Open Table Studio"
              >
                Open Studio
              </button>
            </div>
          </div>

          {/* ═══════════════════════════════════════════════════════════
              Bible V8 §11.1: User Table Preferences (12 toggles)
          ═══════════════════════════════════════════════════════════ */}
          <div className="stp__section">
            <h3 className="stp__heading sc-ink--blue">Table Preferences</h3>
            <TableSettingsPanel
              settings={v8Settings}
              loading={v8Loading}
              onToggle={v8Toggle}
              mode="inline"
            />
          </div>
        </SpadeConsole>
      </div>

      {/* Avatar Gallery Modal */}
      <AvatarGallery
        isOpen={showAvatarGallery}
        onClose={() => setShowAvatarGallery(false)}
        userId={authUser?.id || userId}
        currentAvatarUrl={currentAvatarUrl}
        isVip={resolvedVip}
        onAvatarChanged={onAvatarChanged}
      />

      {/* Bible V8 §11.2: Theme Settings Modal */}
      <ThemeSettingsModal
        isOpen={showThemeSettings}
        onClose={() => setShowThemeSettings(false)}
        userId={authUser?.id || userId}
        isVip={resolvedVip}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface SettingToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}

/**
 * A switch is a lit word, not a drawn track (#ClubArenaConsole): the art
 * paints no toggle and nothing may be drawn. ON burns green, OFF sits muted.
 * It is a real switch to assistive tech (role, aria-checked, a name), which
 * the hidden checkbox it replaces never was.
 */
function SettingToggle({ label, description, checked, onChange }: SettingToggleProps) {
  const id = `stp-switch-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return (
    <div className="stp__row">
      <div className="stp__info">
        <span className="stp__label sc-ink--silver" id={id}>
          {label}
        </span>
        {description && <span className="stp__desc">{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        className={`stp-word stp-word--switch ${checked ? 'sc-ink--green' : 'sc-ink--muted'}`}
        onClick={onChange}
      >
        {checked ? 'On' : 'Off'}
      </button>
    </div>
  );
}

export default SettingsPanel;
