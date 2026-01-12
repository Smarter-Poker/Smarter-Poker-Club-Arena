/**
 * ♠ CLUB ARENA — App Shell Layout
 * Mobile-first layout with bottom navigation (PokerBros style)
 */

import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import './AppShell.css';

interface AppShellProps {
    children: ReactNode;
    clubId?: string;
    clubName?: string;
    showBottomNav?: boolean;
}

type NavItem = {
    id: string;
    label: string;
    icon: string;
    path: string;
};

export default function AppShell({
    children,
    clubId,
    clubName = 'Club Arena',
    showBottomNav = true
}: AppShellProps) {
    const location = useLocation();
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    // Bottom navigation items (Club Admin view)
    const navItems: NavItem[] = [
        { id: 'messages', label: 'Messages', icon: '✉️', path: `/club/${clubId}/messages` },
        { id: 'players', label: 'Players', icon: '👥', path: `/club/${clubId}/members` },
        { id: 'cashier', label: 'Cashier', icon: '💰', path: `/club/${clubId}/cashier` },
        { id: 'data', label: 'Data', icon: '📊', path: `/club/${clubId}/data` },
        { id: 'admin', label: 'Admin', icon: '⚙️', path: `/club/${clubId}/admin` },
    ];

    const isActive = (path: string) => location.pathname === path;

    return (
        <div className="app-shell">
            {/* Main Content Area */}
            <main className="app-main">
                {children}
            </main>

            {/* Bottom Navigation */}
            {showBottomNav && clubId && (
                <nav className="bottom-nav">
                    {navItems.map((item) => (
                        <Link
                            key={item.id}
                            to={item.path}
                            className={`nav-item ${isActive(item.path) ? 'active' : ''}`}
                        >
                            <span className="nav-icon">{item.icon}</span>
                            <span className="nav-label">{item.label}</span>
                        </Link>
                    ))}
                    <button
                        className="nav-item nav-close"
                        onClick={() => window.history.back()}
                    >
                        <span className="nav-icon">✕</span>
                    </button>
                </nav>
            )}

            {/* Slide-out Menu */}
            {isMenuOpen && (
                <div className="menu-overlay" onClick={() => setIsMenuOpen(false)}>
                    <div className="menu-panel" onClick={(e) => e.stopPropagation()}>
                        <div className="menu-header">
                            <h3>{clubName}</h3>
                            <button className="menu-close" onClick={() => setIsMenuOpen(false)}>✕</button>
                        </div>
                        <div className="menu-items">
                            <Link to={`/club/${clubId}/cashier`} className="menu-item">
                                <span className="menu-icon">⭐</span>
                                <span>Cashier</span>
                                <span className="menu-chevron">›</span>
                            </Link>
                            <Link to={`/club/${clubId}/topup`} className="menu-item">
                                <span className="menu-icon">💎</span>
                                <span>Top Up</span>
                                <span className="menu-chevron">›</span>
                            </Link>
                            <Link to={`/club/${clubId}/settings`} className="menu-item">
                                <span className="menu-icon">⚙️</span>
                                <span>Table Settings</span>
                                <span className="menu-chevron">›</span>
                            </Link>
                            <button className="menu-item">
                                <span className="menu-icon">🔊</span>
                                <span>Sounds</span>
                                <span className="menu-chevron">›</span>
                            </button>
                            <button className="menu-item">
                                <span className="menu-icon">📳</span>
                                <span>Vibrations</span>
                                <label className="toggle">
                                    <input type="checkbox" defaultChecked />
                                    <span className="toggle-slider"></span>
                                </label>
                            </button>
                            <button className="menu-item">
                                <span className="menu-icon">📤</span>
                                <span>Share</span>
                                <span className="menu-chevron">›</span>
                            </button>
                            <Link to="/vip" className="menu-item">
                                <span className="menu-icon">👑</span>
                                <span>VIP</span>
                                <span className="menu-chevron">›</span>
                            </Link>
                            <button className="menu-item exit" onClick={() => window.history.back()}>
                                <span className="menu-icon">↩️</span>
                                <span>Exit</span>
                                <span className="menu-chevron">›</span>
                            </button>
                        </div>
                        <div className="menu-footer">
                            <span className="version">Version: 1.0.0</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Export a context for toggling menu from children
export { AppShell };
