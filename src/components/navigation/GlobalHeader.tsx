/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL HEADER — Exact 1:1 replica of World Hub UniversalHeader
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
const HamburgerMenu = lazy(() => import('./HamburgerMenu'));
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { useAuthUser } from '../../hooks/useAuthUser';

import styles from './GlobalHeader.module.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

const BASE = MEDIA_BASE;

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

  const { avatarUrl, notificationCount, unreadMessages, loadOnce, setAvatarUrl } =
    useHeaderDataStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isNavigatingAway, setIsNavigatingAway] = useState(false);

  const handleMenuToggle = useCallback(() => setMenuOpen((prev) => !prev), []);
  const handleMenuClose = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    masterBus.emit('MENU_STATE_CHANGED', { isOpen: menuOpen });
  }, [menuOpen]);

  useMasterBusSubscription(
    'HAMBURGER_TOGGLE',
    () => {
      setMenuOpen((prev) => !prev);
    },
    { debounce: 200 }
  );

  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      inAppNavCountRef.current++;
      prevPathRef.current = location.pathname;
    }
  }, [location.pathname]);

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

  const edgeSwipeRef = useRef<number | null>(null);
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const x = e.touches[0].clientX;
      if (x < 25) edgeSwipeRef.current = x;
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (edgeSwipeRef.current === null) return;
      const endX = e.changedTouches[0].clientX;
      if (endX - edgeSwipeRef.current > 60) setMenuOpen(true);
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

  useEffect(() => {
    if (!authUser?.id) return;
    loadOnce(authUser.id);
    loadBalances(authUser.id);
    loadDiamonds(authUser.id);
  }, [authUser?.id, loadOnce, loadBalances, loadDiamonds]);

  useMasterBusSubscription(
    'WALLET_REFRESHED',
    () => {
      if (authUser?.id) loadBalances(authUser.id);
    },
    { debounce: 300 }
  );

  useMasterBusSubscription(
    'DIAMOND_BALANCE_CHANGED',
    (payload: any) => {
      if (authUser?.id) {
        if (payload?.newBalance !== undefined) {
          useWalletStore.setState({ diamonds: payload.newBalance });
        } else {
          loadDiamonds(authUser.id);
        }
      }
    },
    { debounce: 200 }
  );

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

  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const { type, source } = event.data || {};
      if (source !== 'smarter-poker-messenger') return;

      if (type === 'MESSENGER_UNREAD_COUNT' && typeof event.data.count === 'number') {
        useHeaderDataStore.getState().setUnreadMessages(event.data.count);
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, []);

  const handleBackClick = () => {
    if (inAppNavCountRef.current > 0) {
      navigate(-1);
    } else {
      navigate('/', { replace: true });
    }
  };

  const navigateToHub = useCallback((path: string) => {
    setIsNavigatingAway(true);
    requestAnimationFrame(() => {
      window.location.href = path;
    });
  }, []);

  const [prefetchedMessenger, setPrefetchedMessenger] = useState(false);

  const prefetchMessenger = useCallback(() => {
    if (prefetchedMessenger) return;
    setPrefetchedMessenger(true);
    import('../../pages/MessagesPage').catch(() => {});
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = '/hub/messenger?hideHeader=true';
    document.head.appendChild(link);
  }, [prefetchedMessenger]);

  const handleHubClick = () => {
    navigateToHub('/hub');
  };

  const headerStyle = isNavigatingAway
    ? { opacity: 0.5, transition: 'opacity 0.15s ease', pointerEvents: 'none' as const }
    : undefined;

  return (
    <>
      <Suspense fallback={null}>
        <HamburgerMenu isOpen={menuOpen} onClose={handleMenuClose} />
      </Suspense>

      <header className={styles.header} style={headerStyle}>
        {/* LEFT: Back button (sub-pages) + Hamburger always visible */}
        <div className={styles.headerLeft}>
          {isSubPage && (
            <button
              onClick={handleBackClick}
              className={`${styles.headerImgBtn} ${styles.headerNavBtn}`}
              aria-label="Go back"
            >
              <img
                src={`${BASE}images/btn-back.png`}
                alt="Back"
                style={{ height: '100%', width: '100%', objectFit: 'contain' }}
              />
            </button>
          )}
          <button onClick={handleMenuToggle} className={styles.hamburgerBtn} aria-label="Open Menu">
            <img
              src={`${BASE}images/btn-hamburger-v4.png`}
              alt="Menu"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </button>
        </div>

        {/* CENTER: Brand Text Image */}
        <div className={styles.headerCenter}>
          <img
            src={`${BASE}images/brand-text-clean.png`}
            alt="Smarter.Poker"
            className={styles.brandTextImg}
          />
          {location.pathname.includes('/messages') && (
            <span
              className={styles.hideMobile}
              style={{ marginLeft: 8, fontSize: 16, display: 'flex', alignItems: 'center' }}
              title="Securely Encrypted"
            >
              🔒
            </span>
          )}
        </div>

        {/* RIGHT: Orb Icons - Exact World Hub Order */}
        <div className={styles.headerRight}>
          {/* Avatar/Profile Orb */}
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/profile')}
            style={{ overflow: 'visible' }}
            aria-label="My Profile"
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

          {/* Diamond Wallet Icon */}
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/diamond-store')}
            title="Diamond Wallet"
          >
            <img
              src={`${BASE}images/header-wallet-v4.png`}
              alt="Wallet"
              className={styles.orbImg}
            />
          </button>

          {/* VIP Card Icon */}
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/vip')}
            title="VIP Member"
          >
            <img src={`${BASE}images/vip-card-v8.jpg`} alt="VIP Member" className={styles.orbImg} />
          </button>

          {/* Messages */}
          {authUser?.id && (
            <button
              className={styles.orbBtn}
              onClick={() => navigate('/messages')}
              onMouseEnter={prefetchMessenger}
              onTouchStart={prefetchMessenger}
              aria-label="Messages"
              title="Messages"
            >
              <img
                src={`${BASE}images/header-messenger-v4.png`}
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

          {/* Notifications */}
          <Link
            to="/notifications"
            className={styles.orbLink}
            title="Notifications"
            aria-label="Notifications"
          >
            <img
              src={`${BASE}images/notification-bell-trimmed.png`}
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
          <button
            className={styles.orbBtn}
            onClick={() => navigateToHub('/hub/settings')}
            title="Settings"
          >
            <img
              src={`${BASE}images/header-settings-v4.png`}
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
            <img
              src={`${BASE}images/header-help-v4.png`}
              alt="Live Help"
              className={styles.orbImg}
            />
          </button>
        </div>
      </header>
    </>
  );
}
