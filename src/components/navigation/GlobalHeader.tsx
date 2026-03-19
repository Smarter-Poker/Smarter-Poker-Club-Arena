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
 */

import { useState, useEffect, useRef } from 'react';
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
 */
let inAppNavCount = 0;

interface GlobalHeaderProps {
  pageDepth?: number;
  showSearch?: boolean;
  onSearchClick?: () => void;
}

export default function GlobalHeader({ pageDepth = 1 }: GlobalHeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const { loadBalances, loadDiamonds } = useWalletStore();
  const { user: authUser } = useAuthUser();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);

  // ─── Track in-app navigations for safe back-button behaviour ───
  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      inAppNavCount++;
      prevPathRef.current = location.pathname;
    }
  }, [location.pathname]);

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
        if (mounted) setNotificationCount(notifCount || 0);

        // Unread messages count
        const { count: msgCount } = await supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', userId)
          .eq('is_read', false);
        if (mounted) setUnreadMessages(msgCount || 0);
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
          if (mounted) setNotificationCount(count || 0);
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
          if (mounted) setUnreadMessages(count || 0);
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
    if (inAppNavCount > 0) {
      navigate(-1);
    } else {
      navigate('/', { replace: true });
    }
  };

  const handleHubClick = () => {
    window.location.href = '/hub';
  };

  return (
    <header className={styles.header}>
      {/* LEFT: Back button on sub-pages, HUB button on lobby — mutually exclusive */}
      <div className={styles.headerLeft}>
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
          onClick={() => (window.location.href = '/hub/diamond-store')}
          aria-label="Diamond Wallet"
        >
          <img
            src={`${BASE}images/diamond-icon.png`}
            alt="Diamond Wallet"
            className={styles.orbImg}
          />
        </button>

        {/* VIP Member */}
        <button
          className={styles.orbBtn}
          onClick={() => (window.location.href = '/hub/diamond-store')}
        >
          <img src={`${BASE}images/vip-card.png`} alt="VIP Member" className={styles.orbImg} />
        </button>

        {/* Profile / Avatar */}
        <button className={styles.orbBtn} onClick={() => (window.location.href = '/hub/profile')}>
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
        <button className={styles.orbBtn} onClick={() => (window.location.href = '/hub/messenger')}>
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
        <button className={styles.orbBtn} onClick={() => (window.location.href = '/hub/settings')}>
          <img src={`${BASE}images/header-settings.png`} alt="Settings" className={styles.orbImg} />
        </button>

        {/* Live Help */}
        <button
          className={styles.orbBtn}
          onClick={() => (window.location.href = '/hub/help')}
          aria-label="Live Help"
        >
          <img src={`${BASE}images/header-help.png`} alt="Live Help" className={styles.orbImg} />
        </button>
      </div>
    </header>
  );
}
