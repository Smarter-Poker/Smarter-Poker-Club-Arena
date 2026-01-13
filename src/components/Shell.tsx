/**
 * ♠ CLUB ARENA — Shell Layout
 * Main app shell with header and navigation
 */

import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUserStore } from '../stores/useUserStore';
import './Shell.css';

export default function Shell() {
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const location = useLocation();
    const navigate = useNavigate();

    // Store
    const { theme } = useSettingsStore();
    const { user, totalChips } = useUserStore();

    // Sync Theme
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    return (
        <div className="shell">
            {/* Header */}
            <header className="shell-header">
                <div className="shell-header-content">
                    {/* Logo */}
                    <NavLink to="/" className="shell-logo">
                        <span className="shell-logo-icon">♠</span>
                        <span className="shell-logo-text">Club Arena</span>
                    </NavLink>

                    {/* Desktop Nav */}
                    <nav className="shell-nav">
                        <NavLink
                            to="/"
                            className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
                            end
                        >
                            🏠 Home
                        </NavLink>
                        <NavLink
                            to="/play"
                            className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
                        >
                            🎰 Play
                        </NavLink>
                        <NavLink
                            to="/clubs"
                            className={({ isActive }) => `shell-nav-link ${isActive || location.pathname.startsWith('/clubs') ? 'active' : ''}`}
                        >
                            🏛️ Clubs
                        </NavLink>
                        <NavLink
                            to="/unions"
                            className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
                        >
                            🤝 Unions
                        </NavLink>
                        <NavLink
                            to="/profile"
                            className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
                        >
                            👤 Profile
                        </NavLink>
                    </nav>

                    {/* User Info */}
                    <div className="shell-user">
                        <div className="shell-chips">
                            <span className="chip-icon">💰</span>
                            <span className="chip-amount">{user ? totalChips.toLocaleString() : '0'}</span>
                        </div>
                        <button className="shell-avatar" onClick={() => navigate('/profile')}>
                            {user?.avatar_url || '👤'}
                        </button>
                    </div>

                    {/* Mobile Toggle */}
                    <button
                        className="shell-mobile-toggle"
                        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    >
                        {mobileMenuOpen ? '✕' : '☰'}
                    </button>
                </div>

                {/* Mobile Nav */}
                {mobileMenuOpen && (
                    <nav className="shell-mobile-nav">
                        <NavLink to="/" onClick={() => setMobileMenuOpen(false)}>🏠 Home</NavLink>
                        <NavLink to="/play" onClick={() => setMobileMenuOpen(false)}>🎰 Play</NavLink>
                        <NavLink to="/clubs" onClick={() => setMobileMenuOpen(false)}>🏛️ Clubs</NavLink>
                        <NavLink to="/unions" onClick={() => setMobileMenuOpen(false)}>🤝 Unions</NavLink>
                        <NavLink to="/profile" onClick={() => setMobileMenuOpen(false)}>👤 Profile</NavLink>
                    </nav>
                )}
            </header>

            {/* Main Content */}
            <main className="shell-main">
                <Outlet />
            </main>

            {/* Footer */}
            <footer className="shell-footer">
                <p>♠ Club Arena © 2026 — PokerBros Clone + Better</p>
            </footer>
        </div>
    );
}
