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
  showHandStrength: boolean;
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
  onCardBackChanged?: (id: string) => void;
  onCardBackPurchase?: (id: string, price: number) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_TABLE_SETTINGS: TableSettings = {
  autoMuckLosers: true,
  autoMuckWinners: false,
  autoPostBlinds: true,
  soundEnabled: true,
  soundVolume: 70,
  hapticEnabled: true,
  showHandStrength: true,
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

            <SettingToggle
              label="Auto-muck losing hands"
              description="Automatically fold losing hands at showdown"
              checked={settings.autoMuckLosers}
              onChange={() => handleToggle('autoMuckLosers')}
            />

            <SettingToggle
              label="Auto-muck winning hands"
              description="Don't show cards when winning uncontested"
              checked={settings.autoMuckWinners}
              onChange={() => handleToggle('autoMuckWinners')}
            />

            <SettingToggle
              label="Auto-post blinds"
              description="Automatically post blinds when in position"
              checked={settings.autoPostBlinds}
              onChange={() => handleToggle('autoPostBlinds')}
            />

            <SettingToggle
              label="Confirm all-in"
              description="Show confirmation before going all-in"
              checked={settings.confirmAllIn}
              onChange={() => handleToggle('confirmAllIn')}
            />

            <SettingToggle
              label="Sit out next hand"
              description="Automatically sit out after this hand"
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

            <SettingToggle
              label="Show hand strength"
              description="Display current hand rank"
              checked={settings.showHandStrength}
              onChange={() => handleToggle('showHandStrength')}
            />

            <SettingToggle
              label="Show pot odds"
              description="Display pot odds for decisions"
              checked={settings.showPotOdds}
              onChange={() => handleToggle('showPotOdds')}
            />

            <SettingToggle
              label="Four-color deck"
              description="Hearts (Red), Diamonds (Blue), Clubs (Green), Spades (Black)"
              checked={settings.fourColorDeck}
              onChange={() => handleToggle('fourColorDeck')}
            />

            <SettingToggle
              label="Show stack in BBs"
              description="Display chip counts as big blinds"
              checked={settings.showStackInBB}
              onChange={() => handleToggle('showStackInBB')}
            />

            <SettingToggle
              label="Bet size presets"
              description="Show quick bet size buttons"
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
              label="Sound effects"
              description="Play sounds for actions and events"
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
              />
            </div>

            <SettingToggle
              label="Haptic feedback"
              description="Vibrate on actions, wins, and alerts"
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
                <span className="settings-item__description">Change your table avatar</span>
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
            Reset to Defaults
          </button>
        </div>
      </div>

      {/* Avatar Gallery Modal */}
      <AvatarGallery
        isOpen={showAvatarGallery}
        onClose={() => setShowAvatarGallery(false)}
        userId={userId}
        currentAvatarUrl={currentAvatarUrl}
        isVip={isVip}
        onAvatarChanged={onAvatarChanged}
      />

      {/* Bible V8 §11.2: Theme Settings Modal */}
      <ThemeSettingsModal
        isOpen={showThemeSettings}
        onClose={() => setShowThemeSettings(false)}
        userId={authUser?.id || userId}
        vipLevel={isVip ? 'gold' : 'free'}
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
