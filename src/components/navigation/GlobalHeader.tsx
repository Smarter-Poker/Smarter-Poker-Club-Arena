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
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { useAuthUser } from '../../hooks/useAuthUser';

import styles from './GlobalHeader.module.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

const BASE = import.meta.env.BASE_URL;

// Brain Icon SVG Component
const BrainIcon = ({ size = 32 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="brainGradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0066FF" />
      </linearGradient>
    </defs>
    <path
      d="M12 2C9.5 2 7.5 4 7.5 6.5C7.5 7.5 7.8 8.4 8.4 9.1C6.4 9.6 5 11.4 5 13.5C5 15.4 6.2 17 7.9 17.7C7.5 18.3 7.3 19 7.3 19.8C7.3 21.5 8.7 23 10.4 23C11.3 23 12.1 22.6 12.6 22C13.1 22.6 13.9 23 14.8 23C16.5 23 17.9 21.5 17.9 19.8C17.9 19 17.7 18.3 17.3 17.7C19 17 20.2 15.4 20.2 13.5C20.2 11.4 18.8 9.6 16.8 9.1C17.4 8.4 17.7 7.5 17.7 6.5C17.7 4 15.7 2 13.2 2H12Z"
      fill="url(#brainGradient)"
    />
    <path
      d="M12 6V18M9 10C9 10 10 12 12 12C14 12 15 10 15 10M9 14.5C9 14.5 10 13 12 13C14 13 15 14.5 15 14.5"
      stroke="#0a1628"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

// Back Arrow SVG Component
const BackArrow = ({ size = 24 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

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
  // ─── PERSISTENT HEADER DATA (survives route changes — no re-fetch on navigation) ───
  const { avatarUrl, notificationCount, unreadMessages, loadOnce, setAvatarUrl } =
    useHeaderDataStore();
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

  // ─── PERSISTENT HEADER DATA INIT ───
  // loadOnce() fetches avatar + counts from Supabase exactly ONE TIME.
  // Subsequent route changes DO NOT re-fetch — data persists in Zustand store.
  // Realtime channel for notifications/messages is managed by the store,
  // not by this component, so it survives route changes without reconnecting.
  useEffect(() => {
    if (!authUser?.id) return;
    // Load header data once + set up realtime (no-op if already loaded for this user)
    loadOnce(authUser.id);
    // Load wallet data (these are idempotent — Zustand deduplicates)
    loadBalances(authUser.id);
    loadDiamonds(authUser.id);
  }, [authUser?.id, loadOnce, loadBalances, loadDiamonds]);

  // #4: Debounced — collapses rapid-fire wallet refreshes into one call
  useMasterBusSubscription(
    'WALLET_REFRESHED',
    () => {
      if (authUser?.id) loadBalances(authUser.id);
    },
    { debounce: 300 }
  );

  // Auto-refresh diamond balance when it changes anywhere in the platform
  useMasterBusSubscription(
    'DIAMOND_BALANCE_CHANGED',
    (payload: any) => {
      if (authUser?.id) {
        // If the bus event carries the new balance, update store directly (instant)
        if (payload?.newBalance !== undefined) {
          useWalletStore.setState({ diamonds: payload.newBalance });
        } else {
          loadDiamonds(authUser.id);
        }
      }
    },
    { debounce: 200 }
  );

  // Also listen for generic BALANCE_UPDATED (covers admin adjustments, rewards, etc.)
  useMasterBusSubscription(
    'BALANCE_UPDATED',
    () => {
      if (authUser?.id) loadDiamonds(authUser.id);
    },
    { debounce: 500 }
  );

  useMasterBusSubscription('USER_PROFILE_LOADED', (payload) => {
    if (payload?.avatarUrl) {
      setAvatarUrl(payload.avatarUrl as string);
    }
  });

  // ── PostMessage Bridge: receive real-time signals from embedded messenger iframe ──
  // Complements the MessagesPage-level listener — handles the case where the user
  // navigates away from /messages while the iframe is still mounted in React's tree.
  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const { type, source } = event.data || {};
      if (source !== 'smarter-poker-messenger') return;

      if (type === 'MESSENGER_UNREAD_COUNT' && typeof event.data.count === 'number') {
        // setUnreadMessages has a self-echo guard — safe to call here even if
        // MessagesPage already handled the same event.
        useHeaderDataStore.getState().setUnreadMessages(event.data.count);
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, []);

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

  const [prefetchedMessenger, setPrefetchedMessenger] = useState(false);

  const prefetchMessenger = useCallback(() => {
    if (prefetchedMessenger) return;
    setPrefetchedMessenger(true);

    // 1. Prefetch the React component chunk
    import('../../pages/MessagesPage').catch(() => {});

    // 2. Prefetch the iframe's URL
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = '/hub/messenger?hideHeader=true';
    document.head.appendChild(link);
  }, [prefetchedMessenger]);

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
        {/* LEFT: Hamburger + Brain Icon + Back Arrow */}
        <div className={styles.headerLeft}>
          {/* Hamburger — always visible, opens HamburgerMenu drawer */}
          <button className={styles.hamburgerBtn} onClick={handleMenuToggle} aria-label="Open Menu">
            <img
              src={`${BASE}images/btn-hamburger.png`}
              alt="Menu"
              className={styles.hamburgerImg}
            />
          </button>

          {/* Brain Icon - Home Button */}
          <button
            className={styles.brainBtn}
            onClick={handleHubClick}
            aria-label="Back To Hub"
            title="Back To Hub"
          >
            <BrainIcon size={28} />
          </button>

          {/* Back Arrow - Previous Page */}
          {isSubPage && (
            <button
              className={styles.backBtn}
              onClick={handleBackClick}
              aria-label="Go Back"
              title="Go Back"
            >
              <BackArrow size={18} />
              <span>Back</span>
            </button>
          )}
        </div>

        {/* CENTER: Brand text (hidden on mobile) */}
        <div className={styles.headerCenter}>
          <div className={styles.brandText}>SMARTER.POKER</div>
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
          {authUser?.id && (
            <button
              className={styles.orbBtn}
              onClick={() => navigate('/messages')}
              onMouseEnter={prefetchMessenger}
              onTouchStart={prefetchMessenger}
              aria-label="Open Messenger"
            >
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
          )}

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
