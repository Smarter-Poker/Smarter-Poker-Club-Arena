/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAMBURGER MENU — Facebook Dark Theme
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Clean, classy navigation with complete page coverage
 * No emojis - professional Facebook-style design
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { identityDNA } from '../../core/IdentityDNA';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
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

  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const [vibrationsEnabled, setVibrationsEnabled] = useState(true);
  const [showBBEnabled, setShowBBEnabled] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [isVIP, setIsVIP] = useState(false);
  const [diamondBalance, setDiamondBalance] = useState(0);
  const [selectedCardColor, setSelectedCardColor] = useState(() => {
    try {
      return localStorage.getItem('club_arena_card_color') || 'default';
    } catch (err) {
      console.error('[HamburgerMenu] Error:', err);
      return 'default';
    }
  });

  // Close on ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Load user data and settings
  useEffect(() => {
    const sounds = localStorage.getItem('soundsEnabled');
    const vibrations = localStorage.getItem('vibrationsEnabled');
    const showBB = localStorage.getItem('showStackInBB');
    if (sounds !== null) setSoundsEnabled(sounds === 'true');
    if (vibrations !== null) setVibrationsEnabled(vibrations === 'true');
    if (showBB !== null) setShowBBEnabled(showBB === 'true');

    if (user?.id) {
      supabase
        .from('profiles')
        .select(
          'avatar_url, username, sounds_enabled, vibrations_enabled, show_stack_bb, is_vip, diamonds'
        )
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) {
            console.error('[HamburgerMenu] Failed to load profile:', error);
            return;
          }
          if (data) {
            setAvatarUrl(data.avatar_url);
            setUserName(data.username || 'Player');
            if (data.sounds_enabled !== null) {
              setSoundsEnabled(data.sounds_enabled);
              localStorage.setItem('soundsEnabled', String(data.sounds_enabled));
            }
            if (data.vibrations_enabled !== null) {
              setVibrationsEnabled(data.vibrations_enabled);
              localStorage.setItem('vibrationsEnabled', String(data.vibrations_enabled));
            }
            if (data.show_stack_bb !== null) {
              setShowBBEnabled(data.show_stack_bb);
              localStorage.setItem('showStackInBB', String(data.show_stack_bb));
            }
            setIsVIP(data.is_vip || false);
            setDiamondBalance(data.diamonds || 0);
          }
        });
    }
  }, [user?.id]);

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

  // Settings update
  const updateSetting = async (localKey: string, dbKey: string, value: boolean) => {
    try {
      localStorage.setItem(localKey, String(value));
    } catch (err) {
      console.error('[HamburgerMenu] Error:', err);
      /* */
    }
    if (user?.id) {
      try {
        const { error: updateErr } = await supabase
          .from('profiles')
          .update({ [dbKey]: value })
          .eq('id', user.id);
        if (updateErr) console.error('[HamburgerMenu] Setting save failed:', updateErr);
      } catch (error) {
        console.error('Error updating setting:', error);
      }
    }
  };

  const handleSoundsToggle = () => {
    const newValue = !soundsEnabled;
    setSoundsEnabled(newValue);
    updateSetting('soundsEnabled', 'sounds_enabled', newValue);
  };

  const handleVibrationsToggle = () => {
    const newValue = !vibrationsEnabled;
    setVibrationsEnabled(newValue);
    updateSetting('vibrationsEnabled', 'vibrations_enabled', newValue);
  };

  const handleShowBBToggle = () => {
    const newValue = !showBBEnabled;
    setShowBBEnabled(newValue);
    updateSetting('showStackInBB', 'show_stack_bb', newValue);
  };

  const handleResetTutorial = async () => {
    localStorage.removeItem('club_arena_intro_shown');
    localStorage.removeItem('tutorial_completed');
    if (user?.id) {
      try {
        const { error: resetErr } = await supabase
          .from('profiles')
          .update({ tutorial_completed: false })
          .eq('id', user.id);
        if (resetErr) console.error('[HamburgerMenu] Tutorial reset save failed:', resetErr);
      } catch (error) {
        console.error('Error resetting tutorial:', error);
      }
    }
    toast.info('Tutorial reset! Refresh the page to see the intro again.');
    onClose();
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
      console.error('Error logging out:', error);
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
            zIndex: 999,
          }}
        />
      )}

      {/* Drawer */}
      <div
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
          zIndex: 1000,
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
          <img
            loading="lazy"
            decoding="async"
            src={avatarUrl || '/default-avatar.png'}
            alt=""
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              objectFit: 'cover',
              border: `2px solid ${colors.divider}`,
            }}
          />
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
                    GAME MODES
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Game Modes</div>
        {[
          { label: 'Lobby', path: '/lobby' },
          { label: 'Tournaments', path: '/tournaments' },
          { label: 'Tournament Lobby', path: '/tournament-lobby' },
          { label: 'Tournament Results', path: '/tournament-results' },
          { label: 'Hand History', path: '/hand-history' },
          { label: 'Session History', path: '/history' },
          { label: 'Leaderboard', path: '/leaderboard' },
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
          { label: 'Messages', path: '/messages' },
          { label: 'Club Messages', path: '/messages/clubs' },
          { label: 'Players', path: '/players' },
          { label: 'Cashier', path: '/cashier' },
          { label: 'Search', path: '/search' },
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
                    AGENT & ADMIN
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Agent & Admin</div>
        {[
          { label: 'Agent Management', path: '/agent-management' },
          { label: 'Club Dashboard', path: '/data' },
          { label: 'Club Settings', path: '/admin' },
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
            style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              border: 'none',
              padding: 2,
              cursor: 'pointer',
              backgroundColor: soundsEnabled ? colors.success : colors.bgHover,
              transition: 'background-color 0.2s ease',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                backgroundColor: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                transform: soundsEnabled ? 'translateX(20px)' : 'translateX(0)',
                transition: 'transform 0.2s ease',
              }}
            />
          </button>
        </div>

        {/* Vibrations Toggle */}
        <div style={{ ...menuItemStyle, justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>Vibrations</span>
          <button
            onClick={handleVibrationsToggle}
            style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              border: 'none',
              padding: 2,
              cursor: 'pointer',
              backgroundColor: vibrationsEnabled ? colors.success : colors.bgHover,
              transition: 'background-color 0.2s ease',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                backgroundColor: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                transform: vibrationsEnabled ? 'translateX(20px)' : 'translateX(0)',
                transition: 'transform 0.2s ease',
              }}
            />
          </button>
        </div>

        {/* Show Stack in BBs Toggle (FREE) */}
        <div style={{ ...menuItemStyle, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>
              Show Stack in BBs
            </span>
            <span style={{ fontSize: 11, color: colors.textSecondary }}>
              Display stacks as big blind multiples
            </span>
          </div>
          <button
            onClick={handleShowBBToggle}
            style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              border: 'none',
              padding: 2,
              cursor: 'pointer',
              backgroundColor: showBBEnabled ? colors.success : colors.bgHover,
              transition: 'background-color 0.2s ease',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                backgroundColor: 'white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                transform: showBBEnabled ? 'translateX(20px)' : 'translateX(0)',
                transition: 'transform 0.2s ease',
              }}
            />
          </button>
        </div>

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
          {[
            {
              id: 'default',
              name: 'Deep Ocean',
              bg: 'linear-gradient(145deg, rgba(8, 20, 40, 0.9), rgba(5, 12, 28, 0.95))',
            },
            {
              id: 'emerald',
              name: 'Emerald Night',
              bg: 'linear-gradient(145deg, rgba(5, 30, 20, 0.9), rgba(3, 18, 12, 0.95))',
            },
            {
              id: 'crimson',
              name: 'Crimson Velvet',
              bg: 'linear-gradient(145deg, rgba(40, 8, 15, 0.9), rgba(28, 5, 10, 0.95))',
            },
            {
              id: 'royal',
              name: 'Royal Purple',
              bg: 'linear-gradient(145deg, rgba(20, 8, 40, 0.9), rgba(12, 5, 28, 0.95))',
            },
            {
              id: 'gold',
              name: 'Gold Rush',
              bg: 'linear-gradient(145deg, rgba(35, 28, 8, 0.9), rgba(24, 18, 5, 0.95))',
            },
            {
              id: 'midnight',
              name: 'Midnight Ice',
              bg: 'linear-gradient(145deg, rgba(5, 10, 35, 0.9), rgba(3, 6, 22, 0.95))',
            },
            {
              id: 'obsidian',
              name: 'Obsidian',
              bg: 'linear-gradient(145deg, rgba(15, 15, 15, 0.9), rgba(8, 8, 8, 0.95))',
            },
            {
              id: 'neon',
              name: 'Neon Cyber',
              bg: 'linear-gradient(145deg, rgba(5, 15, 25, 0.9), rgba(3, 8, 18, 0.95))',
            },
          ].map((preset) => {
            const isSelected = selectedCardColor === preset.id;
            return (
              <div
                key={preset.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                }}
                onClick={async () => {
                  setSelectedCardColor(preset.id);
                  localStorage.setItem('club_arena_card_color', preset.id);
                  try {
                    const { masterBus } = await import('../../core/MasterBus');
                    masterBus.emit('CARD_COLOR_CHANGED', { preset: preset.id });
                  } catch (err) {
                    console.error('[HamburgerMenu] Error:', err);
                    /* */
                  }
                  if (user?.id) {
                    try {
                      const { data: currentProfile } = await supabase
                        .from('profiles')
                        .select('preferences')
                        .eq('id', user.id)
                        .maybeSingle();
                      const prefs = (currentProfile?.preferences as Record<string, unknown>) || {};
                      const { error: saveErr } = await supabase
                        .from('profiles')
                        .update({ preferences: { ...prefs, card_color_preset: preset.id } })
                        .eq('id', user.id);
                      if (saveErr)
                        console.error('[HamburgerMenu] Card color save failed:', saveErr);
                    } catch (err) {
                      console.error('[HamburgerMenu] Error:', err);
                      /* silent */
                    }
                  }
                  toast.success(`Card color: ${preset.name}`);
                }}
              >
                <div
                  title={preset.name}
                  style={{
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
                  }}
                />
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
                    SUPPORT & LEGAL
                ═══════════════════════════════════════════════════════════════ */}
        <div style={sectionHeaderStyle}>Support & Legal</div>
        {[
          { label: 'Help & FAQ', path: '/help' },
          { label: 'Terms of Service', path: '/legal/tos' },
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
                ? `slideInLeft 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) ${(i + 34) * 30}ms both`
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
          Club Arena v1.12
        </div>
      </div>
    </>
  );
}
