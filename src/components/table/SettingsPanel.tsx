/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTINGS PANEL — Table Preferences
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Slide-out settings panel for:
 * - Auto-muck losing hands
 * - Sound controls
 * - Card display preferences
 * - Animation speed
 */

import React, { useState, useEffect, useCallback } from 'react';
import { CardBackSelector } from '../customization/CardBackSelector';
import { AvatarGallery } from '../customization/AvatarGallery';
import { TableSettingsPanel } from './TableSettingsPanel';
import { ThemeSettingsModal } from './ThemeSettingsModal';
import { useUserTableSettings } from '../../hooks/useUserTableSettings';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
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
  tableTheme: string;
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
  userDiamonds?: number;
  currentCardBack?: string;
  ownedCardBacks?: string[];
  onAvatarChanged?: (url: string) => void;
  /* Both may be async and may reject. CardBackSelector awaits them before it
     reports success, so a failed write cannot show as a success. */
  onCardBackChanged?: (id: string) => void | Promise<unknown>;
  onCardBackPurchase?: (id: string, price: number) => void | Promise<unknown>;
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
  tableTheme: 'black',
};

/** Available table themes from design-tokens.css */
const TABLE_THEMES = [
  { value: 'green', label: 'Classic Green' },
  { value: 'blue', label: 'Ocean Blue' },
  { value: 'red', label: 'Ruby Red' },
  { value: 'purple', label: 'Royal Purple' },
  { value: 'black', label: 'Midnight Black' },
  { value: 'gold', label: 'VIP Gold' },
  { value: 'light', label: 'Light Mode' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SettingsPanel({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  userId = '',
  currentAvatarUrl = '/avatars/default-player.png',
  isVip = false,
  userDiamonds = 0,
  currentCardBack = 'black',
  ownedCardBacks = [],
  onAvatarChanged,
  onCardBackChanged,
  onCardBackPurchase,
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
    onSettingsChange(DEFAULT_TABLE_SETTINGS);
  }, [onSettingsChange]);

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-panel__header">
          <h2 className="settings-panel__title">Table Settings</h2>
          <button className="settings-panel__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Settings Sections */}
        <div className="settings-panel__body">
          {/* Gameplay Section */}
          <div
            className="settings-section"
            style={{
              opacity: visibleSections[0] ? 1 : 0,
              transform: visibleSections[0] ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <h3 className="settings-section__title">Gameplay</h3>

            {/* ── Dan 2026-08-18: auto-muck covers UNCONTESTED pots only ──
                "Auto-muck losing hands / Automatically fold losing hands at
                showdown" is gone. It was a dead switch - it wrote the
                `autoMuck` key, which nothing at the table ever read - and as of
                today it also promised the opposite of how the game behaves: a
                showdown turns EVERY hand face up, so there is no such thing as
                auto-mucking a loser any more. A toggle that says it will hide
                your cards at showdown and then shows them is worse than no
                toggle at all.

                What remains is the one case where hiding is genuinely the
                player's call: winning when everyone folds. No showdown
                happened, so nobody is entitled to see the hand. The label says
                so explicitly, and says what it does NOT cover. */}
            {/* Dan 2026-08-23: "auto muck should be on by default, you should
                never ask if they want to show cards." The toggle is removed
                rather than merely defaulted, for the same reason the
                confirm-all-in control was removed a few days earlier: a
                default is a suggestion, and a control that can restore a
                behaviour Dan asked to be gone will eventually restore it.
                `autoMuckWinners` stays in the settings type and is pinned true
                so any stored `false` from before today has nothing to switch
                on — TablePage no longer reads it to decide whether to ask. */}

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
          <div
            className="settings-section"
            style={{
              opacity: visibleSections[1] ? 1 : 0,
              transform: visibleSections[1] ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <h3 className="settings-section__title">Display</h3>

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

            <div className="settings-item">
              <div className="settings-item__info">
                <span className="settings-item__label">Animation Speed</span>
              </div>
              <div className="settings-item__select">
                <select
                  value={settings.animationSpeed}
                  onChange={(e) => handleSelect('animationSpeed', e.target.value)}
                >
                  <option value="slow">Slow</option>
                  <option value="normal">Normal</option>
                  <option value="fast">Fast</option>
                </select>
              </div>
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <span className="settings-item__label">Table Theme</span>
              </div>
              <div className="settings-item__select">
                <select
                  value={settings.tableTheme}
                  onChange={(e) => handleSelect('tableTheme', e.target.value)}
                >
                  {TABLE_THEMES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Sound Section */}
          <div
            className="settings-section"
            style={{
              opacity: visibleSections[2] ? 1 : 0,
              transform: visibleSections[2] ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <h3 className="settings-section__title">Sound</h3>

            <SettingToggle
              label="Sound Effects"
              description="Play Sounds For Actions And Events"
              checked={settings.soundEnabled}
              onChange={() => handleToggle('soundEnabled')}
            />

            <div className="settings-item">
              <div className="settings-item__info">
                <span className="settings-item__label">Volume</span>
                <span className="settings-item__value">{settings.soundVolume}%</span>
              </div>
              <input
                type="range"
                className="settings-item__slider"
                min={0}
                max={100}
                value={settings.soundVolume}
                onChange={(e) => handleSlider('soundVolume', parseInt(e.target.value))}
                disabled={!settings.soundEnabled}
                aria-label="Sound volume percent"
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
          <div
            className="settings-section"
            style={{
              opacity: visibleSections[3] ? 1 : 0,
              transform: visibleSections[3] ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <h3 className="settings-section__title">Customization</h3>

            {/* Avatar Button */}
            <div className="settings-item settings-item--action">
              <div className="settings-item__info">
                <span className="settings-item__label">Avatar</span>
                <span className="settings-item__description">Change Your Table Avatar</span>
              </div>
              <button className="settings-action-btn" onClick={() => setShowAvatarGallery(true)}>
                <img
                  loading="lazy"
                  decoding="async"
                  src={currentAvatarUrl}
                  alt="Avatar"
                  className="settings-avatar-preview"
                />
                Change
              </button>
            </div>

            {/* Card Back Selector */}
            <CardBackSelector
              currentCardBack={currentCardBack}
              ownedCardBacks={ownedCardBacks}
              userDiamonds={userDiamonds}
              /* 2026-08-25: the store gated paid designs on a purchase alone
                 while Theme Settings gated the same designs on VIP alone, so a
                 VIP was quoted a price here for something that was already
                 theirs one modal across. Same resolvedVip both places. */
              isVip={resolvedVip}
              onChange={onCardBackChanged}
              onPurchase={onCardBackPurchase}
            />
          </div>

          {/* ═══════════════════════════════════════════════════════════
              Bible V8 §11.1: User Table Preferences (12 toggles)
          ═══════════════════════════════════════════════════════════ */}
          <div className="settings-section">
            <h3 className="settings-section__title">Table Preferences</h3>
            <TableSettingsPanel
              settings={v8Settings}
              loading={v8Loading}
              onToggle={v8Toggle}
              mode="inline"
              onOpenThemeSettings={() => setShowThemeSettings(true)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="settings-panel__footer">
          <button className="settings-panel__reset" onClick={handleReset}>
            Reset To Defaults
          </button>
        </div>
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

function SettingToggle({ label, description, checked, onChange }: SettingToggleProps) {
  return (
    <label className="settings-item settings-item--toggle">
      <div className="settings-item__info">
        <span className="settings-item__label">{label}</span>
        {description && <span className="settings-item__description">{description}</span>}
      </div>
      <div className="settings-toggle">
        <input type="checkbox" checked={checked} onChange={onChange} />
        <span className="settings-toggle__slider" />
      </div>
    </label>
  );
}

export default SettingsPanel;
