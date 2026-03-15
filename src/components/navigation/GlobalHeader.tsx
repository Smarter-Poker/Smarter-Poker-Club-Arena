/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL HEADER — Exact replica of World Hub UniversalHeader
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CRITICAL: This must be pixel-identical to smarter.poker/hub header.
 *
 * Layout:
 *   LEFT:   Hamburger (40x40) + HUB button (btn-hub.png)
 *   CENTER: Brand text (brand-text.png) — hidden on mobile
 *   RIGHT:  Diamond icon, VIP badge, Profile orb, Messages, Notifications, Settings, Help
 *           All icons 26x26px from smarter.poker/images/
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useWalletStore } from '../../stores/useWalletStore';
import HamburgerMenu from './HamburgerMenu';
import styles from './GlobalHeader.module.css';

const BASE = import.meta.env.BASE_URL;

interface GlobalHeaderProps {
  pageDepth?: number;
  showSearch?: boolean;
  onSearchClick?: () => void;
}

export default function GlobalHeader({ pageDepth = 1 }: GlobalHeaderProps) {
  const { loadBalances, loadDiamonds } = useWalletStore();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadUserData = async () => {
      try {
        const {
          data: { user: authUser },
        } = await supabase.auth.getUser();
        if (!authUser?.id) return;

        loadBalances(authUser.id);
        loadDiamonds(authUser.id);

        // Fetch profile avatar
        const { data: profile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', authUser.id)
          .maybeSingle();

        if (profile && mounted) {
          setAvatarUrl(profile.avatar_url);
        }

        // Notification count
        const { count: notifCount } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', authUser.id)
          .eq('read', false);
        if (mounted) setNotificationCount(notifCount || 0);

        // Unread messages count
        const { count: msgCount } = await supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('recipient_id', authUser.id)
          .eq('read', false);
        if (mounted) setUnreadMessages(msgCount || 0);
      } catch (e) {
        console.error('[GlobalHeader] Error loading user data:', e);
      }
    };

    loadUserData();

    // ─── MASTER BUS LISTENERS (#4: Debounced balance refresh) ───
    let unsubWallet: (() => void) | null = null;
    let unsubProfile: (() => void) | null = null;
    let activeChannelKey: string | null = null;

    const setupRealtime = async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user?.id) return;

      activeChannelKey = `header-sync-${data.user.id}`;
      const channel = masterBus.getOrCreateChannel(activeChannelKey);

      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${data.user.id}`,
          },
          async () => {
            if (!mounted) return;
            const { count } = await supabase
              .from('notifications')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', data.user.id)
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
            filter: `recipient_id=eq.${data.user.id}`,
          },
          async () => {
            if (!mounted) return;
            const { count } = await supabase
              .from('messages')
              .select('*', { count: 'exact', head: true })
              .eq('recipient_id', data.user.id)
              .eq('read', false);
            if (mounted) setUnreadMessages(count || 0);
          }
        )
        .subscribe();
    };

    setupRealtime();

    // #4: Debounced — collapses rapid-fire wallet refreshes into one call
    unsubWallet = masterBus.subscribeDebounced(
      'WALLET_REFRESHED',
      async () => {
        const { data } = await supabase.auth.getUser();
        if (data.user?.id && mounted) loadBalances(data.user.id);
      },
      300
    );

    unsubProfile = masterBus.subscribe('USER_PROFILE_LOADED', (event) => {
      if (mounted && event.payload?.avatarUrl) {
        setAvatarUrl(event.payload.avatarUrl);
      }
    });

    return () => {
      mounted = false;
      unsubWallet?.();
      unsubProfile?.();
      if (activeChannelKey) {
        masterBus.removeRegisteredChannel(activeChannelKey);
      }
    };
  }, [loadBalances, loadDiamonds]);

  const handleHubClick = () => {
    navigateToHub('/hub');
  };

  // Iframe-safe navigation: navigates the top window, not the iframe
  const navigateToHub = (path: string) => {
    const url = `https://smarter.poker${path}`;
    const isInIframe = typeof window !== 'undefined' && window.parent !== window;
    if (isInIframe) {
      try {
        window.top!.location.href = url;
      } catch {
        window.parent.postMessage({ type: 'NAVIGATE', path }, '*');
      }
    } else {
      window.location.href = url;
    }
  };

  return (
    <>
      <HamburgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />

      <header className={styles.header}>
        {/* LEFT: Hamburger + HUB button */}
        <div className={styles.headerLeft}>
          <button
            className={styles.hamburgerBtn}
            aria-label="Open Menu"
            onClick={() => setMenuOpen(true)}
          >
            <img src={`${BASE}images/btn-hamburger.png`} alt="Menu" className={styles.iconImg} />
          </button>
          <button className={styles.hubBtn} onClick={handleHubClick}>
            <img src={`${BASE}images/btn-hub.png`} alt="Hub" className={styles.hubImg} />
          </button>
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

          {/* VIP Member */}
          <button className={styles.orbBtn} onClick={() => navigateToHub('/hub/diamond-store')}>
            <img src={`${BASE}images/vip-card.png`} alt="VIP Member" className={styles.orbImg} />
          </button>

          {/* Profile / Avatar */}
          <button className={styles.orbBtn} onClick={() => navigateToHub('/hub/profile')}>
            <div className={styles.profileOrb}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className={styles.profileImg} />
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
              <span className={styles.badge}>{unreadMessages > 99 ? '99+' : unreadMessages}</span>
            )}
          </button>

          {/* Notifications — route to in-app Notification Center */}
          <a href="/notifications" className={styles.orbLink}>
            <img
              src={`${BASE}images/header-notifications.png`}
              alt="Notifications"
              className={styles.orbImg}
            />
            {notificationCount > 0 && (
              <span className={styles.badge}>
                {notificationCount > 99 ? '99+' : notificationCount}
              </span>
            )}
          </a>

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
