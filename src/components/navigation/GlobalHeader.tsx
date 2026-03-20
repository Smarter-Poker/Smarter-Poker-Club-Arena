/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL HEADER — Exact replica of World Hub UniversalHeader
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CRITICAL: This must be pixel-identical to smarter.poker/hub header.
 *
 * Layout:
 *   LEFT:   BACK button (btn-back.png) on sub-pages, HUB button (btn-hub.png) on lobby
 *           ── Mutually exclusive: a page NEVER shows both.
 *   CENTER: Brand text (brand-text.png) — hidden on mobile
 *   RIGHT:  Diamond icon, VIP badge, Profile orb, Messages, Notifications, Settings, Help
 *           All icons 26x26px from smarter.poker/images/
 *
 * Hamburger: 56×56px inline btn-hamburger.png in header-left (World Hub standard)
 * VIP: Gold glow ring on VIP icon
 * Profile: 3px cyan border with enhanced glow
 */

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
const HamburgerMenu = lazy(() => import('./HamburgerMenu'));
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useAuthUser } from '../../hooks/useAuthUser';

import styles from './GlobalHeader.module.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

const BASE = import.meta.env.BASE_URL;

/**
 * Session-level counter of in-app navigations.
 * If 0 on a sub-page, the user arrived via direct URL — navigate(-1) would exit the app.
 * Uses useRef to avoid issues with React strict mode double-mounting.
 */

interface GlobalHeaderProps {
  pageDepth?: number;
  showSearch?: boolean;
  onSearchClick?: () => void;
}

export default function GlobalHeader({ pageDepth = 1 }: GlobalHeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const inAppNavCountRef = useRef(0);
  const { loadBalances, loadDiamonds } = useWalletStore();
  const { user: authUser } = useAuthUser();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // Hydrate notification/message counts from localStorage for instant display on re-entry
  const [notificationCount, setNotificationCount] = useState(() => {
    try {
      return parseInt(localStorage.getItem('ca-notif-count') || '0', 10);
    } catch {
      return 0;
    }
  });
  const [unreadMessages, setUnreadMessages] = useState(() => {
    try {
      return parseInt(localStorage.getItem('ca-msg-count') || '0', 10);
    } catch {
      return 0;
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [isNavigatingAway, setIsNavigatingAway] = useState(false);

  const handleMenuToggle = useCallback(() => setMenuOpen((prev) => !prev), []);
  const handleMenuClose = useCallback(() => setMenuOpen(false), []);

  // Broadcast menu state changes so FloatingHamburger hides when menu is open
  useEffect(() => {
    masterBus.emit('MENU_STATE_CHANGED', { isOpen: menuOpen });
  }, [menuOpen]);

  // Listen for HAMBURGER_TOGGLE from FloatingHamburger (bottom-left button)
  // Debounced to prevent rapid double-tap from toggling faster than animation
  useMasterBusSubscription(
    'HAMBURGER_TOGGLE',
    () => {
      setMenuOpen((prev) => !prev);
    },
    { debounce: 200 }
  );

  // ─── Track in-app navigations for safe back-button behaviour ───
  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      inAppNavCountRef.current++;
      prevPathRef.current = location.pathname;
    }
  }, [location.pathname]);

  // #4: Keyboard shortcut — Ctrl/⌘+M toggles menu
  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        setMenuOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  // #6: Swipe from left edge to open menu
  const edgeSwipeRef = useRef<number | null>(null);
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const x = e.touches[0].clientX;
      if (x < 25) edgeSwipeRef.current = x; // Only track if starting from left edge
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (edgeSwipeRef.current === null) return;
      const endX = e.changedTouches[0].clientX;
      if (endX - edgeSwipeRef.current > 60) setMenuOpen(true); // Swipe right > 60px
      edgeSwipeRef.current = null;
    };
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  const isSubPage = pageDepth >= 2;

  // Load user data when auth user becomes available (no more getUser() calls)
  useEffect(() => {
    let mounted = true;
    if (!authUser?.id) return;

    const userId = authUser.id;

    const loadUserData = async () => {
      try {
        loadBalances(userId);
        loadDiamonds(userId);

        // Fetch profile avatar
        const { data: profile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', userId)
          .maybeSingle();

        if (profile && mounted) {
          setAvatarUrl(profile.avatar_url);
        }

        // Notification count
        const { count: notifCount } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('read', false);
        if (mounted) {
          const newCount = notifCount || 0;
          setNotificationCount(newCount);
          try {
            localStorage.setItem('ca-notif-count', String(newCount));
          } catch {
            /* */
          }
          masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count: newCount });
        }

        // Unread messages count
        const { count: msgCount } = await supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', userId)
          .eq('is_read', false);
        if (mounted) {
          const newMsgCount = msgCount || 0;
          setUnreadMessages(newMsgCount);
          try {
            localStorage.setItem('ca-msg-count', String(newMsgCount));
          } catch {
            /* */
          }
          masterBus.emit('UNREAD_DM_COUNT_CHANGED', { userId: userId, count: newMsgCount });
        }
      } catch (e) {
        console.error('[GlobalHeader] Error loading user data:', e);
      }
    };

    loadUserData();

    // ─── MASTER BUS LISTENERS ───
    const activeChannelKey = `header-sync-${userId}`;
    const channel = masterBus.getOrCreateChannel(activeChannelKey);

    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        async () => {
          if (!mounted) return;
          const { count } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('read', false);
          if (mounted) {
            const c = count || 0;
            setNotificationCount(c);
            try {
              localStorage.setItem('ca-notif-count', String(c));
            } catch {
              /* */
            }
            masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count: c });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${userId}`,
        },
        async () => {
          if (!mounted) return;
          const { count } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('is_read', false);
          if (mounted) {
            const mc = count || 0;
            setUnreadMessages(mc);
            try {
              localStorage.setItem('ca-msg-count', String(mc));
            } catch {
              /* */
            }
            masterBus.emit('UNREAD_DM_COUNT_CHANGED', { userId: userId, count: mc });
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[GlobalHeader] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[GlobalHeader] ⏱️ Realtime channel timed out');
        }
      });

    return () => {
      mounted = false;
      masterBus.removeRegisteredChannel(activeChannelKey);
    };
  }, [authUser?.id, loadBalances, loadDiamonds]);

  // #4: Debounced — collapses rapid-fire wallet refreshes into one call
  useMasterBusSubscription(
    'WALLET_REFRESHED',
    () => {
      if (authUser?.id) loadBalances(authUser.id);
    },
    { debounce: 300 }
  );

  useMasterBusSubscription('USER_PROFILE_LOADED', (payload) => {
    if (payload?.avatarUrl) {
      setAvatarUrl(payload.avatarUrl);
    }
  });

  /** Safe back-nav: uses history if available, otherwise falls back to home */
  const handleBackClick = () => {
    if (inAppNavCountRef.current > 0) {
      navigate(-1);
    } else {
      navigate('/', { replace: true });
    }
  };

  /** Navigate to a World Hub page with visual feedback */
  const navigateToHub = useCallback((path: string) => {
    setIsNavigatingAway(true);
    // Brief delay for visual feedback, then navigate
    requestAnimationFrame(() => {
      window.location.href = path;
    });
  }, []);

  const handleHubClick = () => {
    navigateToHub('/hub');
  };

  // Visual fade on cross-app navigation for instant feedback
  const headerStyle = isNavigatingAway
    ? { opacity: 0.5, transition: 'opacity 0.15s ease', pointerEvents: 'none' as const }
    : undefined;

  return (
    <>
      {/* Hamburger Menu drawer — lazy-loaded, rendered outside header for z-index stacking */}
      <Suspense fallback={null}>
        <HamburgerMenu isOpen={menuOpen} onClose={handleMenuClose} />
      </Suspense>

      <header className={styles.header} style={headerStyle}>
        {/* LEFT: Hamburger + Back/Hub button (World Hub pattern) */}
        <div className={styles.headerLeft}>
          {/* #5: Hamburger — always visible, opens HamburgerMenu drawer */}
          <button className={styles.hamburgerBtn} onClick={handleMenuToggle} aria-label="Open Menu">
            <img
              src={`${BASE}images/btn-hamburger.png`}
              alt="Menu"
              className={styles.hamburgerImg}
            />
          </button>

          {isSubPage ? (
            <button
              className={styles.hubBtn}
              onClick={handleBackClick}
              aria-label="Go Back"
              title="Go Back"
            >
              <img src={`${BASE}images/btn-back.png`} alt="Back" className={styles.hubImg} />
            </button>
          ) : (
            <button className={styles.hubBtn} onClick={handleHubClick} aria-label="Hub" title="Hub">
              <img src={`${BASE}images/btn-hub.png`} alt="Hub" className={styles.hubImg} />
            </button>
          )}
        </div>

        {/* CENTER: Brand text (hidden on mobile) */}
        <div className={styles.headerCenter}>
          <img
            src={`${BASE}images/brand-text.png`}
            alt="Smarter.Poker"
            className={styles.brandText}
          />
        </div>

        {/* RIGHT: Icon row — exact World Hub order */}
        <div className={styles.headerRight}>
          {/* Diamond Wallet */}
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/diamond-store')}
            aria-label="Diamond Wallet"
          >
            <img
              src={`${BASE}images/diamond-icon.png`}
              alt="Diamond Wallet"
              className={styles.orbImg}
            />
          </button>

          {/* VIP Member — #2: Gold glow ring */}
          <button className={styles.orbBtnVip} onClick={() => navigateToHub('/hub/vip')}>
            <img src={`${BASE}images/vip-card.png`} alt="VIP Member" className={styles.orbImg} />
          </button>

          {/* Profile / Avatar — uses orbBtnProfile for overflow:visible so glow renders */}
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/profile')}
            style={{ overflow: 'visible' }}
          >
            <div className={styles.profileOrb}>
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className={styles.profileImg}
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = generateDefaultAvatar();
                  }}
                />
              ) : (
                <span className={styles.profilePlaceholder}>👤</span>
              )}
            </div>
          </button>

          {/* Messages */}
          <button className={styles.orbBtn} onClick={() => navigateToHub('/hub/messenger')}>
            <img
              src={`${BASE}images/header-messenger.png`}
              alt="Messages"
              className={styles.orbImg}
            />
            {unreadMessages > 0 && (
              <span className={styles.badge} aria-live="polite">
                {unreadMessages > 99 ? '99+' : unreadMessages}
              </span>
            )}
          </button>

          {/* Notifications — route to in-app Notification Center */}
          <Link to="/notifications" className={styles.orbLink}>
            <img
              src={`${BASE}images/header-notifications.png`}
              alt="Notifications"
              className={styles.orbImg}
            />
            {notificationCount > 0 && (
              <span className={styles.badge} aria-live="polite">
                {notificationCount > 99 ? '99+' : notificationCount}
              </span>
            )}
          </Link>

          {/* Settings */}
          <button className={styles.orbBtn} onClick={() => navigateToHub('/hub/settings')}>
            <img
              src={`${BASE}images/header-settings.png`}
              alt="Settings"
              className={styles.orbImg}
            />
          </button>

          {/* Live Help */}
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/help')}
            aria-label="Live Help"
          >
            <img src={`${BASE}images/header-help.png`} alt="Live Help" className={styles.orbImg} />
          </button>
        </div>
      </header>
    </>
  );
}
