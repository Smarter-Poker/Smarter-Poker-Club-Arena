/**
 * ♠ CLUB ARENA — Shell Layout
 * Main app shell with header and navigation
 */

import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MEDIA_BASE } from '../utils/mediaBase';
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUserStore } from '../stores/useUserStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { useWalletStore } from '../stores/useWalletStore';
import { notificationService } from '../services/NotificationService';
import { supabase } from '../lib/supabase';
import { VIPProvider, useVIPStatus } from '../hooks/useVIP';
import { InAppAlerts, useAlerts } from './notifications/InAppAlerts';
import { useClubTheme } from '../utils/clubThemeEngine';
import { scheduleStaleCacheReaper } from '../utils/staleCacheReaper';
import './Shell.css';
import { reportError } from '../utils/errorReporter';

// VIP Badge Component
function VIPBadge() {
  const { isVIP, isLoading } = useVIPStatus();
  const navigate = useNavigate();

  if (isLoading) return null;

  return (
    <button
      className={`shell-vip-badge ${isVIP ? 'vip-active' : ''}`}
      onClick={() => {
        navigate('/marketplace?tab=diamonds');
      }}
      title={isVIP ? 'VIP Gold Active' : 'Get VIP Benefits'}
    >
      {isVIP ? ' VIP' : ''}
    </button>
  );
}

function ShellContent() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Store
  const { theme } = useSettingsStore();
  const { user } = useAuthUser();
  const { totalChips } = useUserStore();
  const { diamonds } = useWalletStore();
  const [unreadCount, setUnreadCount] = useState(0);

  // Global alerts
  const { alerts, dismissAlert } = useAlerts();

  // Club Theme Engine — apply per-club CSS custom properties
  const { theme: clubTheme } = useClubTheme(null);

  // Sync Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Apply club theme CSS variables
    if (clubTheme) {
      const root = document.documentElement;
      root.style.setProperty('--club-bg', clubTheme.pageBg);
      root.style.setProperty('--club-card-bg', clubTheme.cardBg);
      root.style.setProperty('--club-primary', clubTheme.primary);
      root.style.setProperty('--club-accent', clubTheme.accent);
    }
  }, [theme, clubTheme]);

  // Schedule stale cache cleanup during idle time
  useEffect(() => {
    scheduleStaleCacheReaper();
  }, []);

  // Real-time notifications — uses useAuthUser() hook instead of getUser()
  useEffect(() => {
    let mounted = true;
    if (!user?.id) return;

    const userId = user.id;

    const setupNotifications = async () => {
      try {
        // Get initial count
        const count = await notificationService.getUnreadCount(userId);
        if (!mounted) return;
        setUnreadCount(count);

        // Subscribe to real-time updates
        await notificationService.subscribe(userId, {
          onNew: () => {
            if (mounted) setUnreadCount((prev) => prev + 1);
          },
          onUpdate: async () => {
            const newCount = await notificationService.getUnreadCount(userId);
            if (mounted) setUnreadCount(newCount);
          },
        });
      } catch (err) {
        reportError(err, 'Shell.Notification_setup_failed');
      }
    };

    setupNotifications();

    return () => {
      mounted = false;
      notificationService.unsubscribe();
    };
  }, [user?.id]);

  // Detect if we're inside a specific club (Club Arena context)
  // Club Arena is its own business - no global header needed
  // Routes: /hub/club-arena/clubs/[clubId]/*
  const isInClubArena = location.pathname.includes('/club-arena/clubs/');

  return (
    <div className="shell">
      {/* Header - Always visible with hamburger menu */}
      <header className="shell-header">
        <div className="shell-header-content">
          {/* Hamburger + Hub Logo */}
          <div className="shell-logo">
            <button
              className="shell-hamburger"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Menu"
            >
              <img
                src={`${MEDIA_BASE}images/global-header/command-center.png`}
                alt="Command Center"
                style={{ height: '100%', width: '100%', objectFit: 'contain' }}
              />
            </button>
            <NavLink to="/" className="shell-logo-link">
              <span className="shell-logo-text">Hub</span>
            </NavLink>
          </div>

          {/* Desktop Nav */}
          <nav className="shell-nav">
            <NavLink
              to="/"
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
              end
            >
              Home
            </NavLink>
            <NavLink
              to="/"
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
            >
              Play
            </NavLink>
            <NavLink
              to="/clubs"
              className={({ isActive }) =>
                `shell-nav-link ${isActive || location.pathname.startsWith('/clubs') ? 'active' : ''}`
              }
            >
              Clubs
            </NavLink>
            <NavLink
              to="/unions"
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
            >
              Unions
            </NavLink>
            <NavLink
              to="/profile"
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
            >
              Profile
            </NavLink>
          </nav>

          {/* User Info */}
          <div className="shell-user">
            {user && (
              <div className="shell-player-id" title="Player ID">
                ID: {parseInt(user.id, 10) || user.id}
              </div>
            )}
            <VIPBadge />
            <button
              className="shell-notifications"
              onClick={() => navigate('/notifications')}
              title="Notifications"
              aria-label={
                unreadCount > 0 ? `Notifications (${unreadCount} Unread)` : 'Notifications'
              }
            >
              {unreadCount > 0 && (
                <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
              )}
            </button>
            <div
              className="shell-diamonds"
              role="button"
              tabIndex={0}
              aria-label="View Diamond Balance"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click();
              }}
              onClick={() => {
                navigate('/marketplace?tab=diamonds');
              }}
              style={{ cursor: 'pointer' }}
            >
              <span className="diamond-icon">◇</span>
              <span className="diamond-amount">
                {diamonds.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
            <div className="shell-chips">
              <span className="chip-icon">◉</span>
              <span className="chip-amount">
                {user
                  ? totalChips.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  : '0.00'}
              </span>
            </div>
            <button
              className="shell-avatar"
              onClick={() => navigate('/profile')}
              aria-label="Open Profile"
            >
              {user?.avatar_url || ''}
            </button>
          </div>

          {/* Mobile Toggle */}
          <button
            className="shell-mobile-toggle"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? 'Close Menu' : 'Open Menu'}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? (
              '✕'
            ) : (
              <img
                src={`${MEDIA_BASE}images/global-header/command-center.png`}
                alt="Command Center"
                style={{ height: 20, width: 20, objectFit: 'contain' }}
              />
            )}
          </button>
        </div>

        {/* Mobile Nav */}
        {mobileMenuOpen && (
          <nav className="shell-mobile-nav">
            <NavLink to="/" onClick={() => setMobileMenuOpen(false)}>
              {' '}
              Home
            </NavLink>
            <NavLink to="/" onClick={() => setMobileMenuOpen(false)}>
              {' '}
              Play
            </NavLink>
            <NavLink to="/clubs" onClick={() => setMobileMenuOpen(false)}>
              {' '}
              Clubs
            </NavLink>
            <NavLink to="/unions" onClick={() => setMobileMenuOpen(false)}>
              Unions
            </NavLink>
            <NavLink to="/profile" onClick={() => setMobileMenuOpen(false)}>
              {' '}
              Profile
            </NavLink>
          </nav>
        )}
      </header>

      {/* Main Content */}
      <main className="shell-main">
        <Outlet />
      </main>

      {/* Global In-App Alerts */}
      <InAppAlerts alerts={alerts} onDismiss={dismissAlert} position="top-right" />
    </div>
  );
}

// Export with VIPProvider wrapper
export default function Shell() {
  return (
    <VIPProvider>
      <ShellContent />
    </VIPProvider>
  );
}
