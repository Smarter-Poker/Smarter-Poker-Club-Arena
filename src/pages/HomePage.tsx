/**
 * ♠ CLUB ARENA — Home Page
 * Welcome page with quick actions and featured clubs
 */

import { Link } from 'react-router-dom';
import './HomePage.css';

export default function HomePage() {
    return (
        <div className="home-page">
            {/* Hero */}
            <section className="home-hero">
                <div className="home-hero-content">
                    <h1 className="home-title">
                        <span className="home-icon">♠</span>
                        Club Arena
                    </h1>
                    <p className="home-subtitle">
                        Private poker clubs, better than PokerBros.
                    </p>
                    <p className="home-description">
                        Join private clubs, play real poker, build your bankroll.
                        All the features you love, with a modern experience.
                    </p>
                    <div className="home-actions">
                        <Link to="/play" className="btn btn-primary btn-lg">
                            🎰 Play Demo
                        </Link>
                        <Link to="/clubs" className="btn btn-ghost btn-lg">
                            🏛️ Browse Clubs
                        </Link>
                    </div>
                </div>
                <div className="home-hero-visual">
                    <div className="floating-cards">
                        <div className="poker-card card-1">A♠</div>
                        <div className="poker-card card-2">K♠</div>
                        <div className="poker-card card-3">Q♠</div>
                    </div>
                </div>
            </section>

            {/* Features */}
            <section className="home-features">
                <h2>Why Club Arena?</h2>
                <div className="features-grid">
                    <div className="feature-card">
                        <span className="feature-icon">🏛️</span>
                        <h3>Private Clubs</h3>
                        <p>Create or join private clubs with your friends. Full control over games and settings.</p>
                    </div>
                    <div className="feature-card">
                        <span className="feature-icon">🤝</span>
                        <h3>Unions</h3>
                        <p>Join club networks for more player liquidity and bigger games.</p>
                    </div>
                    <div className="feature-card">
                        <span className="feature-icon">🎰</span>
                        <h3>All Game Types</h3>
                        <p>NLH, PLO4/5/6, OFC, Short Deck, Tournaments, SNGs, and more.</p>
                    </div>
                    <div className="feature-card">
                        <span className="feature-icon">⚡</span>
                        <h3>Modern Experience</h3>
                        <p>Fast, responsive, multi-table support. Play on any device.</p>
                    </div>
                    <div className="feature-card">
                        <span className="feature-icon">🛡️</span>
                        <h3>Fair Play</h3>
                        <p>Certified RNG, anti-cheat systems, GPS/IP restrictions.</p>
                    </div>
                    <div className="feature-card">
                        <span className="feature-icon">📊</span>
                        <h3>Full Stats</h3>
                        <p>Track VPIP, PFR, ROI, and more. Hand history for analysis.</p>
                    </div>
                </div>
            </section>

            {/* Quick Stats */}
            <section className="home-stats">
                <div className="stat-card">
                    <div className="stat-value">1,234</div>
                    <div className="stat-label">Active Clubs</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">45,678</div>
                    <div className="stat-label">Players Online</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">2,345</div>
                    <div className="stat-label">Tables Running</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">12.5M</div>
                    <div className="stat-label">Chips In Play</div>
                </div>
            </section>
        </div>
    );
}
