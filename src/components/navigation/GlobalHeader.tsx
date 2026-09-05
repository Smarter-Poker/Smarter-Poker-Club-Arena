/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL HEADER — Exact 1:1 replica of World Hub UniversalHeader
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { MEDIA_BASE } from '../../utils/mediaBase';
const HamburgerMenu = lazyWithRetry(() => import('./HamburgerMenu'));
import { Link, useNavigate } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { useAuthUser } from '../../hooks/useAuthUser';
import type { InTabLobbyNav } from '../../context/InTabLobbyContext';

import styles from './GlobalHeader.module.css';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

const BASE = MEDIA_BASE;

/** MultiTablePage publishes how many live TABLE tabs it holds on <body>; a
 *  World Hub destination with any open goes to a hub tab, never to
 *  window.location (which would unmount them all). Inline rather than a shared
 *  module because this header is in the entry chunk and a new import would
 *  grow it (scripts/ci/entry-chunk-delta.mjs). */
const liveTablesOpen = (): boolean =>
  typeof document !== 'undefined' && Number(document.body?.dataset.caLiveTables ?? '0') > 0;
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
/**
 * `inTab` (Dan 2026-09-04): this header is rendered INSIDE a "+" tab of
 * MultiTablePage, under the table strip, so the lobby a player opened with
 * "+" has a Hub button. In that mode it is a copy of the header, not THE
 * header, and three things follow:
 *   - it does not claim `#global-header` and does not publish
 *     `--ca-global-header-height` on the document root: the ticker and the
 *     pinned strip position themselves by those, and they describe the real
 *     header's place on the page. It publishes its height on its PARENT
 *     instead (`--ca-in-tab-header-height`), for the tab's own chrome;
 *   - Hub / VIP / Messages open IN THE TAB through InTabLobbyNav.openHub -
 *     `window.location.href` would unmount every running table;
 *   - the window-level hamburger listeners (HAMBURGER_TOGGLE, Ctrl+M, the
 *     left-edge swipe) stay with the real header. Two headers answering one
 *     gesture would open two menus, and the edge swipe is the strip's own
 *     swipe-back gesture inside a tab.
 */
/**
 * `inTab` is the container's InTabLobbyNav, passed as a PROP rather than read
 * from context on purpose: this header is in the entry chunk every player
 * downloads before first paint, and a value import of InTabLobbyContext would
 * drag that module in with it (tests/ci entry-chunk-delta). A type-only import
 * is erased at build time; the runtime dependency stays with MultiTablePage,
 * which is lazy.
 */
export default function GlobalHeader({ inTab = null }: { inTab?: InTabLobbyNav | null } = {}) {
  const navigate = useNavigate();
  const { loadBalances, loadDiamonds } = useWalletStore();
  const { user: authUser } = useAuthUser();
  const headerRef = useRef<HTMLElement>(null);
  const inTabHub = inTab;

  const {
    avatarUrl,
    isVipActive,
    notificationCount,
    unreadMessages,
    loadOnce,
    clearUnreadNotifications,
    clearUnreadMessages,
  } = useHeaderDataStore();
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

    // In a tab, the height belongs to the TAB (see the `inTab` note above):
    // it goes on the tab element as --ca-in-tab-header-height, and the root
    // variable the pinned strip and the ticker read is left to the real header.
    const root = document.documentElement;
    const tabHost = inTab ? (header.parentElement ?? header) : null;
    const publishHeight = () => {
      const height = `${header.getBoundingClientRect().height}px`;
      if (tabHost) {
        tabHost.style.setProperty('--ca-in-tab-header-height', height);
        return;
      }
      root.style.setProperty('--ca-global-header-height', height);
    };

    publishHeight();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishHeight);
    observer?.observe(header);
    window.addEventListener('resize', publishHeight, { passive: true });

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publishHeight);
      if (tabHost) tabHost.style.removeProperty('--ca-in-tab-header-height');
      else root.style.removeProperty('--ca-global-header-height');
    };
  }, [inTab]);

  const handleMenuToggle = useCallback(() => setMenuOpen((prev) => !prev), []);
  const handleMenuClose = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    masterBus.emit('MENU_STATE_CHANGED', { isOpen: menuOpen });
  }, [menuOpen]);

  useMasterBusSubscription(
    'HAMBURGER_TOGGLE',
    () => {
      if (inTab) return;
      setMenuOpen((prev) => !prev);
    },
    { debounce: 200 }
  );

  useEffect(() => {
    if (inTab) return;
    const handleKeyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        setMenuOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [inTab]);

  const edgeSwipeRef = useRef<number | null>(null);
  useEffect(() => {
    if (inTab) return;
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
  }, [inTab]);

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
    if (inTabHub) {
      inTabHub.goBack();
      return;
    }
    window.history.back();
  };

  const navigateToHub = useCallback(
    (path: string) => {
      // In a "+" tab the destination opens IN THE TAB (Dan 2026-09-04). Only
      // if the container declines - it is not a lobby tab on screen - does
      // this fall through to the full navigation it always did.
      if (inTabHub && inTabHub.openHub(path)) return;
      // OFF-ROUTE WITH A LIVE TABLE OPEN (Dan 2026-09-05): this header sits
      // above the pinned table strip. `window.location` here would unmount
      // every felt the strip is holding, so the page opens as a hub tab
      // beside the game instead. MultiTablePage publishes the count; with no
      // table open this is the plain navigation it has always been.
      if (liveTablesOpen()) {
        masterBus.emit('OPEN_HUB_TAB', { path, requestedBy: authUser?.id });
        return;
      }
      setIsNavigatingAway(true);
      requestAnimationFrame(() => {
        window.location.href = path;
      });
    },
    [inTabHub, authUser?.id]
  );

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
    // /messages is NavigateToMessenger, which leaves for /hub/messenger with
    // window.location. In a tab, or with a live table open, go there as a hub
    // page instead (see navigateToHub).
    if (inTabHub && inTabHub.openHub('/hub/messenger')) return;
    if (liveTablesOpen()) {
      masterBus.emit('OPEN_HUB_TAB', { path: '/hub/messenger', requestedBy: authUser?.id });
      return;
    }
    navigate('/messages');
  }, [authUser?.id, clearUnreadMessages, navigate, inTabHub]);

  const handleNotificationsClick = useCallback(async () => {
    if (authUser?.id) await clearUnreadNotifications(authUser.id);
    navigate('/notifications');
  }, [authUser?.id, clearUnreadNotifications, navigate]);

  const headerStyle = isNavigatingAway
    ? { opacity: 0.5, transition: 'opacity 0.15s ease', pointerEvents: 'none' as const }
    : undefined;

  return (
    <>
      {/* In a "+" tab this header lives inside `.multi-table-page__lobby-tab`,
          which is `contain: layout paint` + `overflow-y: auto`: a fixed
          backdrop/drawer rendered in place would be clipped to the tab and
          scroll away with the lobby (the same trap the tab's CSS documents for
          ClubBottomNav). The menu is portaled to <body> there; the real header
          is untouched. */}
      {inTab && typeof document !== 'undefined' ? (
        createPortal(
          <Suspense fallback={null}>
            <HamburgerMenu isOpen={menuOpen} onClose={handleMenuClose} />
          </Suspense>,
          document.body
        )
      ) : (
        <Suspense fallback={null}>
          <HamburgerMenu isOpen={menuOpen} onClose={handleMenuClose} />
        </Suspense>
      )}

      <header
        ref={headerRef}
        id={inTab ? undefined : 'global-header'}
        className={`${styles.header}${inTab ? ` ${styles.inTab}` : ''}`}
        style={headerStyle}
        data-artwork="approved-global-header"
        data-in-tab={inTab ? 'true' : undefined}
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

            {/*
             * Dan 2026-09-04: "when you click the wallet from the global header
             * it takes you to marketplace. It's supposed to take you to the
             * wallet." The button carried the wallet artwork and the label
             * "Diamond Wallet" and opened the diamond STORE tab. A wallet shows
             * what you hold; a store sells you more. The store keeps its own
             * entry points (the Buy Diamonds paths in Shell and the throwable
             * selector); this button opens the wallet.
             */}
            <button
              className={`${styles.artButton} ${styles.walletBtn}`}
              onClick={() => navigate('/wallet')}
              aria-label="My Wallet"
              title="My Wallet"
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

            <Link
              to="/notifications"
              className={`${styles.artButton} ${styles.notificationsBtn}`}
              onClick={(event) => {
                event.preventDefault();
                void handleNotificationsClick();
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
