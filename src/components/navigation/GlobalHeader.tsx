/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL HEADER — Exact 1:1 replica of World Hub UniversalHeader
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, Suspense } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
const HamburgerMenu = lazyWithRetry(() => import('./HamburgerMenu'));
import { Link, useNavigate } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { useNotificationsOverlayStore } from '../../stores/useNotificationsOverlayStore';
import { useAuthUser } from '../../hooks/useAuthUser';

import styles from './GlobalHeader.module.css';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

const BASE = MEDIA_BASE;
const APPROVED_HEADER_ASSET = `${BASE}images/global-header/`;
const DEFAULT_AVATAR = `${BASE}default-avatar.png`;

/*
 * Dan 2026-08-19: "the club arena needs a back button and hub button inside the
 * global header."
 *
 * Neither was reaching the screen. Back existed but was gated behind
 * `pageDepth >= 2`, so the lobby — the page you are on when you most want a way
 * out — never showed it. Hub was worse: handleHubClick was written, and then
 * nothing ever rendered a button that called it. AppLayout's own comment
 * promised "Lobby (/) = pageDepth 1 (HUB button)", which had never been true.
 *
 * Both are now unconditional, so there is no state in which the header offers
 * no way out of Club Arena. That makes pageDepth meaningless, and showSearch /
 * onSearchClick were already declared and never read, so all three props are
 * gone rather than left sitting there looking like they do something.
 */
export default function GlobalHeader() {
  const navigate = useNavigate();
  const { loadBalances, loadDiamonds } = useWalletStore();
  const { user: authUser } = useAuthUser();
  const headerRef = useRef<HTMLElement>(null);

  const {
    avatarUrl,
    isVipActive,
    notificationCount,
    unreadMessages,
    loadOnce,
    clearUnreadMessages,
  } = useHeaderDataStore();
  const openNotifications = useNotificationsOverlayStore((s) => s.openNotifications);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isNavigatingAway, setIsNavigatingAway] = useState(false);

  /*
   * The off-route table action bar is fixed, so CSS cannot discover the
   * responsive raster header's rendered height on its own. Publish the real
   * measured height before paint and whenever the artwork resizes. This keeps
   * the global header at viewport y=0 while the action bar begins at its exact
   * bottom edge on desktop, mobile, zoom, and safe-area layouts.
   */
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const root = document.documentElement;
    const publishHeight = () => {
      root.style.setProperty(
        '--ca-global-header-height',
        `${header.getBoundingClientRect().height}px`
      );
    };

    publishHeight();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishHeight);
    observer?.observe(header);
    window.addEventListener('resize', publishHeight, { passive: true });

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publishHeight);
      root.style.removeProperty('--ca-global-header-height');
    };
  }, []);

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

  useEffect(() => {
    if (!authUser?.id) return;
    loadOnce(authUser.id);
    loadBalances(authUser.id);
    loadDiamonds(authUser.id);
  }, [authUser?.id, loadOnce, loadBalances, loadDiamonds]);

  // force: an EVENT says the balance moved, so the freshness window in
  // useWalletStore (which exists to make MOUNTS free) must not swallow it.
  // Without this a real change could be up to BALANCE_FRESH_MS stale on screen,
  // which is worse than the skeleton flash the window removed.
  useMasterBusSubscription(
    'WALLET_REFRESHED',
    () => {
      if (authUser?.id) loadBalances(authUser.id, { force: true });
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
          loadDiamonds(authUser.id, { force: true });
        }
      }
    },
    { debounce: 200 }
  );

  useMasterBusSubscription(
    'BALANCE_UPDATED',
    () => {
      if (authUser?.id) loadDiamonds(authUser.id, { force: true });
    },
    { debounce: 500 }
  );

  /*
   * USER_PROFILE_LOADED is NOT subscribed here. useHeaderDataStore.loadOnce
   * already subscribes to it and calls setAvatarUrl, and that subscription
   * lives at store level so it survives route changes — this component's copy
   * was a second handler doing the identical write, torn down and rebuilt on
   * every navigation. One publisher, one subscriber.
   */

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

  /**
   * Dan's choice, 2026-08-19: Back is the browser's Back, always — one step
   * down the history stack even when that step leaves Club Arena entirely.
   * Not a router-scoped back that stops at the app boundary.
   */
  const handleBackClick = () => {
    window.history.back();
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
    import('../../pages/NavigateToMessenger').catch(() => {});
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = '/hub/messenger';
    document.head.appendChild(link);
  }, [prefetchedMessenger]);

  const handleHubClick = () => {
    navigateToHub('/hub');
  };

  const handleMessagesClick = useCallback(async () => {
    if (authUser?.id) await clearUnreadMessages(authUser.id);
    navigate('/messages');
  }, [authUser?.id, clearUnreadMessages, navigate]);

  /**
   * THE BELL OPENS A POPUP, IT DOES NOT NAVIGATE (Dan, 2026-09-02, verbatim):
   * "WHEN YOU CLICK ON NOTIFICATIONS, IT SHOULDN'T OPEN TO ITS OWN PAGE, IT
   * SHOULD CREATE A 'FULL SCREEN POP UP' SO YOU STAY ON THE PAGE YOU WERE ON,
   * AND NOT REDIRECT TO A WHOLE PAGE FOR NOTIFICATIONS."
   *
   * The badge is still cleared first, exactly as before — the popup is a
   * different presentation of the same act of reading them, not a different
   * act. `openNotifications` is synchronous, so the surface is on screen on
   * the same frame as the tap while the clear settles behind it.
   */
  const handleNotificationsClick = useCallback(() => {
    // The badge clear lives in the store's openNotifications now, so the
    // hamburger and the account rail acknowledge it exactly as this bell does.
    // It used to be written out here, which is why they did not.
    openNotifications('global-header-bell');
  }, [openNotifications]);

  const headerStyle = isNavigatingAway
    ? { opacity: 0.5, transition: 'opacity 0.15s ease', pointerEvents: 'none' as const }
    : undefined;

  return (
    <>
      <Suspense fallback={null}>
        <HamburgerMenu isOpen={menuOpen} onClose={handleMenuClose} />
      </Suspense>

      <header
        ref={headerRef}
        id="global-header"
        className={styles.header}
        style={headerStyle}
        data-artwork="approved-global-header"
        aria-label="Smarter.Poker Global Header"
      >
        {/* Desktop and landscape use the supplied artwork itself. This is a
            lossless crop: no redrawing, substitutions, filters, or resampling
            were applied to the source file. The controls below become precise
            hit regions over the artwork at these breakpoints. */}
        <img
          src={`${APPROVED_HEADER_ASSET}global-header-desktop.png`}
          alt=""
          width={1648}
          height={168}
          className={styles.desktopArtwork}
          aria-hidden="true"
          fetchPriority="high"
          decoding="sync"
        />

        <div className={styles.headerControls}>
          <div className={styles.headerLeft}>
            <button
              onClick={handleMenuToggle}
              className={`${styles.artButton} ${styles.hamburgerBtn}`}
              aria-label="Open Menu"
            >
              <img src={`${APPROVED_HEADER_ASSET}menu.png`} alt="Menu" />
            </button>
            <button
              onClick={handleBackClick}
              className={`${styles.artButton} ${styles.backBtn}`}
              aria-label="Go Back"
              title="Back"
            >
              <img src={`${APPROVED_HEADER_ASSET}back.png`} alt="Back" />
            </button>
            <button
              onClick={handleHubClick}
              className={`${styles.artButton} ${styles.hubBtn}`}
              aria-label="Go To The Hub"
              title="Hub"
            >
              <img src={`${APPROVED_HEADER_ASSET}hub.png`} alt="Hub" />
            </button>
          </div>

          {/* Functional order matches the approved right-hand group exactly. */}
          <div className={styles.headerRight}>
            <button
              className={`${styles.artButton} ${styles.profileBtn}`}
              onClick={() => navigate('/profile')}
              aria-label="My Profile"
              title="My Profile"
            >
              <img src={`${APPROVED_HEADER_ASSET}profile.png`} alt="Profile" />
              <span className={styles.profileAvatarSlot} aria-hidden="true">
                <img
                  src={avatarUrl || DEFAULT_AVATAR}
                  alt=""
                  className={styles.profileAvatar}
                  onError={(event) => {
                    event.currentTarget.src = DEFAULT_AVATAR;
                  }}
                />
              </span>
            </button>

            <button
              className={`${styles.artButton} ${styles.walletBtn}`}
              onClick={() => navigate('/marketplace?tab=diamonds')}
              aria-label="Diamond Wallet"
              title="Diamond Wallet"
            >
              <img src={`${APPROVED_HEADER_ASSET}wallet.png`} alt="Wallet" />
            </button>

            <button
              className={`${styles.artButton} ${styles.vipBtn} ${isVipActive ? styles.vipActive : ''}`}
              onClick={() => navigateToHub('/hub/vip-membership')}
              aria-label={isVipActive ? 'VIP Membership Active' : 'VIP Membership'}
              title={isVipActive ? 'VIP Membership Active' : 'VIP Membership'}
              data-vip-active={isVipActive ? 'true' : 'false'}
            >
              <img src={`${APPROVED_HEADER_ASSET}vip.png`} alt="VIP Member" />
            </button>

            <button
              className={`${styles.artButton} ${styles.messengerBtn}`}
              onClick={() => void handleMessagesClick()}
              onMouseEnter={prefetchMessenger}
              onTouchStart={prefetchMessenger}
              aria-label="Messages"
              title="Messages"
            >
              <img src={`${APPROVED_HEADER_ASSET}messenger.png`} alt="Messages" />
              {unreadMessages > 0 && (
                <span
                  className={`${styles.badge} ${styles.messageBadge}`}
                  aria-label={`${unreadMessages} Unread Messages`}
                  aria-live="polite"
                >
                  {unreadMessages > 99 ? '99+' : unreadMessages}
                </span>
              )}
            </button>

            {/* STILL AN ANCHOR, DELIBERATELY. The popup has no address, and
                three things need one: cmd/middle-click to open notifications
                in a new tab, the browser's own "copy link", and assistive tech
                that announces a destination. A plain left click is intercepted
                and opens the popup instead; a modified click is left alone so
                the browser does what the player asked and loads the route. */}
            <Link
              to="/notifications"
              className={`${styles.artButton} ${styles.notificationsBtn}`}
              onClick={(event) => {
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                handleNotificationsClick();
              }}
              title="Notifications"
              aria-label="Notifications"
            >
              <img src={`${APPROVED_HEADER_ASSET}notifications.png`} alt="Notifications" />
              {notificationCount > 0 && (
                <span
                  className={`${styles.badge} ${styles.notificationBadge}`}
                  aria-label={`${notificationCount} Unread Notifications`}
                  aria-live="polite"
                >
                  {notificationCount > 99 ? '99+' : notificationCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
