/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚙️ SETTINGS PANEL — Table Preferences
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Slide-out settings panel for:
 * - Auto-muck losing hands
 * - Sound controls
 * - Card display preferences
 * - Animation speed
 */

import React, { useState, useCallback } from 'react';
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
    showHandStrength: boolean;
    showPotOdds: boolean;
    animationSpeed: 'slow' | 'normal' | 'fast';
    fourColorDeck: boolean;
    showBetSizePresets: boolean;
    confirmAllIn: boolean;
    sitOutNextHand: boolean;
}

export interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    settings: TableSettings;
    onSettingsChange: (settings: Partial<TableSettings>) => void;
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
    showHandStrength: true,
    showPotOdds: false,
    animationSpeed: 'normal',
    fourColorDeck: false,
    showBetSizePresets: true,
    confirmAllIn: true,
    sitOutNextHand: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SettingsPanel({
    isOpen,
    onClose,
    settings,
    onSettingsChange,
}: SettingsPanelProps) {
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
                    <button className="settings-panel__close" onClick={onClose}>×</button>
                </div>

                {/* Settings Sections */}
                <div className="settings-panel__body">
                    {/* Gameplay Section */}
                    <div className="settings-section">
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
                    <div className="settings-section">
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
                            description="Use different colors for each suit"
                            checked={settings.fourColorDeck}
                            onChange={() => handleToggle('fourColorDeck')}
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
                    </div>

                    {/* Sound Section */}
                    <div className="settings-section">
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
                    </div>
                </div>

                {/* Footer */}
                <div className="settings-panel__footer">
                    <button className="settings-panel__reset" onClick={handleReset}>
                        Reset to Defaults
                    </button>
                </div>
            </div>
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
