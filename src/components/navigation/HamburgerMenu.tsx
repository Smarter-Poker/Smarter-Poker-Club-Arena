/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAMBURGER MENU — Facebook Dark Theme
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Clean, classy navigation with complete page coverage
 * No emojis - professional Facebook-style design
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { preloadRoute } from '../../utils/ChunkPreloader';
import { useUserTableSettings } from '../../hooks/useUserTableSettings';
import { TableSettingsPanel } from '../table/TableSettingsPanel';
import { ThemeSettingsModal } from '../table/ThemeSettingsModal';
import { getClubLevel, ClubLevelInfo } from '../../utils/clubLevels';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { AvatarGallery } from '../customization/AvatarGallery';
import AvatarCosmetics from '../avatars/AvatarCosmetics';
import { isCardBackUnlocked } from '../table/CardImage';

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

  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const [vibrationsEnabled, setVibrationsEnabled] = useState(true);
  const [showBBEnabled, setShowBBEnabled] = useState(false);
  // Avatar from persistent header store (avoids duplicate Supabase query)
  const avatarUrl = useHeaderDataStore((s) => s.avatarUrl);
  const equippedFrame = useHeaderDataStore((s) => s.equippedFrame);
  const equippedAura = useHeaderDataStore((s) => s.equippedAura);
  const [userName, setUserName] = useState<string>('');
  const [useRealName, setUseRealName] = useState(false);
  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [isVIP, setIsVIP] = useState(false);
  /** Paid card backs this player has actually bought (feature_purchases). */
  const [ownedCardBacks, setOwnedCardBacks] = useState<string[]>([]);
  const { diamonds: diamondBalance } = useWalletStore();
  const [selectedCardColor, setSelectedCardColor] = useState(() => {
    try {
      // 'default' was never one of the ids this menu offers, so a player who
      // had not picked before saw NO tile highlighted at all - the same defect
      // FIX-D7 fixed for the dealer button. classic_blue is the app default.
      return localStorage.getItem(STORAGE_KEYS.CARD_COLOR) || 'classic_blue';
    } catch (err) {
      reportError(err, 'HamburgerMenu.Error');
      return 'classic_blue';
    }
  });

  // Bible V8 §11.1: User table settings (12 toggles) from Supabase
  const {
    settings: tableSettings,
    loading: tableSettingsLoading,
    toggleSetting: toggleTableSetting,
  } = useUserTableSettings(user?.id);
  const [showTableSettings, setShowTableSettings] = useState(false);
  const [showThemeSettings, setShowThemeSettings] = useState(false);

  const location = useLocation();
  const [clubLevelInfo, setClubLevelInfo] = useState<ClubLevelInfo | null>(null);

  const match = location.pathname.match(/^\/clubs\/([a-zA-Z0-9-]+)/);
  const clubId = match ? match[1] : null;

  useEffect(() => {
    if (!isOpen || !clubId) {
      if (!clubId) setClubLevelInfo(null);
      return;
    }
    let isMounted = true;
    const fetchClubLevel = async () => {
      try {
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
      } catch {
        /* club-level fetch is best-effort; silent fallback to defaults above */
      }
    };
    fetchClubLevel();
    return () => {
      isMounted = false;
    };
  }, [isOpen, clubId]);

  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  // Prevent body scroll when menu is open + focus trap
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      // Focus trap: keep Tab cycling within the drawer
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = drawer.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const trapFocus = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      };
      drawer.addEventListener('keydown', trapFocus);
      first?.focus();
      return () => {
        document.body.style.overflow = '';
        drawer.removeEventListener('keydown', trapFocus);
      };
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Load user data and settings
  useEffect(() => {
    const sounds = localStorage.getItem(STORAGE_KEYS.SOUNDS);
    const vibrations = localStorage.getItem(STORAGE_KEYS.VIBRATIONS);
    const showBB = localStorage.getItem(STORAGE_KEYS.SHOW_STACK_BB);
    const useReal = localStorage.getItem(STORAGE_KEYS.USE_REAL_NAME);
    if (sounds !== null) setSoundsEnabled(sounds === 'true');
    if (vibrations !== null) setVibrationsEnabled(vibrations === 'true');
    if (showBB !== null) setShowBBEnabled(showBB === 'true');
    if (useReal !== null) setUseRealName(useReal === 'true');

    if (user?.id) {
      supabase
        .from('profiles')
        .select(
          'avatar_url:arena_avatar_url, username, display_name, sounds_enabled, vibrations_enabled, show_stack_bb, is_vip, tier'
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
            // These columns may not exist on profiles — use optional chaining with defaults
            if (data.sounds_enabled !== undefined && data.sounds_enabled !== null) {
              setSoundsEnabled(data.sounds_enabled);
              localStorage.setItem(STORAGE_KEYS.SOUNDS, String(data.sounds_enabled));
            }
            if (data.vibrations_enabled !== undefined && data.vibrations_enabled !== null) {
              setVibrationsEnabled(data.vibrations_enabled);
              localStorage.setItem(STORAGE_KEYS.VIBRATIONS, String(data.vibrations_enabled));
            }
            if (data.show_stack_bb !== undefined && data.show_stack_bb !== null) {
              setShowBBEnabled(data.show_stack_bb);
              localStorage.setItem(STORAGE_KEYS.SHOW_STACK_BB, String(data.show_stack_bb));
            }
            setIsVIP(data.is_vip || data.tier === 'vip' || false);
          }
        });

      /* Dan 2026-08-25: `profiles.show_stack_bb` above is the LEGACY copy of
       * this preference. The felt reads `user_table_settings.show_stack_in_bb`,
       * and before today only this menu wrote the legacy column — so an account
       * carrying an old `true` there showed this switch ON while every table
       * drew chips. Whatever the table is actually obeying is what this switch
       * must display, so the canonical row wins when it exists. No row means
       * the user never chose, which is chips, which is the default. */
      supabase
        .from('user_table_settings')
        .select('show_stack_in_bb')
        .eq('user_id', user.id)
        .maybeSingle()
        .then(({ data: uts, error: utsErr }) => {
          if (utsErr || !uts || uts.show_stack_in_bb === null) return;
          setShowBBEnabled(uts.show_stack_in_bb);
          try {
            localStorage.setItem(STORAGE_KEYS.SHOW_STACK_BB, String(uts.show_stack_in_bb));
          } catch {
            /* private mode */
          }
        });

      // Card backs bought with diamonds. Needed because this menu decides
      // whether a paid design is selectable — see the gate on the swatches.
      supabase
        .from('feature_purchases')
        .select('feature')
        .eq('user_id', user.id)
        .like('feature', 'card_back_%')
        .then(({ data, error }) => {
          if (error) {
            reportError(error, 'HamburgerMenu.Owned_card_backs_load_failed');
            return;
          }
          setOwnedCardBacks(
            (data || []).map((r: { feature: string }) => r.feature.replace('card_back_', ''))
          );
        });
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
    masterBus.emit('SETTINGS_CHANGED', { setting: 'isSoundEnabled', value: newValue });
  };

  const handleVibrationsToggle = () => {
    const newValue = !vibrationsEnabled;
    setVibrationsEnabled(newValue);
    updateSetting(STORAGE_KEYS.VIBRATIONS, 'vibrations_enabled', newValue, () =>
      setVibrationsEnabled(!newValue)
    );
    masterBus.emit('SETTINGS_CHANGED', { setting: 'vibrationsEnabled', value: newValue });
  };

  const handleShowBBToggle = () => {
    const newValue = !showBBEnabled;
    setShowBBEnabled(newValue);
    updateSetting(STORAGE_KEYS.SHOW_STACK_BB, 'show_stack_bb', newValue, () =>
      setShowBBEnabled(!newValue)
    );
    /* Dan 2026-08-25 (binding): "tournaments and cash games should always be
     * defaulted to actual totals unless the user changes the setting to BB."
     *
     * TWO bugs lived in this one line. The bus key was `showStackInBB`, but
     * useUserTableSettings only accepts a key that IS a field of
     * DEFAULT_USER_TABLE_SETTINGS — `show_stack_in_bb` — so it dropped this
     * event on the floor and the table never changed. And the value only ever
     * landed in `profiles.show_stack_bb`, while the felt reads
     * `user_table_settings.show_stack_in_bb`: two columns for one preference,
     * free to disagree forever. The canonical one is now written here too, so
     * this switch and the in-table switch are the same switch.
     *
     * The `profiles` write above stays for now — other surfaces still read it —
     * but user_table_settings is the source of truth for what the table draws. */
    masterBus.emit('SETTINGS_CHANGED', { setting: 'show_stack_in_bb', value: newValue });
    if (user?.id) {
      void supabase
        .from('user_table_settings')
        .upsert({ user_id: user.id, show_stack_in_bb: newValue }, { onConflict: 'user_id' })
        .then(({ error: bbErr }) => {
          if (bbErr) reportError(bbErr, 'HamburgerMenu.Show_stack_bb_save_failed');
        });
    }
  };

  const handleResetTutorial = async () => {
    localStorage.removeItem(STORAGE_KEYS.INTRO_SHOWN);
    localStorage.removeItem(STORAGE_KEYS.TUTORIAL_COMPLETED);
    if (user?.id) {
      try {
        const { error: resetErr } = await supabase
          .from('profiles')
          .update({ tutorial_completed: false })
          .eq('id', user.id);
        if (resetErr) reportError(resetErr, 'HamburgerMenu.Tutorial_reset_save_failed');
      } catch (error) {
        reportError(error, 'HamburgerMenu.Error_resetting_tutorial');
      }
    }
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
  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    margin: 0,
    padding: '16px 16px 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  };

  const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    cursor: 'pointer',
    borderRadius: 8,
    margin: '0 8px',
    transition: 'background-color 0.15s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: colors.divider,
    margin: '8px 16px',
  };

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
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            zIndex: 1100,
          }}
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: '100%',
          maxWidth: 320,
          backgroundColor: '#18191a' /* Solid background to prevent see-through */,
          boxShadow: '4px 0 20px rgba(0, 0, 0, 0.5)',
          zIndex: 1200,
          transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.3s ease',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          paddingBottom: 80,
        }}
      >
        {/* Close button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 12px 8px' }}>
          <button
            onClick={onClose}
            style={{
              background: colors.bgHover,
              border: 'none',
              padding: '8px 16px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: colors.text,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            Close
          </button>
        </div>

        {/* User Profile Card */}
        <div
          onClick={() => handleNavigate('/profile')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            margin: '0 12px 12px',
            background: colors.bgSecondary,
            borderRadius: 12,
            cursor: 'pointer',
          }}
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
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 16,
                color: colors.text,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {userName || 'Player'}
              {isVIP && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 800,
                    color: '#fbbf24',
                    letterSpacing: '0.05em',
                  }}
                  title="VIP Diamond Member"
                >
                  VIP
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 13,
                color: colors.textSecondary,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>View Profile</span>
              {diamondBalance > 0 && (
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>
                  {diamondBalance.toLocaleString()} DIA
                </span>
              )}
            </div>
          </div>
          <span style={{ color: colors.textSecondary, fontSize: 18 }}>›</span>
        </div>

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

        {/* ═══════════════════════════════════════════════════════════════
                    GAME MODES
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Game Modes</div>
        {[
          { label: 'Home', path: '/' },
          { label: 'Tournaments', path: '/tournaments' },
          { label: 'Tournament Lobby', path: '/tournament-lobby' },
          { label: 'Tournament Results', path: '/tournament-results' },
          { label: 'Hand History', path: '/hand-history' },
          { label: 'Hand Replayer', path: '/hands' },
          { label: 'Session History', path: '/history' },
          { label: 'Player Sessions', path: '/player-sessions' },
          { label: 'Leaderboard', path: '/leaderboard' },
          { label: 'Marketplace', path: '/marketplace' },
        ].map((item, i) => (
          <div
            key={`games-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    CLUBS
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Clubs</div>
        {[
          { label: 'My Clubs', path: '/clubs' },
          { label: 'Create Club', path: '/clubs/create' },
          { label: 'Find Player', path: '/search' },
          { label: 'Messages', path: '/messages' },
          { label: 'Club Messages', path: '/messages/clubs' },
          { label: 'Players', path: '/players' },
          { label: 'Cashier', path: '/cashier' },
        ].map((item, i) => (
          <div
            key={`clubs-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 8) * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    UNIONS
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Unions</div>
        {[
          { label: 'Browse Unions', path: '/unions' },
          { label: 'Create Union', path: '/unions/create' },
        ].map((item, i) => (
          <div
            key={`unions-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 15) * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    PLAYER
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Player</div>
        {[
          { label: 'My Profile', path: '/profile' },
          { label: 'My Wallet', path: '/wallet' },
          { label: 'Achievements', path: '/achievements' },
          { label: 'Player Stats', path: '/stats' },
          { label: 'VIP Status', path: '/vip' },
          { label: 'Rakeback', path: '/rakeback' },
          { label: 'Promotions', path: '/promotions' },
          { label: 'Bonuses', path: '/bonuses' },
          { label: 'Transactions', path: '/transactions' },
          { label: 'Friends', path: '/friends' },
          { label: 'Waitlist', path: '/waitlist' },
          { label: 'Invite Players', path: '/invite' },
        ].map((item, i) => (
          <div
            key={`player-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 17) * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        {/* Avatar Customization Trigger */}
        <div
          onClick={() => setShowAvatarGallery(true)}
          style={{
            ...menuItemStyle,
            animation: isOpen
              ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(12 + 17) * 30}ms both`
              : 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = colors.bgHover;
            e.currentTarget.style.transform = 'translateX(4px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.transform = 'translateX(0)';
          }}
        >
          <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
            Change Avatar
          </span>
          <span style={{ color: colors.textSecondary }}>›</span>
        </div>

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    AGENT & ADMIN
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Agent & Admin</div>
        {[
          { label: 'Agent Management', path: '/agent-management' },
          { label: 'Agent Dashboard', path: '/agent-dashboard' },
          { label: 'Club Dashboard', path: '/data' },
          { label: 'Club Settings', path: '/admin' },
          { label: 'Anti-Cheat', path: '/anti-cheat' },
        ].map((item, i) => (
          <div
            key={`admin-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 29) * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    SETTINGS
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Settings</div>

        {/* Sounds Toggle */}
        <div style={{ ...menuItemStyle, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>Sounds</span>
          <button
            onClick={handleSoundsToggle}
            aria-checked={soundsEnabled}
            role="switch"
            style={{
              width: 52,
              height: 28,
              borderRadius: 14,
              border: soundsEnabled ? '2px solid #4ade80' : '2px solid #6b7280',
              padding: 2,
              cursor: 'pointer',
              backgroundColor: soundsEnabled ? '#22c55e' : '#374151',
              transition: 'all 0.25s ease',
              display: 'flex',
              alignItems: 'center',
              position: 'relative' as const,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                transform: soundsEnabled ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform 0.25s ease',
              }}
            />
          </button>
        </div>

        {/* Vibrations Toggle */}
        <div style={{ ...menuItemStyle, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>Vibrations</span>
          <button
            onClick={handleVibrationsToggle}
            aria-checked={vibrationsEnabled}
            role="switch"
            style={{
              width: 52,
              height: 28,
              borderRadius: 14,
              border: vibrationsEnabled ? '2px solid #4ade80' : '2px solid #6b7280',
              padding: 2,
              cursor: 'pointer',
              backgroundColor: vibrationsEnabled ? '#22c55e' : '#374151',
              transition: 'all 0.25s ease',
              display: 'flex',
              alignItems: 'center',
              position: 'relative' as const,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                transform: vibrationsEnabled ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform 0.25s ease',
              }}
            />
          </button>
        </div>

        {/* Use Real Name Toggle */}
        <div style={{ ...menuItemStyle, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>
            Use Real Name (Vs Alias)
          </span>
          <button
            onClick={handleUseRealNameToggle}
            aria-checked={useRealName}
            role="switch"
            style={{
              width: 52,
              height: 28,
              borderRadius: 14,
              border: useRealName ? '2px solid #4ade80' : '2px solid #6b7280',
              padding: 2,
              cursor: 'pointer',
              backgroundColor: useRealName ? '#22c55e' : '#374151',
              transition: 'all 0.25s ease',
              display: 'flex',
              alignItems: 'center',
              position: 'relative' as const,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                transform: useRealName ? 'translateX(24px)' : 'translateX(0)',
                transition: 'transform 0.25s ease',
              }}
            />
          </button>
        </div>

        {/* Bible V8 §11.1: Table Settings — 12 toggles (expandable) */}
        <div
          style={{
            ...menuItemStyle,
            justifyContent: 'space-between',
          }}
          onClick={() => setShowTableSettings(!showTableSettings)}
        >
          <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>Table Settings</span>
          <span
            style={{
              color: colors.textSecondary,
              fontSize: 18,
              transform: showTableSettings ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
            }}
          >
            ›
          </span>
        </div>
        {showTableSettings && (
          <div style={{ padding: '0 0 8px' }}>
            <TableSettingsPanel
              settings={tableSettings}
              loading={tableSettingsLoading}
              onToggle={toggleTableSetting}
              mode="inline"
              onOpenThemeSettings={() => setShowThemeSettings(true)}
            />
          </div>
        )}

        {/* #6: Card Color Customization */}
        <div style={sectionHeaderStyle}>Card Colors</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            padding: '8px 16px 12px',
          }}
        >
          {/*
            THE ONLY IDS THAT ARE REAL CARD BACKS.

            This list used to read default / emerald / crimson / royal / gold /
            midnight / obsidian / neon. Six of those eight match NOTHING - not
            CARD_BACK_IDS in CardImage.tsx, not CARD_BACK_ALIASES - so
            normalizeCardBack sent every one of them to classic_blue. Every tile
            painted the same navy back and picking any of them changed nothing
            on the felt.

            That is the identical defect Dan recorded in ThemeSettingsModal on
            2026-08-20 (standard-red / premium-gold / premium-platinum, same
            outcome). It was fixed there and left standing here, because the two
            menus keep their own copy of the catalogue.

            Every id here is in CARD_BACK_IDS and has artwork on disk under
            public/cards/backs/table/. neon, diamond, dragon and galaxy are real
            designs this menu was never offering at all.
            vipOnly mirrors it too, so this menu and the shop agree on what is
            paid rather than offering a premium back as if it were free.
          */}
          {[
            {
              id: 'classic_blue',
              name: 'Classic Blue',
              bg: 'linear-gradient(135deg, #1e3a5f, #0d2137)',
              vipOnly: false,
            },
            {
              id: 'classic_red',
              name: 'Classic Red',
              bg: 'linear-gradient(135deg, #8b0000, #4a0000)',
              vipOnly: false,
            },
            {
              id: 'royal',
              name: 'Royal',
              bg: 'linear-gradient(135deg, #4a0080, #1a0030)',
              vipOnly: false,
            },
            {
              id: 'gold',
              name: 'Premium Gold',
              bg: 'linear-gradient(135deg, #ffd700, #b8860b)',
              vipOnly: true,
            },
            {
              id: 'holographic',
              name: 'Holographic',
              bg: 'linear-gradient(135deg, #d3d3d3, #a9a9a9)',
              vipOnly: true,
            },
            {
              id: 'carbon',
              name: 'Carbon Fiber',
              bg: 'linear-gradient(135deg, #434343, #000000)',
              vipOnly: true,
            },
            {
              id: 'neon',
              name: 'Neon',
              bg: 'linear-gradient(135deg, #00f0ff, #0066ff)',
              vipOnly: true,
            },
            {
              id: 'diamond',
              name: 'Diamond',
              bg: 'linear-gradient(135deg, #b9f2ff, #4aa3c7)',
              vipOnly: true,
            },
            {
              id: 'dragon',
              name: 'Dragon',
              bg: 'linear-gradient(135deg, #7a1f1f, #2b0808)',
              vipOnly: true,
            },
            {
              id: 'galaxy',
              name: 'Galaxy',
              bg: 'linear-gradient(135deg, #2b1055, #7597de)',
              vipOnly: true,
            },
          ].map((preset) => {
            const isSelected = selectedCardColor === preset.id;
            /**
             * vipOnly WAS DECLARED ON EVERY PRESET AND READ BY NOTHING.
             *
             * 2026-08-25. Seven of these ten designs are paid: the diamond
             * store charges 75 to 300 for them and Theme Settings padlocks them
             * behind VIP. This menu handed every one of them to every player
             * for free, in one tap, with no lock and no check. Same rule here
             * as everywhere else now: free, or VIP, or bought.
             */
            const locked = !isCardBackUnlocked(preset.id, {
              isVip: isVIP,
              owned: ownedCardBacks,
            });
            return (
              <div
                key={preset.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  cursor: locked ? 'not-allowed' : 'pointer',
                  opacity: locked ? 0.5 : 1,
                }}
                onClick={async () => {
                  if (locked) {
                    toast.info('That Card Back Is A Premium Design. Unlock It In The Shop.');
                    return;
                  }
                  setSelectedCardColor(preset.id);
                  /**
                   * THE TRANSLATION TABLE OUTLIVED THE IDS IT TRANSLATED.
                   *
                   * 2026-08-25. The list above was corrected two days ago from
                   * the invented ids (default / emerald / crimson / midnight /
                   * obsidian) to the REAL designs — and this map, which existed
                   * only to translate those invented ids, was left in place. It
                   * has no entry for any of the new ids, so `|| 'black'` caught
                   * them, and 'black' aliases to classic_blue:
                   *
                   *   classic_red  -> classic_blue      dragon  -> classic_blue
                   *   royal        -> classic_blue      galaxy  -> classic_blue
                   *   holographic  -> classic_blue      diamond -> classic_blue
                   *   carbon       -> classic_blue      neon    -> royal
                   *
                   * Eight of the ten tiles saved a design other than the one
                   * they showed. The fix made the menu offer real designs and
                   * left it saving the wrong one, which is worse than before,
                   * because it now looks right in the picker.
                   *
                   * These ids ARE the canonical ids. Nothing needs translating.
                   */
                  const realCardId = preset.id;

                  masterBus.emit('UI_THEME_CHANGED', {
                    key: 'ALL',
                    value: { cards_id: realCardId },
                  });
                  masterBus.emit('CARD_COLOR_CHANGED', { preset: preset.id });

                  if (!user?.id) {
                    toast.success('Card Back Applied');
                  } else {
                    try {
                      const { data: currentSettings } = await supabase
                        .from('user_theme_settings')
                        .select('*')
                        .eq('user_id', user.id)
                        .eq('game_type', 'ALL')
                        .maybeSingle();

                      const { error } = await supabase.from('user_theme_settings').upsert(
                        {
                          user_id: user.id,
                          game_type: 'ALL',
                          ...(currentSettings || {}),
                          cards_id: realCardId,
                        },
                        { onConflict: 'user_id,game_type' }
                      );
                      // The success toast used to fire BEFORE this write and
                      // the error was only ever sent to reportError, so a
                      // failed save congratulated the player and then quietly
                      // reverted the next time they opened a table.
                      if (error) {
                        reportError(error, 'HamburgerMenu.Card_color_save_failed');
                        toast.error('Could Not Save That Card Back. Please Try Again.');
                      } else {
                        toast.success('Card Back Applied');
                      }
                    } catch (err) {
                      reportError(err, 'HamburgerMenu.Card_color_save_failed');
                      toast.error('Could Not Save That Card Back. Please Try Again.');
                    }
                  }
                }}
              >
                <div
                  title={locked ? `${preset.name} (Premium)` : preset.name}
                  style={{
                    position: 'relative',
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: preset.bg,
                    border: isSelected
                      ? '2px solid rgba(0, 212, 255, 0.8)'
                      : '2px solid rgba(255, 255, 255, 0.1)',
                    boxShadow: isSelected
                      ? '0 0 8px rgba(0, 212, 255, 0.4)'
                      : '0 2px 4px rgba(0,0,0,0.3)',
                    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {/* Text, not an emoji padlock. Without it the tile looked
                      free and simply refused to work when tapped. */}
                  {locked && (
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 800,
                        letterSpacing: '0.04em',
                        color: '#0b0b0b',
                        background: 'linear-gradient(135deg, #ffd700, #d4a017)',
                        borderRadius: 5,
                        padding: '1px 3px',
                      }}
                    >
                      VIP
                    </span>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: isSelected ? 700 : 500,
                    color: isSelected ? colors.accent : colors.textSecondary,
                    textAlign: 'center',
                    lineHeight: 1.1,
                    maxWidth: 50,
                    transition: 'color 0.2s ease',
                  }}
                >
                  {preset.name}
                </span>
              </div>
            );
          })}
        </div>

        {[
          { label: 'App Settings', path: '/settings' },
          { label: 'Notifications', path: '/notifications' },
        ].map((item, i) => (
          <div
            key={`settings-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 32) * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    KEYBOARD SHORTCUTS
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Keyboard Shortcuts</div>
        {[
          { key: '?', desc: 'Show Shortcuts' },
          { key: 'Esc', desc: 'Close Menu / Modal' },
          { key: 'H', desc: 'Go Home' },
          { key: 'L', desc: 'Go To Home' },
          { key: 'T', desc: 'Go To Tournaments' },
          { key: 'P', desc: 'Go To Profile' },
          { key: 'S', desc: 'Go To Settings' },
        ].map((shortcut, i) => (
          <div
            key={`shortcut-${i}`}
            style={{
              ...menuItemStyle,
              cursor: 'default',
              justifyContent: 'space-between',
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 34) * 30}ms both`
                : 'none',
            }}
          >
            <span style={{ fontSize: 14, color: colors.textSecondary }}>{shortcut.desc}</span>
            <kbd
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: 'monospace',
                color: colors.text,
                background: colors.bgHover,
                borderRadius: 6,
                border: `1px solid ${colors.divider}`,
                minWidth: 28,
                textAlign: 'center',
              }}
            >
              {shortcut.key}
            </kbd>
          </div>
        ))}

        <div style={dividerStyle} />

        {/* ═══════════════════════════════════════════════════════════════
                    SUPPORT & LEGAL
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Support & Legal</div>
        {[
          { label: 'Help & FAQ', path: '/help' },
          { label: 'Terms Of Service', path: '/legal/tos' },
          { label: 'Privacy Policy', path: '/legal/privacy' },
          { label: 'Fair Gaming', path: '/legal/fair-gaming' },
          { label: 'Promotion Rules', path: '/legal/promotions' },
        ].map((item, i) => (
          <div
            key={`support-${i}`}
            onClick={() => handleNavigate(item.path)}
            style={{
              ...menuItemStyle,
              animation: isOpen
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 41) * 30}ms both`
                : 'none',
            }}
            onMouseEnter={(e) => {
              handleItemHover(item.path);
              e.currentTarget.style.background = colors.bgHover;
              e.currentTarget.style.transform = 'translateX(4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.transform = 'translateX(0)';
            }}
          >
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
              {item.label}
            </span>
            <span style={{ color: colors.textSecondary }}>›</span>
          </div>
        ))}

        {/* Reset Tutorial */}
        <div
          onClick={handleResetTutorial}
          style={{
            ...menuItemStyle,
            animation: isOpen
              ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) 1140ms both`
              : 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = colors.bgHover;
            e.currentTarget.style.transform = 'translateX(4px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.transform = 'translateX(0)';
          }}
        >
          <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.text }}>
            Reset Tutorial
          </span>
          <span style={{ color: colors.textSecondary }}>›</span>
        </div>

        <div style={dividerStyle} />

        {/* Log Out */}
        <div
          onClick={handleLogOut}
          style={{
            ...menuItemStyle,
            marginBottom: 16,
            animation: isOpen
              ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) 1170ms both`
              : 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = colors.bgHover;
            e.currentTarget.style.transform = 'translateX(4px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.transform = 'translateX(0)';
          }}
        >
          <span style={{ flex: 1, fontSize: 15, fontWeight: 500, color: colors.danger }}>
            Log Out
          </span>
        </div>

        {/* Version Footer */}
        <div
          style={{
            padding: '16px',
            textAlign: 'center',
            color: colors.textSecondary,
            fontSize: 12,
          }}
        >
          Club Arena V1.12
        </div>
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
