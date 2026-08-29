/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAMBURGER MENU — Facebook Dark Theme
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Clean, classy navigation with complete page coverage
 * No emojis - professional Facebook-style design
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { identityDNA } from '../../core/IdentityDNA';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useWalletStore } from '../../stores/useWalletStore';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { STORAGE_KEYS } from '../../lib/storage';
import { persistIdentity } from '../../lib/cachedIdentity';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { preloadRoute } from '../../utils/ChunkPreloader';
import { useUserTableSettings } from '../../hooks/useUserTableSettings';
import { TableSettingsPanel } from '../table/TableSettingsPanel';
import { ThemeSettingsModal } from '../table/ThemeSettingsModal';
import { getClubLevel, ClubLevelInfo } from '../../utils/clubLevels';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { soundService } from '../../services/SoundService';
import { AvatarGallery } from '../customization/AvatarGallery';
import AvatarCosmetics from '../avatars/AvatarCosmetics';
import { CLUB_ARENA_SUPPORT_NAV, getClubArenaNavigation } from '../../config/clubArenaNavigation';
import styles from './HamburgerMenu.module.css';

interface HamburgerMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

// Facebook Dark Theme Colors (matching globals.css CSS variables)
const colors = {
  bg: 'var(--near-black)', // #18191A
  bgSecondary: 'var(--dark-surface)', // #242526
  bgHover: 'var(--card-surface)', // #3A3B3C
  text: 'var(--off-white)', // #E4E6EB
  textSecondary: 'var(--soft-white)', // #B0B3B8
  divider: 'var(--border-subtle)', // rgba(255,255,255,0.1)
  accent: 'var(--royal-blue)', // #1877F2
  accentHover: 'var(--royal-blue-dark)', // #0D5DC7
  success: 'var(--success)', // #31A24C
  danger: 'var(--danger)', // #F02849
};

export default function HamburgerMenu({ isOpen, onClose }: HamburgerMenuProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const touchStartRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousBodyOverflowRef = useRef('');
  const navigatingRef = useRef(false);
  const dialogTitleId = useId();
  const tableSettingsId = useId();

  /**
   * LAZY INITIALIZERS (2026-08-28, first-paint flash sweep): these four
   * toggles began at hard-coded defaults and read localStorage one tick
   * later in the load effect — so an open drawer could flash the wrong
   * switch positions. The read is synchronous; do it before the first
   * paint, before any asynchronous profile refinement. The load
   * effect's async profile fetch still refines them afterwards.
   */
  const readStoredBool = (key: string, fallback: boolean): boolean => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw === 'true';
    } catch {
      return fallback;
    }
  };
  const [soundsEnabled, setSoundsEnabled] = useState(() =>
    readStoredBool(STORAGE_KEYS.SOUNDS, true)
  );
  const [vibrationsEnabled, setVibrationsEnabled] = useState(() =>
    readStoredBool(STORAGE_KEYS.VIBRATIONS, true)
  );
  /* `showBBEnabled` state DELETED 2026-08-29: it was written in three places
     and READ IN NONE — no JSX, no condition. The switch a player sees lives in
     the expandable TableSettingsPanel and reads the hook directly. What
     survives is the localStorage MIRROR below, which is a real first-paint seed
     for the next cold open; the `setState` beside it only forced a re-render
     that changed nothing on screen. */
  // Avatar from persistent header store (avoids duplicate Supabase query)
  const avatarUrl = useHeaderDataStore((s) => s.avatarUrl);
  const equippedFrame = useHeaderDataStore((s) => s.equippedFrame);
  const equippedAura = useHeaderDataStore((s) => s.equippedAura);
  const [userName, setUserName] = useState<string>('');
  const [useRealName, setUseRealName] = useState(() =>
    readStoredBool(STORAGE_KEYS.USE_REAL_NAME, false)
  );
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [isVIP, setIsVIP] = useState(false);
  const [isPlatformStaff, setIsPlatformStaff] = useState(false);
  const [clubRole, setClubRole] = useState<string | null>(null);
  const { diamonds: diamondBalance } = useWalletStore();
  // Bible V8 §11.1: User table settings (12 toggles) from Supabase
  const {
    settings: tableSettings,
    loading: tableSettingsLoading,
    toggleSetting: toggleTableSetting,
  } = useUserTableSettings(user?.id);
  /* THE ONLY WRITER of this switch's state and of its localStorage key.
     `useUserTableSettings` is the single reader of the canonical column, so
     mirroring here — rather than in a query of this component's own — is what
     removed the two-callback race described further down. The localStorage key
     is a first-paint seed for the next cold open; keeping it in step here
     means it can never disagree with the row for a whole session. */
  useEffect(() => {
    /* Wait for the row. Until it lands the hook is serving defaults, and
       writing those over the localStorage seed would show a cold-open user
       chips for a moment and then persist that as their answer. */
    if (tableSettingsLoading) return;
    try {
      localStorage.setItem(STORAGE_KEYS.SHOW_STACK_BB, String(tableSettings.show_stack_in_bb));
    } catch {
      /* private mode */
    }
  }, [tableSettings.show_stack_in_bb, tableSettingsLoading]);
  const [showTableSettings, setShowTableSettings] = useState(false);
  const [showThemeSettings, setShowThemeSettings] = useState(false);

  const location = useLocation();
  const [clubLevelInfo, setClubLevelInfo] = useState<ClubLevelInfo | null>(null);

  const match = location.pathname.match(/^\/clubs\/([a-zA-Z0-9-]+)/);
  const clubId = match ? match[1] : null;
  const navigationGroups = getClubArenaNavigation({ clubId, clubRole, isPlatformStaff });

  const isActivePath = (path: string) => {
    const current = location.pathname.replace(/\/+$/, '') || '/';
    const target = path.split('?')[0].replace(/\/+$/, '') || '/';
    return target === '/'
      ? current === '/'
      : current === target || current.startsWith(`${target}/`);
  };

  useEffect(() => {
    if (!isOpen || !clubId) {
      if (!clubId) {
        setClubLevelInfo(null);
        setClubRole(null);
      }
      return;
    }
    let isMounted = true;
    const fetchClubLevel = async () => {
      try {
        setClubRole(null);
        const resolvedId = await resolveClubUUID(clubId!);
        if (!isMounted) return;
        const { data } = await supabase
          .from('clubs')
          .select(
            'member_count, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
          )
          .eq('id', resolvedId)
          .maybeSingle();

        if (data && isMounted) {
          setClubLevelInfo(
            getClubLevel({
              level: data.level || 1,
              playerCount: data.member_count || 0,
              hierarchyUnits: data.hierarchy_units_rounded_up || 0,
              playerThresholdCurrent: data.player_threshold_current || 0,
              playerThresholdNext: data.player_threshold_next || 0,
              hierarchyThresholdCurrent: data.hierarchy_threshold_current || 0,
              hierarchyThresholdNext: data.hierarchy_threshold_next || 0,
            })
          );
        }
        if (user?.id) {
          const { data: membership, error: membershipError } = await supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolvedId)
            .eq('user_id', user.id)
            .maybeSingle();
          if (membershipError) {
            reportError(membershipError, 'HamburgerMenu.Club_membership_load_failed');
          }
          if (isMounted) setClubRole(membership?.role || null);
        }
      } catch {
        /* club-level fetch is best-effort; silent fallback to defaults above */
      }
    };
    fetchClubLevel();
    return () => {
      isMounted = false;
    };
  }, [isOpen, clubId, user?.id]);

  const drawerRef = useRef<HTMLDivElement>(null);

  // Lock background scroll, contain keyboard focus, and restore the opener.
  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    previousBodyOverflowRef.current = document.body.style.overflow;
    navigatingRef.current = false;
    document.body.style.overflow = 'hidden';

    const drawer = drawerRef.current;
    if (!drawer) return;

    const getFocusable = () =>
      Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null);

    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    drawer.addEventListener('keydown', containFocus);
    requestAnimationFrame(() => getFocusable()[0]?.focus());

    return () => {
      document.body.style.overflow = previousBodyOverflowRef.current;
      drawer.removeEventListener('keydown', containFocus);
      if (!navigatingRef.current && previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen, onClose]);

  // Load user data and settings
  useEffect(() => {
    const sounds = localStorage.getItem(STORAGE_KEYS.SOUNDS);
    const vibrations = localStorage.getItem(STORAGE_KEYS.VIBRATIONS);
    const useReal = localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME);
    if (sounds !== null) setSoundsEnabled(sounds === 'true');
    if (vibrations !== null) setVibrationsEnabled(vibrations === 'true');
    if (useReal !== null) setUseRealName(useReal === 'true');

    if (user?.id) {
      supabase
        .from('profiles')
        .select(
          'avatar_url:arena_avatar_url, username, display_name, sounds_enabled, vibrations_enabled, is_vip, tier, role'
        )
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) {
            console.warn(
              '[HamburgerMenu] Profile load failed (using localStorage fallback):',
              error.message
            );
            return;
          }
          if (data) {
            // Avatar is consumed from useHeaderDataStore — no need to set locally
            const prefUseRealName = localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME) === 'true';
            setUserName(
              prefUseRealName
                ? data.display_name || data.username || 'Player'
                : data.username || data.display_name || 'Player'
            );
            // First-paint identity cache (2026-08-28 flash sweep): what the
            // database just said is what the header and hero seat should wear
            // on the NEXT cold open, before any round trip.
            persistIdentity(user.id, {
              displayName: data.display_name || data.username || null,
              avatarUrl: data.avatar_url || null,
            });
            // These columns may not exist on profiles — use optional chaining with defaults
            if (data.sounds_enabled !== undefined && data.sounds_enabled !== null) {
              setSoundsEnabled(data.sounds_enabled);
              localStorage.setItem(STORAGE_KEYS.SOUNDS, String(data.sounds_enabled));
            }
            if (data.vibrations_enabled !== undefined && data.vibrations_enabled !== null) {
              setVibrationsEnabled(data.vibrations_enabled);
              localStorage.setItem(STORAGE_KEYS.VIBRATIONS, String(data.vibrations_enabled));
            }
            /* `profiles.show_stack_bb` is NOT read here any more — see the note
               where the second query used to be. */
            setIsVIP(data.is_vip || data.tier === 'vip' || false);
            setIsPlatformStaff(data.role === 'admin' || data.role === 'super_admin');
          }
        });

      /* ── WHY THERE IS NO show_stack_bb QUERY HERE ANY MORE (2026-08-29) ──
       *
       * Dan 2026-08-25 established the rule this still obeys: the felt reads
       * `user_table_settings.show_stack_in_bb`, `profiles.show_stack_bb` is a
       * legacy mirror, and whatever the table is actually obeying is what this
       * switch must display. No row means the user never chose, which is
       * chips, which is the default.
       *
       * The fix at the time added a SECOND query beside the profiles one, and
       * both wrote `setShowBBEnabled` and the same localStorage key from
       * unordered `.then()` callbacks. Whichever resolved last won, so the
       * legacy value could still land on top of the canonical one — the exact
       * disagreement the fix was written to end, now decided by network
       * timing rather than by a rule.
       *
       * Both queries are gone. `useUserTableSettings` is already mounted above
       * and already reads this column, on a request that is de-duplicated
       * across every consumer in the tab; the effect beside it mirrors its
       * value into state and into localStorage. One reader, one writer, no
       * race.
       *
       * The legacy `profiles.show_stack_bb` is now dead in BOTH directions: the
       * reads went with that fix, and `handleShowBBToggle` — the only thing
       * that ever wrote it — turned out to have had no caller since the day it
       * was added, and was deleted on 2026-08-29. An earlier version of this
       * comment claimed it was "still WRITTEN ... for older surfaces". It was
       * not. `user_table_settings.show_stack_in_bb` is the only copy.
       */
    }
  }, [user?.id]);

  // ── BUS LISTENER: Sync name when profile is updated elsewhere ──
  useMasterBusSubscription('USER_PROFILE_LOADED', (payload) => {
    // Avatar syncs automatically via useHeaderDataStore
    if (payload?.displayName) setUserName(payload.displayName);
  });

  // Swipe-to-close gesture
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartRef.current === null) return;
    const touchEnd = e.changedTouches[0].clientX;
    const diff = touchStartRef.current - touchEnd;
    if (diff > 50) onClose();
    touchStartRef.current = null;
  };

  // Navigate and close
  const handleNavigate = (path: string) => {
    navigatingRef.current = true;
    navigate(path);
    onClose();
  };

  // Prefetch page chunk on hover — so page loads instantly when clicked
  const handleItemHover = (path: string) => {
    preloadRoute(path);
  };

  // Settings update with optimistic rollback
  const updateSetting = async (
    localKey: string,
    dbKey: string,
    value: boolean,
    rollback: () => void
  ) => {
    try {
      localStorage.setItem(localKey, String(value));
    } catch (err) {
      reportError(err, 'HamburgerMenu.Error');
    }
    if (user?.id) {
      try {
        const { error: updateErr } = await supabase
          .from('profiles')
          .update({ [dbKey]: value })
          .eq('id', user.id);
        if (updateErr) {
          reportError(updateErr, 'HamburgerMenu.Setting_save_failed');
          toast.error('Setting could not be saved. Please try again.');
          rollback();
          try {
            localStorage.setItem(localKey, String(!value));
          } catch {
            /* */
          }
        }
      } catch (error) {
        reportError(error, 'HamburgerMenu.Error_updating_setting');
        toast.error('Setting could not be saved. Please try again.');
        rollback();
        try {
          localStorage.setItem(localKey, String(!value));
        } catch {
          /* */
        }
      }
    }
  };

  const handleSoundsToggle = () => {
    const newValue = !soundsEnabled;
    setSoundsEnabled(newValue);
    updateSetting(STORAGE_KEYS.SOUNDS, 'sounds_enabled', newValue, () =>
      setSoundsEnabled(!newValue)
    );
    // SOUND AUDIT 2026-08-27: this toggle wrote only STORAGE_KEYS.SOUNDS.
    // The shared gate fails closed on EITHER key, so a player who had muted
    // in-table ('ca_sound_enabled'='false') and then flipped this switch ON
    // got a switch reading ON with a still-silent app. setEnabled() persists
    // the choice to BOTH gate keys so the switches always agree.
    soundService.setEnabled(newValue);
    masterBus.emit('SETTINGS_CHANGED', { setting: 'isSoundEnabled', value: newValue });
  };

  const handleVibrationsToggle = () => {
    const newValue = !vibrationsEnabled;
    setVibrationsEnabled(newValue);
    updateSetting(STORAGE_KEYS.VIBRATIONS, 'vibrations_enabled', newValue, () =>
      setVibrationsEnabled(!newValue)
    );
    /* 2026-08-26: the key was `vibrationsEnabled`, which is NOT a field of
       useTableSettings — the store calls it `isHapticEnabled` — so the
       whitelist at useTableSettings dropped this event silently and an open
       table never learned haptics had been turned off. (The localStorage
       write above still worked, which is why it half-functioned and was easy
       to miss.) The store's own name is what the bus must carry. */
    masterBus.emit('SETTINGS_CHANGED', { setting: 'isHapticEnabled', value: newValue });
  };

  /* ── `handleShowBBToggle` DELETED 2026-08-29 ────────────────────────────
     It had never had a caller. `git log -S` puts it back to the commit that
     added it: no `onClick`, no "Show Stack In Big Blinds" control anywhere in
     this component's JSX — that switch lives in the expandable
     `TableSettingsPanel`, which writes through `useUserTableSettings` on its
     own.

     It was left in place on 2026-08-29 alongside a fresh comment claiming
     "the legacy column is still WRITTEN by handleShowBBToggle for older
     surfaces, which is a mirror rather than a second opinion." That was false
     in both halves: the function wrote nothing because nothing called it, and
     the same commit had just deleted the two `.select()` calls that read
     `profiles.show_stack_bb`. The legacy column is dead in both directions.

     That is the more useful fact and it is why this note is here rather than
     nothing: a future reader looking for the legacy mirror will not find one,
     and should not add one back. `user_table_settings.show_stack_in_bb` is the
     only copy of this preference. */

  const handleResetTutorial = async () => {
    localStorage.removeItem(STORAGE_KEYS.INTRO_SHOWN);
    localStorage.removeItem(STORAGE_KEYS.TUTORIAL_COMPLETED);
    /**
     * There is no `profiles.tutorial_completed` column and nothing anywhere
     * reads one. This used to write it, which was rejected on every reset and
     * reported as a failure the user never saw - and had the column existed,
     * the reset would still have worked exactly as it does now, because
     * localStorage above is the only thing the intro gate consults. Removing
     * the write loses no behaviour; it removes a control that was never wired
     * to anything. Making it a real cross-device flag needs a reader first.
     */
    toast.info('Tutorial reset! Refresh the page to see the intro again.');
    onClose();
  };

  const handleUseRealNameToggle = () => {
    const newValue = !useRealName;
    setUseRealName(newValue);
    updateSetting(STORAGE_KEYS.USE_REAL_NAME, 'use_real_name', newValue, () =>
      setUseRealName(!newValue)
    );
    masterBus.emit('SETTINGS_CHANGED', { setting: 'useRealName', value: newValue });

    // Switch the local preview
    if (user?.id) {
      supabase
        .from('profiles')
        .select('username, display_name')
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setUserName(
              newValue
                ? data.display_name || data.username || 'Player'
                : data.username || data.display_name || 'Player'
            );
          }
        });
    }
  };

  const handleLogOut = async () => {
    try {
      // CRITICAL: Use identityDNA.logout() — NOT supabase.auth.signOut() directly.
      // IdentityDNA owns the signOut lifecycle: it triggers the auth state listener
      // which clears the Zustand store, destroys PostgresSyncHooks, and emits
      // AUTH_STATE_CHANGED. AuthGuard then detects the sign-out and redirects to /auth.
      await identityDNA.logout();
      onClose();
      // AuthGuard handles the redirect to /auth — no manual navigate needed
    } catch (error) {
      reportError(error, 'HamburgerMenu.Error_logging_out');
      // Clear store as fallback — AuthGuard will detect and redirect to /auth
      const { useUserStore } = await import('../../stores/useUserStore');
      useUserStore.getState().logout();
      onClose();
    }
  };

  // Shared styles
  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: colors.divider,
    margin: '8px 16px',
  };

  // Do not leave an off-canvas tree full of focusable controls in the tab order.
  if (!isOpen) return null;

  return (
    <>
      {/* Animation keyframes */}
      <style>{`
                @keyframes slideInLeft {
                    from {
                        opacity: 0;
                        transform: translateX(-12px);
                    }
                    to {
                        opacity: 1;
                        transform: translateX(0);
                    }
                }
            `}</style>

      {/* Backdrop */}
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <div
        ref={drawerRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={`${styles.drawer} ${styles.drawerOpen}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        tabIndex={-1}
      >
        <div className={styles.utilityRail}>
          <div className={styles.brandLockup}>
            <img
              src="/hub/club-arena/images/diamond-icon.webp"
              alt=""
              className={styles.brandMark}
            />
            <span>
              <span className={styles.brandEyebrow}>Smarter.Poker</span>
              <span className={styles.brandTitle} id={dialogTitleId}>
                Club Arena
              </span>
            </span>
          </div>
          <button type="button" onClick={onClose} className={styles.closeButton}>
            Close
          </button>
        </div>

        {/* User Profile Card */}
        <button
          type="button"
          onClick={() => handleNavigate('/profile')}
          className={styles.profilePlate}
        >
          {/* Wrapped so the equipped frame/aura has a positioned, radius-owning
              parent to fill. The <img> itself cannot be that parent: an
              absolutely positioned child of an <img> is not a thing. */}
          <div
            style={{
              position: 'relative',
              width: 48,
              height: 48,
              borderRadius: '50%',
              flexShrink: 0,
              fontSize: 11,
            }}
          >
            <img
              loading="lazy"
              decoding="async"
              src={avatarUrl || generateDefaultAvatar()}
              alt=""
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                objectFit: 'cover',
                border: `2px solid ${colors.divider}`,
              }}
            />
            <AvatarCosmetics frame={equippedFrame} aura={equippedAura} />
          </div>
          <div>
            <div className={styles.profileName}>
              {userName || 'Player'}
              {isVIP && (
                <span className={styles.vipBadge} title="VIP Diamond Member">
                  VIP
                </span>
              )}
            </div>
            <div className={styles.profileMeta}>
              <span>View Profile</span>
              {diamondBalance > 0 && (
                <span className={styles.diamondBalance}>{diamondBalance.toLocaleString()} DIA</span>
              )}
            </div>
          </div>
          <span className={styles.navArrow}>›</span>
        </button>

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    CLUB LEVEL & PROGRESSION
                ═══════════════════════════════════════════════════════════════ */}
        {clubLevelInfo && (
          <>
            <div style={{ padding: '8px 16px 16px' }}>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    background:
                      clubLevelInfo.gradient || 'linear-gradient(to right, #4b5563, #374151)',
                    padding: '4px 10px',
                    borderRadius: '12px',
                    color: 'white',
                    fontWeight: 700,
                    width: 'fit-content',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  <span style={{ fontSize: '13px', marginRight: '6px' }}>
                    Lv.{clubLevelInfo.level}
                  </span>
                  <span style={{ fontSize: '11px', opacity: 0.9 }}>{clubLevelInfo.tierLabel}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      height: '8px',
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)',
                    }}
                  >
                    <div
                      style={{
                        width: `${clubLevelInfo.progressPercent}%`,
                        height: '100%',
                        background:
                          clubLevelInfo.gradient || 'linear-gradient(to right, #4b5563, #374151)',
                        borderRadius: '4px',
                        boxShadow: '0 0 10px rgba(255,255,255,0.2)',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: '12px', color: colors.textSecondary, fontWeight: 700 }}>
                    {clubLevelInfo.progressPercent}%
                  </span>
                </div>
              </div>
            </div>
            <div style={dividerStyle} />
          </>
        )}

        <div className={styles.quickActions}>
          <button
            type="button"
            className={styles.quickAction}
            onClick={() => handleNavigate('/?create=club')}
          >
            Create Club
          </button>
          <button
            type="button"
            className={styles.quickAction}
            onClick={() => handleNavigate('/unions/create')}
          >
            Create Union
          </button>
        </div>

        {navigationGroups.map((group) => (
          <section className={styles.navGroup} key={group.label} aria-label={group.label}>
            <h2 className={styles.sectionHeader}>{group.label}</h2>
            {group.items.map((item) => {
              const active = isActivePath(item.path);
              return (
                <button
                  type="button"
                  key={item.path}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                  onClick={() => handleNavigate(item.path)}
                  onMouseEnter={() => handleItemHover(item.path)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span>
                    <span className={styles.navLabel}>{item.label}</span>
                    <span className={styles.navDescription}>{item.description}</span>
                  </span>
                  <span className={styles.navArrow}>{item.external ? '↗' : '›'}</span>
                </button>
              );
            })}
          </section>
        ))}

        <button
          type="button"
          className={`${styles.quickAction} ${styles.quickActionFull}`}
          onClick={() => setShowAvatarGallery(true)}
        >
          Change Avatar
        </button>

        <div className={styles.divider} />

        {/* ═══════════════════════════════════════════════════════════════
                    SETTINGS
                ═══════════════════════════════════════════════════════════════ */}
        <section className={styles.settingsDeck} aria-label="Settings">
          <h2 className={styles.sectionHeader}>Settings & Appearance</h2>

          {/* Sounds Toggle */}
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Sounds</span>
            <button
              type="button"
              onClick={handleSoundsToggle}
              aria-label="Sounds"
              aria-checked={soundsEnabled}
              role="switch"
              className={styles.toggleButton}
            >
              <span className={styles.toggleTrack} aria-hidden="true">
                <span className={styles.toggleThumb} />
              </span>
            </button>
          </div>

          {/* Vibrations Toggle */}
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Vibrations</span>
            <button
              type="button"
              onClick={handleVibrationsToggle}
              aria-label="Vibrations"
              aria-checked={vibrationsEnabled}
              role="switch"
              className={styles.toggleButton}
            >
              <span className={styles.toggleTrack} aria-hidden="true">
                <span className={styles.toggleThumb} />
              </span>
            </button>
          </div>

          {/* Use Real Name Toggle */}
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Use Real Name (Vs Alias)</span>
            <button
              type="button"
              onClick={handleUseRealNameToggle}
              aria-label="Use real name instead of poker alias"
              aria-checked={useRealName}
              role="switch"
              className={styles.toggleButton}
            >
              <span className={styles.toggleTrack} aria-hidden="true">
                <span className={styles.toggleThumb} />
              </span>
            </button>
          </div>

          <button
            type="button"
            className={styles.navItem}
            onClick={() => setShowThemeSettings(true)}
            aria-label="Open Table Studio"
          >
            <span>
              <span className={styles.navLabel}>Table Studio</span>
              <span className={styles.navDescription}>
                Themes, Tables, Buttons, Backgrounds, And Card Backs
              </span>
            </span>
            <span className={styles.navArrow} aria-hidden="true">
              ›
            </span>
          </button>

          {/* Bible V8 §11.1: Table Settings — 12 toggles (expandable) */}
          <button
            type="button"
            className={styles.settingsDisclosure}
            onClick={() => setShowTableSettings(!showTableSettings)}
            aria-expanded={showTableSettings}
            aria-controls={tableSettingsId}
          >
            <span className={styles.settingLabel}>Table Settings</span>
            <span
              aria-hidden="true"
              style={{
                color: colors.textSecondary,
                fontSize: 18,
                transform: showTableSettings ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
              }}
            >
              ›
            </span>
          </button>
          {showTableSettings && (
            <div id={tableSettingsId} style={{ padding: '0 0 8px' }}>
              <TableSettingsPanel
                settings={tableSettings}
                loading={tableSettingsLoading}
                onToggle={toggleTableSetting}
                mode="inline"
              />
            </div>
          )}

          {[
            {
              label: 'App Settings',
              path: '/settings',
              description: 'Audio, gameplay, privacy, and account',
            },
            {
              label: 'Notifications',
              path: '/notifications',
              description: 'Alerts and notification preferences',
            },
          ].map((item) => {
            const active = isActivePath(item.path);
            return (
              <button
                type="button"
                key={item.path}
                className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                onClick={() => handleNavigate(item.path)}
                onMouseEnter={() => handleItemHover(item.path)}
                aria-current={active ? 'page' : undefined}
              >
                <span>
                  <span className={styles.navLabel}>{item.label}</span>
                  <span className={styles.navDescription}>{item.description}</span>
                </span>
                <span className={styles.navArrow}>›</span>
              </button>
            );
          })}
        </section>

        <div className={styles.divider} />

        <section className={styles.navGroup} aria-label="Support and legal">
          <h2 className={styles.sectionHeader}>Support & Legal</h2>
          {CLUB_ARENA_SUPPORT_NAV.map((item) => {
            const active = isActivePath(item.path);
            return (
              <button
                type="button"
                key={item.path}
                className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                onClick={() => handleNavigate(item.path)}
                onMouseEnter={() => handleItemHover(item.path)}
                aria-current={active ? 'page' : undefined}
              >
                <span>
                  <span className={styles.navLabel}>{item.label}</span>
                  <span className={styles.navDescription}>{item.description}</span>
                </span>
                <span className={styles.navArrow}>›</span>
              </button>
            );
          })}
        </section>

        <div className={styles.quickActions}>
          <button type="button" className={styles.quickAction} onClick={handleResetTutorial}>
            Reset Tutorial
          </button>
          <button
            type="button"
            className={`${styles.quickAction} ${styles.quickActionDanger}`}
            onClick={handleLogOut}
          >
            Log Out
          </button>
        </div>

        <div className={styles.footer}>Club Arena · Command Deck V1.12</div>
      </div>

      {/* Avatar Gallery Modal */}
      {user && (
        <AvatarGallery
          isOpen={showAvatarGallery}
          onClose={() => setShowAvatarGallery(false)}
          userId={user.id}
          currentAvatarUrl={avatarUrl || generateDefaultAvatar()}
          isVip={isVIP}
        />
      )}

      {/* Bible V8 §11.2: Theme Settings Modal */}
      <ThemeSettingsModal
        isOpen={showThemeSettings}
        onClose={() => setShowThemeSettings(false)}
        userId={user?.id || ''}
        isVip={isVIP}
      />
    </>
  );
}
