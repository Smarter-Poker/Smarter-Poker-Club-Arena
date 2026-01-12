/**
 * ♠ CLUB ARENA — Profile Page
 * User profile with stats and settings
 */

import { Link } from 'react-router-dom';
import { useUserStore } from '../stores/useUserStore';
import './ProfilePage.css';

const MOCK_STATS = {
    // Keep stats mock for now as backend doesn't aggregate them yet
    totalHands: 15420,
    vpip: 24.5,
    pfr: 18.2,
    bbPer100: 4.2,
    biggestPot: 1250,
    totalProfit: 8540,
    clubs: 3,
    gamesPlayed: 234,
};

export default function ProfilePage() {
    const { user, totalChips } = useUserStore();

    // Fallback if not logged in
    const displayUser = user || { username: 'Guest Player', avatar_url: null };
    const displayChips = user ? totalChips : 0;

    return (
        <div className="profile-page">
            {/* Profile Header */}
            <header className="profile-header">
                <div className="profile-avatar">
                    {displayUser.avatar_url || '👤'}
                    <span className="vip-badge">GOLD</span>
                </div>
                <div className="profile-info">
                    <h1>{displayUser.username}</h1>
                    <p>Member since 2025</p>
                </div>
                <div className="profile-chips">
                    <span className="chips-icon">💰</span>
                    <span className="chips-amount">{displayChips.toLocaleString()}</span>
                    <span className="chips-label">Chips</span>
                </div>
                <Link to="/settings" className="btn btn-ghost settings-link">
                    ⚙️ Settings
                </Link>
            </header>

            {/* Stats Grid */}
            <section className="stats-section">
                <h2>Career Statistics</h2>
                <div className="stats-grid">
                    <div className="stat-card">
                        <span className="stat-value">{MOCK_STATS.totalHands.toLocaleString()}</span>
                        <span className="stat-label">Hands Played</span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-value">{MOCK_STATS.vpip}%</span>
                        <span className="stat-label">VPIP</span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-value">{MOCK_STATS.pfr}%</span>
                        <span className="stat-label">PFR</span>
                    </div>
                    <div className="stat-card">
                        <span className={`stat-value ${MOCK_STATS.bbPer100 > 0 ? 'positive' : 'negative'}`}>
                            {MOCK_STATS.bbPer100 > 0 ? '+' : ''}{MOCK_STATS.bbPer100}
                        </span>
                        <span className="stat-label">BB/100</span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-value">${MOCK_STATS.biggestPot}</span>
                        <span className="stat-label">Biggest Pot</span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-value positive">+${MOCK_STATS.totalProfit.toLocaleString()}</span>
                        <span className="stat-label">Total Profit</span>
                    </div>
                </div>
            </section>

            {/* Quick Stats */}
            <section className="quick-stats">
                <div className="quick-stat">
                    <span className="quick-icon">🏛️</span>
                    <span className="quick-value">{MOCK_STATS.clubs}</span>
                    <span className="quick-label">Clubs Joined</span>
                </div>
                <div className="quick-stat">
                    <span className="quick-icon">🎰</span>
                    <span className="quick-value">{MOCK_STATS.gamesPlayed}</span>
                    <span className="quick-label">Games Played</span>
                </div>
            </section>
        </div>
    );
}
