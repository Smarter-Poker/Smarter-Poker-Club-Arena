/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Settings Page
 * Complete app and gameplay settings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import styles from './SettingsPage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UserSettings {
    // Audio
    soundEnabled: boolean;
    soundVolume: number;
    musicEnabled: boolean;
    musicVolume: number;
    voiceAnnouncements: boolean;

    // Display
    theme: 'dark' | 'light' | 'auto';
    tableColor: string;
    cardBack: string;
    fourColorDeck: boolean;
    animationSpeed: 'slow' | 'normal' | 'fast';
    showBetAmount: boolean;
    showPotOdds: boolean;

    // Gameplay
    autoMuck: boolean;
    autoRebuy: boolean;
    autoRebuyThreshold: number;
    confirmAllIn: boolean;
    showHandStrength: boolean;
    runItTwiceDefault: boolean;
    straddleDefault: boolean;

    // Notifications
    tournamentReminders: boolean;
    clubActivity: boolean;
    handWonNotifications: boolean;
    achievementNotifications: boolean;

    // Privacy
    showOnlineStatus: boolean;
    allowFriendRequests: boolean;
    shareHandHistories: boolean;
}

const DEFAULT_SETTINGS: UserSettings = {
    soundEnabled: true,
    soundVolume: 80,
    musicEnabled: false,
    musicVolume: 50,
    voiceAnnouncements: true,

    theme: 'dark',
    tableColor: 'green',
    cardBack: 'classic',
    fourColorDeck: false,
    animationSpeed: 'normal',
    showBetAmount: true,
    showPotOdds: false,

    autoMuck: true,
    autoRebuy: false,
    autoRebuyThreshold: 50,
    confirmAllIn: true,
    showHandStrength: false,
    runItTwiceDefault: false,
    straddleDefault: false,

    tournamentReminders: true,
    clubActivity: true,
    handWonNotifications: false,
    achievementNotifications: true,

    showOnlineStatus: true,
    allowFriendRequests: true,
    shareHandHistories: false,
};

const TABLE_COLORS = [
    { id: 'green', name: 'Classic Green', color: '#1a5f3a' },
    { id: 'blue', name: 'Ocean Blue', color: '#1e3a5f' },
    { id: 'red', name: 'Casino Red', color: '#5a1a1a' },
    { id: 'purple', name: 'Royal Purple', color: '#3a1a5f' },
    { id: 'black', name: 'Midnight Black', color: '#1a1a1a' },
];

const CARD_BACKS = [
    { id: 'classic', name: 'Classic' },
    { id: 'modern', name: 'Modern' },
    { id: 'minimal', name: 'Minimal' },
    { id: 'premium', name: 'Premium Gold' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const Toggle = ({
    checked,
    onChange,
    label
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
}) => (
    <label className={styles.toggle}>
        <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles.toggleSlider} />
        {label && <span className={styles.toggleLabel}>{label}</span>}
    </label>
);

const Slider = ({
    value,
    onChange,
    min = 0,
    max = 100,
    disabled = false,
}: {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    disabled?: boolean;
}) => (
    <div className={`${styles.sliderContainer} ${disabled ? styles.disabled : ''}`}>
        <input
            type="range"
            className={styles.slider}
            value={value}
            min={min}
            max={max}
            onChange={(e) => onChange(Number(e.target.value))}
            disabled={disabled}
        />
        <span className={styles.sliderValue}>{value}%</span>
    </div>
);

const ColorPicker = ({
    options,
    selected,
    onChange,
}: {
    options: typeof TABLE_COLORS;
    selected: string;
    onChange: (id: string) => void;
}) => (
    <div className={styles.colorPicker}>
        {options.map((option) => (
            <button
                key={option.id}
                className={`${styles.colorOption} ${selected === option.id ? styles.selected : ''}`}
                style={{ backgroundColor: option.color }}
                onClick={() => onChange(option.id)}
                title={option.name}
            />
        ))}
    </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function SettingsPage() {
    const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
    const [hasChanges, setHasChanges] = useState(false);
    const [saving, setSaving] = useState(false);

    // Load settings from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('club-arena-settings');
        if (saved) {
            try {
                setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        }
    }, []);

    const updateSetting = <K extends keyof UserSettings>(
        key: K,
        value: UserSettings[K]
    ) => {
        setSettings(prev => ({ ...prev, [key]: value }));
        setHasChanges(true);
    };

    const saveSettings = async () => {
        setSaving(true);
        try {
            localStorage.setItem('club-arena-settings', JSON.stringify(settings));
            // Would also sync to server here
            await new Promise(r => setTimeout(r, 500));
            setHasChanges(false);
        } finally {
            setSaving(false);
        }
    };

    const resetSettings = () => {
        if (confirm('Reset all settings to defaults?')) {
            setSettings(DEFAULT_SETTINGS);
            setHasChanges(true);
        }
    };

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1>⚙️ Settings</h1>
                <div className={styles.headerActions}>
                    {hasChanges && (
                        <button
                            className={styles.saveButton}
                            onClick={saveSettings}
                            disabled={saving}
                        >
                            {saving ? 'Saving...' : 'Save Changes'}
                        </button>
                    )}
                    <button className={styles.resetButton} onClick={resetSettings}>
                        Reset
                    </button>
                </div>
            </header>

            <div className={styles.content}>
                {/* Audio Settings */}
                <section className={styles.section}>
                    <h2>🔊 Audio</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Sound Effects</span>
                            <span className={styles.settingDesc}>Play sounds for actions and events</span>
                        </div>
                        <Toggle
                            checked={settings.soundEnabled}
                            onChange={(v) => updateSetting('soundEnabled', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Sound Volume</span>
                        </div>
                        <Slider
                            value={settings.soundVolume}
                            onChange={(v) => updateSetting('soundVolume', v)}
                            disabled={!settings.soundEnabled}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Background Music</span>
                        </div>
                        <Toggle
                            checked={settings.musicEnabled}
                            onChange={(v) => updateSetting('musicEnabled', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Voice Announcements</span>
                            <span className={styles.settingDesc}>Announce actions, pot sizes, and winners</span>
                        </div>
                        <Toggle
                            checked={settings.voiceAnnouncements}
                            onChange={(v) => updateSetting('voiceAnnouncements', v)}
                        />
                    </div>
                </section>

                {/* Display Settings */}
                <section className={styles.section}>
                    <h2>🎨 Display</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Theme</span>
                        </div>
                        <select
                            className={styles.select}
                            value={settings.theme}
                            onChange={(e) => updateSetting('theme', e.target.value as UserSettings['theme'])}
                        >
                            <option value="dark">Dark</option>
                            <option value="light">Light</option>
                            <option value="auto">Auto (System)</option>
                        </select>
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Table Felt Color</span>
                        </div>
                        <ColorPicker
                            options={TABLE_COLORS}
                            selected={settings.tableColor}
                            onChange={(v) => updateSetting('tableColor', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Card Back Style</span>
                        </div>
                        <select
                            className={styles.select}
                            value={settings.cardBack}
                            onChange={(e) => updateSetting('cardBack', e.target.value)}
                        >
                            {CARD_BACKS.map(back => (
                                <option key={back.id} value={back.id}>{back.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Four-Color Deck</span>
                            <span className={styles.settingDesc}>Hearts ♥, Diamonds ♦ (blue), Clubs ♣ (green), Spades ♠</span>
                        </div>
                        <Toggle
                            checked={settings.fourColorDeck}
                            onChange={(v) => updateSetting('fourColorDeck', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Animation Speed</span>
                        </div>
                        <select
                            className={styles.select}
                            value={settings.animationSpeed}
                            onChange={(e) => updateSetting('animationSpeed', e.target.value as UserSettings['animationSpeed'])}
                        >
                            <option value="slow">Slow</option>
                            <option value="normal">Normal</option>
                            <option value="fast">Fast</option>
                        </select>
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Show Pot Odds</span>
                            <span className={styles.settingDesc}>Display pot odds during your action</span>
                        </div>
                        <Toggle
                            checked={settings.showPotOdds}
                            onChange={(v) => updateSetting('showPotOdds', v)}
                        />
                    </div>
                </section>

                {/* Gameplay Settings */}
                <section className={styles.section}>
                    <h2>🎮 Gameplay</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Auto Muck Losing Hands</span>
                            <span className={styles.settingDesc}>Automatically muck when you lose at showdown</span>
                        </div>
                        <Toggle
                            checked={settings.autoMuck}
                            onChange={(v) => updateSetting('autoMuck', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Confirm All-In</span>
                            <span className={styles.settingDesc}>Require confirmation before going all-in</span>
                        </div>
                        <Toggle
                            checked={settings.confirmAllIn}
                            onChange={(v) => updateSetting('confirmAllIn', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Auto Rebuy</span>
                            <span className={styles.settingDesc}>Automatically rebuy when stack falls below threshold</span>
                        </div>
                        <Toggle
                            checked={settings.autoRebuy}
                            onChange={(v) => updateSetting('autoRebuy', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Run It Twice (Default)</span>
                            <span className={styles.settingDesc}>Auto-accept when offered</span>
                        </div>
                        <Toggle
                            checked={settings.runItTwiceDefault}
                            onChange={(v) => updateSetting('runItTwiceDefault', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Straddle (Default)</span>
                            <span className={styles.settingDesc}>Auto-post straddle when UTG</span>
                        </div>
                        <Toggle
                            checked={settings.straddleDefault}
                            onChange={(v) => updateSetting('straddleDefault', v)}
                        />
                    </div>
                </section>

                {/* Notifications */}
                <section className={styles.section}>
                    <h2>🔔 Notifications</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Tournament Reminders</span>
                            <span className={styles.settingDesc}>Notify before registered tournaments start</span>
                        </div>
                        <Toggle
                            checked={settings.tournamentReminders}
                            onChange={(v) => updateSetting('tournamentReminders', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Club Activity</span>
                            <span className={styles.settingDesc}>New tables, tournaments, and announcements</span>
                        </div>
                        <Toggle
                            checked={settings.clubActivity}
                            onChange={(v) => updateSetting('clubActivity', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Achievement Unlocked</span>
                        </div>
                        <Toggle
                            checked={settings.achievementNotifications}
                            onChange={(v) => updateSetting('achievementNotifications', v)}
                        />
                    </div>
                </section>

                {/* Privacy */}
                <section className={styles.section}>
                    <h2>🔒 Privacy</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Show Online Status</span>
                            <span className={styles.settingDesc}>Let others see when you're online</span>
                        </div>
                        <Toggle
                            checked={settings.showOnlineStatus}
                            onChange={(v) => updateSetting('showOnlineStatus', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Allow Friend Requests</span>
                        </div>
                        <Toggle
                            checked={settings.allowFriendRequests}
                            onChange={(v) => updateSetting('allowFriendRequests', v)}
                        />
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Share Hand Histories</span>
                            <span className={styles.settingDesc}>Allow others to view your shared hand replays</span>
                        </div>
                        <Toggle
                            checked={settings.shareHandHistories}
                            onChange={(v) => updateSetting('shareHandHistories', v)}
                        />
                    </div>
                </section>

                {/* Account */}
                <section className={styles.section}>
                    <h2>👤 Account</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Email</span>
                            <span className={styles.settingDesc}>player@example.com</span>
                        </div>
                        <button className={styles.actionButton}>Change</button>
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Password</span>
                        </div>
                        <button className={styles.actionButton}>Change</button>
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Two-Factor Authentication</span>
                            <span className={styles.settingDesc}>Add extra security to your account</span>
                        </div>
                        <button className={styles.actionButton}>Enable</button>
                    </div>
                </section>

                {/* Danger Zone */}
                <section className={`${styles.section} ${styles.dangerZone}`}>
                    <h2>⚠️ Danger Zone</h2>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Export Data</span>
                            <span className={styles.settingDesc}>Download all your data and hand histories</span>
                        </div>
                        <button className={styles.actionButtonSecondary}>Export</button>
                    </div>

                    <div className={styles.settingRow}>
                        <div className={styles.settingInfo}>
                            <span className={styles.settingLabel}>Delete Account</span>
                            <span className={styles.settingDesc}>Permanently delete your account and all data</span>
                        </div>
                        <button className={styles.dangerButton}>Delete</button>
                    </div>
                </section>
            </div>
        </div>
    );
}
