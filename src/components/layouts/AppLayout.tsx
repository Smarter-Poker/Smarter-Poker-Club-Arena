/**
 * 🎰 CLUB ENGINE — App Layout
 * Main shell layout with navigation
 */

import { Outlet, NavLink } from 'react-router-dom';
import { useState } from 'react';
import styles from './AppLayout.module.css';
import ClubArenaWelcomeModal, { useClubArenaWelcome } from '../modals/ClubArenaWelcomeModal';

export default function AppLayout() {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const { showWelcome, isReady, acceptWelcome } = useClubArenaWelcome();

    return (
        <div className={styles.layout}>
            {/* First-time Welcome Modal */}
            {isReady && (
                <ClubArenaWelcomeModal
                    isOpen={showWelcome}
                    onAccept={acceptWelcome}
                />
            )}

            {/* Header */}
            <header className={styles.header}>
                <div className={styles.headerContent}>
                    {/* Logo */}
                    <NavLink to="/" className={styles.logo}>
                        <span className={styles.logoIcon}>♠</span>
                        <span className={styles.logoText}>ClubEngine</span>
                    </NavLink>

                    {/* Desktop Navigation */}
                    <nav className={styles.nav}>
                        <NavLink
                            to="/"
                            className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}
                        >
                            🎰 Lobby
                        </NavLink>
                        <NavLink
                            to="/clubs"
                            className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}
                        >
                            🏛️ Clubs
                        </NavLink>
                        <NavLink
                            to="/profile"
                            className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}
                        >
                            👤 Profile
                        </NavLink>
                    </nav>

                    {/* User Actions */}
                    <div className={styles.userActions}>
                        <div className={styles.chipBalance}>
                            <span className={styles.chipIcon}>💰</span>
                            <span className={styles.chipAmount}>0</span>
                        </div>
                        <button className={styles.settingsButton}>
                            ⚙️
                        </button>
                    </div>

                    {/* Mobile Menu Toggle */}
                    <button
                        className={styles.mobileMenuToggle}
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                    >
                        {isMobileMenuOpen ? '✕' : '☰'}
                    </button>
                </div>

                {/* Mobile Navigation */}
                {isMobileMenuOpen && (
                    <nav className={styles.mobileNav}>
                        <NavLink
                            to="/"
                            className={styles.mobileNavLink}
                            onClick={() => setIsMobileMenuOpen(false)}
                        >
                            🎰 Lobby
                        </NavLink>
                        <NavLink
                            to="/clubs"
                            className={styles.mobileNavLink}
                            onClick={() => setIsMobileMenuOpen(false)}
                        >
                            🏛️ Clubs
                        </NavLink>
                        <NavLink
                            to="/profile"
                            className={styles.mobileNavLink}
                            onClick={() => setIsMobileMenuOpen(false)}
                        >
                            👤 Profile
                        </NavLink>
                        <NavLink
                            to="/settings"
                            className={styles.mobileNavLink}
                            onClick={() => setIsMobileMenuOpen(false)}
                        >
                            ⚙️ Settings
                        </NavLink>
                    </nav>
                )}
            </header>

            {/* Main Content */}
            <main className={styles.main}>
                <Outlet />
            </main>

            {/* Footer */}
            <footer className={styles.footer}>
                <p>Club Engine © 2026 — PokerBros Clone, But Better</p>
            </footer>
        </div>
    );
}

