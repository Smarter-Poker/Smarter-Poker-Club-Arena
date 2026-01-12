/**
 * ♠ CLUB ARENA — Settings Page
 * Global application preferences
 */

import { Link } from 'react-router-dom';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUserStore } from '../stores/useUserStore';
import './SettingsPage.css';

export default function SettingsPage() {
    const settings = useSettingsStore();
    const { user, logout } = useUserStore();

    return (
        <div className="settings-page">
            <header className="settings-header">
                <Link to="/profile" className="back-link" style={{ display: 'block', marginBottom: '1rem' }}>
                    ← Back to Profile
                </Link>
                <h1>⚙️ Settings</h1>
                <p>Customize your Club Arena experience</p>
            </header>

            {/* Gameplay Settings */}
            <section className="settings-section">
                <h2>Gameplay</h2>
                <div className="settings-list">
                    <div className="setting-item">
                        <div className="setting-info">
                            <span>Sound Effects</span>
                            <span className="setting-description">Play sounds for checks, bets, and wins</span>
                        </div>
                        <input
                            type="checkbox"
                            className="toggle-switch"
                            checked={settings.soundEnabled}
                            onChange={settings.toggleSound}
                        />
                    </div>

                    <div className="setting-item">
                        <div className="setting-info">
                            <span>4-Color Deck</span>
                            <span className="setting-description">Use four colors for card suits (♣ Green, ♦ Blue)</span>
                        </div>
                        <input
                            type="checkbox"
                            className="toggle-switch"
                            checked={settings.fourColorDeck}
                            onChange={settings.toggleFourColorDeck}
                        />
                    </div>
                </div>
            </section>

            {/* Account Settings */}
            <section className="settings-section">
                <h2>Account</h2>
                <div className="settings-list">
                    <div className="setting-item">
                        <div className="setting-info">
                            <span>Notifications</span>
                            <span className="setting-description">Receive alerts for turn actions and tournament invites</span>
                        </div>
                        <input
                            type="checkbox"
                            className="toggle-switch"
                            checked={settings.notificationsEnabled}
                            onChange={settings.toggleNotifications}
                        />
                    </div>

                    <div className="setting-item">
                        <div className="setting-info">
                            <span>Theme</span>
                            <span className="setting-description">Toggle between Light and Dark mode</span>
                        </div>
                        <button
                            className="btn-setting"
                            onClick={() => settings.setTheme(settings.theme === 'dark' ? 'light' : 'dark')}
                        >
                            {settings.theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
                        </button>
                    </div>

                    <div className="setting-item">
                        <div className="setting-info">
                            <span>Account Status</span>
                            <span className="setting-description">{user ? `Logged in as ${user.username}` : 'Guest Mode'}</span>
                        </div>
                        {user ? (
                            <button className="btn-setting" onClick={logout} style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                                Log Out
                            </button>
                        ) : (
                            <Link to="/play" className="btn-setting">Log In</Link>
                        )}
                    </div>
                </div>
            </section>

            <div className="version-info">
                Club Arena v1.0.0 • Build 2026.01.12
            </div>
        </div>
    );
}
