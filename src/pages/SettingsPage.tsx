/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Settings Page
 * Complete app and gameplay settings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { notificationService } from '../services/NotificationService';
import UserProfileEdit from '../components/social/UserProfileEdit';
import { useSettingsStore } from '../stores/useSettingsStore';
import FAQPanel from '../components/support/FAQPanel';
import TermsGate from '../components/auth/TermsGate';
import styles from './SettingsPage.module.css';
import ConfirmModal from '../components/common/ConfirmModal';
import { useToast } from '../components/common/Toast';

const settingsSectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UserSettings {
  // Audio
  soundEnabled: boolean;
  soundVolume: number;
  musicEnabled: boolean;
  musicVolume: number;
  voiceAnnouncements: boolean;

  // Display
  theme: 'dark' | 'light' | 'auto';
  tableColor: string;
  cardBack: string;
  fourColorDeck: boolean;
  animationSpeed: 'slow' | 'normal' | 'fast';
  showBetAmount: boolean;
  showPotOdds: boolean;

  // Gameplay
  autoMuck: boolean;
  autoRebuy: boolean;
  autoRebuyThreshold: number;
  confirmAllIn: boolean;
  showHandStrength: boolean;
  runItTwiceDefault: boolean;
  straddleDefault: boolean;

  // Chat
  chatEnabled: boolean;
  chatNotifications: boolean;

  // Notifications
  tournamentReminders: boolean;
  clubActivity: boolean;
  handWonNotifications: boolean;
  achievementNotifications: boolean;
  friendAlerts: boolean;
  settlementAlerts: boolean;

  // Privacy
  showOnlineStatus: boolean;
  allowFriendRequests: boolean;
  shareHandHistories: boolean;
}

const DEFAULT_SETTINGS: UserSettings = {
  soundEnabled: true,
  soundVolume: 80,
  musicEnabled: false,
  musicVolume: 50,
  voiceAnnouncements: true,

  theme: 'dark',
  tableColor: 'green',
  cardBack: 'classic',
  fourColorDeck: false,
  animationSpeed: 'normal',
  showBetAmount: true,
  showPotOdds: false,

  autoMuck: true,
  autoRebuy: false,
  autoRebuyThreshold: 50,
  confirmAllIn: true,
  showHandStrength: false,
  runItTwiceDefault: false,
  straddleDefault: false,

  chatEnabled: true,
  chatNotifications: true,

  tournamentReminders: true,
  clubActivity: true,
  handWonNotifications: false,
  achievementNotifications: true,
  friendAlerts: true,
  settlementAlerts: true,

  showOnlineStatus: true,
  allowFriendRequests: true,
  shareHandHistories: false,
};

const TABLE_COLORS = [
  { id: 'green', name: 'Classic Green', color: '#1a5f3a' },
  { id: 'blue', name: 'Ocean Blue', color: '#1e3a5f' },
  { id: 'red', name: 'Casino Red', color: '#5a1a1a' },
  { id: 'purple', name: 'Royal Purple', color: '#3a1a5f' },
  { id: 'black', name: 'Midnight Black', color: '#1a1a1a' },
];

const CARD_BACKS = [
  { id: 'classic', name: 'Classic' },
  { id: 'modern', name: 'Modern' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'premium', name: 'Premium Gold' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) => (
  <label className={styles.toggle}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className={styles.toggleSlider} />
    {label && <span className={styles.toggleLabel}>{label}</span>}
  </label>
);

const Slider = ({
  value,
  onChange,
  min = 0,
  max = 100,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) => (
  <div className={`${styles.sliderContainer} ${disabled ? styles.disabled : ''}`}>
    <input
      type="range"
      className={styles.slider}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      disabled={disabled}
    />
    <span className={styles.sliderValue}>{value}%</span>
  </div>
);

const ColorPicker = ({
  options,
  selected,
  onChange,
}: {
  options: typeof TABLE_COLORS;
  selected: string;
  onChange: (id: string) => void;
}) => (
  <div className={styles.colorPicker}>
    {options.map((option) => (
      <button
        key={option.id}
        className={`${styles.colorOption} ${selected === option.id ? styles.selected : ''}`}
        style={{ backgroundColor: option.color }}
        onClick={() => onChange(option.id)}
        title={option.name}
      />
    ))}
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userEmail, setUserEmail] = useState<string>('');

  // Account Action States
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // 2FA States
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [totpSecret, setTotpSecret] = useState<string>('');
  const [totpQRCode, setTotpQRCode] = useState<string>('');
  const [verificationCode, setVerificationCode] = useState('');
  const [factorId, setFactorId] = useState<string>('');

  // Push Notification state
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  // Section refs for tab navigation
  const audioRef = useRef<HTMLElement>(null);
  const appearanceRef = useRef<HTMLElement>(null);
  const gameplayRef = useRef<HTMLElement>(null);
  const notificationsRef = useRef<HTMLElement>(null);
  const privacyRef = useRef<HTMLElement>(null);
  const securityRef = useRef<HTMLElement>(null);
  const dangerRef = useRef<HTMLElement>(null);

  // Tab-based scroll navigation
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (!tab) return;

    const tabToRef: Record<string, React.RefObject<HTMLElement | null>> = {
      audio: audioRef,
      appearance: appearanceRef,
      display: appearanceRef,
      gameplay: gameplayRef,
      notifications: notificationsRef,
      privacy: privacyRef,
      security: securityRef,
      account: securityRef,
      language: appearanceRef, // Language settings would be in appearance section
    };

    const targetRef = tabToRef[tab.toLowerCase()];
    if (targetRef?.current) {
      setTimeout(() => {
        targetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [searchParams]);

  // Load settings from localStorage on mount
  useEffect(() => {
    let isMounted = true;
    const saved = localStorage.getItem('club-arena-settings');
    if (saved) {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }
    // Get current user email
    supabase.auth.getUser().then(({ data }) => {
      if (isMounted && data?.user?.email) setUserEmail(data.user.email);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  // Bus listeners: re-read settings from localStorage when profile/settings change externally
  useEffect(() => {
    let isMounted = true;
    const reloadSettings = () => {
      const saved = localStorage.getItem('club-arena-settings');
      if (saved) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
        } catch {
          /* parse error */
        }
      }
    };
    const unsub1 = masterBus.subscribe('SETTINGS_UPDATED', reloadSettings);
    const unsub2 = masterBus.subscribe('PROFILE_UPDATED', () => {
      supabase.auth.getUser().then(({ data }) => {
        if (isMounted && data?.user?.email) setUserEmail(data.user.email);
      });
    });
    return () => {
      isMounted = false;
      unsub1();
      unsub2();
    };
  }, []);

  // Account Actions
  const handleChangeEmail = async () => {
    if (!newEmail || !newEmail.includes('@')) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) throw error;
      setShowEmailModal(false);
      setNewEmail('');
      toast.success('Confirmation email sent! Check your inbox to verify.');
    } catch (err: any) {
      console.error('Email update failed:', err);
      toast.error(err?.message || 'Failed to update email.');
    }
    setActionLoading(false);
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 8) return;
    if (newPassword !== confirmPassword) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setShowPasswordModal(false);
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated successfully!');
    } catch (err: any) {
      console.error('Password update failed:', err);
      toast.error(err?.message || 'Failed to update password.');
    }
    setActionLoading(false);
  };

  const handleExportData = async () => {
    setActionLoading(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Fetch user data from various tables
      const [profiles, wallets, achievements, handHistory] = await Promise.all([
        supabase
          .from('profiles')
          .select(
            'id, display_name, username, avatar_url, bio, role, created_at, streak_days, last_login'
          )
          .eq('id', user.id)
          .maybeSingle(),
        supabase
          .from('wallets')
          .select('id, user_id, wallet_type, balance, currency, created_at')
          .eq('user_id', user.id),
        supabase
          .from('user_achievements')
          .select('id, user_id, achievement_id, unlocked_at, progress')
          .eq('user_id', user.id),
        supabase
          .from('hand_history')
          .select(
            'id, hand_number, game_variant, small_blind, big_blind, pot_size, community_cards, winners, players, created_at'
          )
          .eq('player_id', user.id)
          .limit(100),
      ]);

      const exportData = {
        exportDate: new Date().toISOString(),
        profile: profiles.data,
        wallets: wallets.data,
        achievements: achievements.data,
        recentHands: handHistory.data,
      };

      // Download as JSON
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `club-arena-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Data exported successfully!');
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('Failed to export data. Please try again.');
    }
    setActionLoading(false);
  };

  // ── Confirm modal state ──
  const [confirmAction, setConfirmAction] = useState<{
    type: 'delete-account' | 'disable-2fa' | 'reset-settings';
    title: string;
    message: string;
    variant: 'default' | 'danger';
  } | null>(null);

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    const actionType = confirmAction.type;
    setConfirmAction(null);

    if (actionType === 'delete-account') {
      setActionLoading(true);
      try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        window.location.href = '/';
      } catch (err) {
        console.error('Account deletion failed:', err);
        toast.error('Account deletion failed. Please try again.');
      }
      setActionLoading(false);
    } else if (actionType === 'disable-2fa') {
      setActionLoading(true);
      try {
        const { error } = await supabase.auth.mfa.unenroll({ factorId });
        if (error) throw error;
        setTwoFactorEnabled(false);
        setFactorId('');
        toast.success('Two-factor authentication disabled.');
      } catch (err) {
        console.error('Failed to disable 2FA:', err);
        toast.error('Failed to disable 2FA. Please try again.');
      }
      setActionLoading(false);
    } else if (actionType === 'reset-settings') {
      setSettings(DEFAULT_SETTINGS);
      setHasChanges(true);
    }
  };

  const handleDeleteAccount = () => {
    setConfirmAction({
      type: 'delete-account',
      title: 'Delete Account',
      message:
        'This will permanently delete all your data, chips, and history. This action is PERMANENT and cannot be undone.',
      variant: 'danger',
    });
  };

  // 2FA Handlers
  const check2FAStatus = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.find((f) => f.status === 'verified');
      setTwoFactorEnabled(!!totpFactor);
      if (totpFactor) setFactorId(totpFactor.id);
    } catch (err) {
      console.error('Failed to check 2FA status:', err);
    }
  };

  const handleEnable2FA = async () => {
    setActionLoading(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Club Arena Authenticator',
      });
      if (error) throw error;

      setTotpSecret(data.totp.secret);
      setTotpQRCode(data.totp.qr_code);
      setFactorId(data.id);
      setShow2FAModal(true);
    } catch (err) {
      console.error('Failed to enable 2FA:', err);
      toast.error('Failed to set up 2FA. Please try again.');
    }
    setActionLoading(false);
  };

  const handleVerify2FA = async () => {
    if (verificationCode.length !== 6) return;
    setActionLoading(true);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: verificationCode,
      });
      if (verifyError) throw verifyError;

      setTwoFactorEnabled(true);
      setShow2FAModal(false);
      setVerificationCode('');
      toast.success('Two-factor authentication enabled!');
    } catch (err) {
      console.error('Failed to verify 2FA:', err);
      toast.error('Invalid verification code. Please try again.');
    }
    setActionLoading(false);
  };

  const handleDisable2FA = () => {
    setConfirmAction({
      type: 'disable-2fa',
      title: 'Disable Two-Factor Authentication',
      message:
        'Are you sure you want to disable two-factor authentication? This will make your account less secure.',
      variant: 'danger',
    });
  };

  // Check 2FA status on mount
  useEffect(() => {
    check2FAStatus();
  }, []);

  // Check push notification status
  useEffect(() => {
    if ('Notification' in window) {
      setPushEnabled(Notification.permission === 'granted');
    }
  }, []);

  const handleEnablePush = async () => {
    setPushLoading(true);
    try {
      const granted = await notificationService.requestPermission();
      setPushEnabled(granted);
      if (granted) {
        // Push notifications enabled successfully
        toast.success('Push notifications enabled!');
      } else {
        toast.error('Push notifications denied. Please allow in browser settings.');
      }
    } catch (err) {
      console.error('Failed to enable push:', err);
      toast.error('Failed to enable push notifications.');
    }
    setPushLoading(false);
  };

  const updateSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      // Save to localStorage
      localStorage.setItem('club-arena-settings', JSON.stringify(settings));

      // Sync theme to Zustand store so Shell.tsx applies it immediately
      const { setTheme, toggleSound, toggleFourColorDeck, toggleNotifications } =
        useSettingsStore.getState();
      if (settings.theme === 'dark' || settings.theme === 'light') {
        setTheme(settings.theme);
      }

      // Sync to Supabase profiles table
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { error: profileErr } = await supabase
          .from('profiles')
          .update({ settings: settings })
          .eq('id', user.id);
        if (profileErr) throw profileErr;

        // Sync notification preferences to dedicated table (used by push service)
        const { error: notifErr } = await supabase.from('user_notification_preferences').upsert(
          {
            user_id: user.id,
            table_alerts: settings.handWonNotifications ?? true,
            tournament_reminders: settings.tournamentReminders ?? true,
            achievement_alerts: settings.achievementNotifications ?? true,
            friend_alerts: settings.friendAlerts ?? true,
            club_announcements: settings.clubActivity ?? true,
            settlement_alerts: settings.settlementAlerts ?? true,
          },
          { onConflict: 'user_id' }
        );
        if (notifErr) throw notifErr;
      }

      setHasChanges(false);

      // Notify other components that settings changed
      masterBus.emit('SETTINGS_UPDATED', {
        settings: settings as unknown as Record<string, unknown>,
      });
      toast.success('Settings saved!');
    } catch (error) {
      console.error('Failed to sync settings:', error);
      toast.error('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const resetSettings = () => {
    setConfirmAction({
      type: 'reset-settings',
      title: 'Reset Settings',
      message:
        'Reset all settings to their default values? You will still need to save for changes to take effect.',
      variant: 'default',
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerActions}>
        {hasChanges && (
          <button className={styles.saveButton} onClick={saveSettings} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        )}
        <button className={styles.resetButton} onClick={resetSettings}>
          Reset
        </button>
      </div>

      <div className={styles.content}>
        {/* Audio Settings */}
        <section ref={audioRef} className={styles.section} style={settingsSectionAnimationStyle(0)}>
          <h2>Audio</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Sound Effects</span>
              <span className={styles.settingDesc}>Play sounds for actions and events</span>
            </div>
            <Toggle
              checked={settings.soundEnabled}
              onChange={(v) => updateSetting('soundEnabled', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Sound Volume</span>
            </div>
            <Slider
              value={settings.soundVolume}
              onChange={(v) => updateSetting('soundVolume', v)}
              disabled={!settings.soundEnabled}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Background Music</span>
            </div>
            <Toggle
              checked={settings.musicEnabled}
              onChange={(v) => updateSetting('musicEnabled', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Voice Announcements</span>
              <span className={styles.settingDesc}>Announce actions, pot sizes, and winners</span>
            </div>
            <Toggle
              checked={settings.voiceAnnouncements}
              onChange={(v) => updateSetting('voiceAnnouncements', v)}
            />
          </div>
        </section>

        {/* Display Settings */}
        <section
          ref={appearanceRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(1)}
        >
          <h2>Display</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Theme</span>
            </div>
            <select
              className={styles.select}
              value={settings.theme}
              onChange={(e) => updateSetting('theme', e.target.value as UserSettings['theme'])}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Auto (System)</option>
            </select>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Table Felt Color</span>
            </div>
            <ColorPicker
              options={TABLE_COLORS}
              selected={settings.tableColor}
              onChange={(v) => updateSetting('tableColor', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Card Back Style</span>
            </div>
            <select
              className={styles.select}
              value={settings.cardBack}
              onChange={(e) => updateSetting('cardBack', e.target.value)}
            >
              {CARD_BACKS.map((back) => (
                <option key={back.id} value={back.id}>
                  {back.name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Four-Color Deck</span>
              <span className={styles.settingDesc}>
                Hearts ♥, Diamonds ♦ (blue), Clubs ♣ (green), Spades ♠
              </span>
            </div>
            <Toggle
              checked={settings.fourColorDeck}
              onChange={(v) => updateSetting('fourColorDeck', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Animation Speed</span>
            </div>
            <select
              className={styles.select}
              value={settings.animationSpeed}
              onChange={(e) =>
                updateSetting('animationSpeed', e.target.value as UserSettings['animationSpeed'])
              }
            >
              <option value="slow">Slow</option>
              <option value="normal">Normal</option>
              <option value="fast">Fast</option>
            </select>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Show Pot Odds</span>
              <span className={styles.settingDesc}>Display pot odds during your action</span>
            </div>
            <Toggle
              checked={settings.showPotOdds}
              onChange={(v) => updateSetting('showPotOdds', v)}
            />
          </div>
        </section>

        {/* Gameplay Settings */}
        <section
          ref={gameplayRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(2)}
        >
          <h2>Gameplay</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Auto Muck Losing Hands</span>
              <span className={styles.settingDesc}>
                Automatically muck when you lose at showdown
              </span>
            </div>
            <Toggle checked={settings.autoMuck} onChange={(v) => updateSetting('autoMuck', v)} />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Confirm All-In</span>
              <span className={styles.settingDesc}>Require confirmation before going all-in</span>
            </div>
            <Toggle
              checked={settings.confirmAllIn}
              onChange={(v) => updateSetting('confirmAllIn', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Auto Rebuy</span>
              <span className={styles.settingDesc}>
                Automatically rebuy when stack falls below threshold
              </span>
            </div>
            <Toggle checked={settings.autoRebuy} onChange={(v) => updateSetting('autoRebuy', v)} />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Run It Twice (Default)</span>
              <span className={styles.settingDesc}>Auto-accept when offered</span>
            </div>
            <Toggle
              checked={settings.runItTwiceDefault}
              onChange={(v) => updateSetting('runItTwiceDefault', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Straddle (Default)</span>
              <span className={styles.settingDesc}>Auto-post straddle when UTG</span>
            </div>
            <Toggle
              checked={settings.straddleDefault}
              onChange={(v) => updateSetting('straddleDefault', v)}
            />
          </div>
        </section>

        {/* Chat */}
        <section className={styles.section} style={settingsSectionAnimationStyle(3)}>
          <h2>Chat</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Table Chat</span>
              <span className={styles.settingDesc}>Show chat messages at the table</span>
            </div>
            <Toggle
              checked={settings.chatEnabled}
              onChange={(v) => updateSetting('chatEnabled', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Chat Notifications</span>
              <span className={styles.settingDesc}>Show badge for new chat messages</span>
            </div>
            <Toggle
              checked={settings.chatNotifications && settings.chatEnabled}
              onChange={(v) => updateSetting('chatNotifications', v)}
            />
          </div>
        </section>

        {/* Notifications */}
        <section
          ref={notificationsRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(4)}
        >
          <h2>Notifications</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Tournament Reminders</span>
              <span className={styles.settingDesc}>Notify before registered tournaments start</span>
            </div>
            <Toggle
              checked={settings.tournamentReminders}
              onChange={(v) => updateSetting('tournamentReminders', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Club Activity</span>
              <span className={styles.settingDesc}>New tables, tournaments, and announcements</span>
            </div>
            <Toggle
              checked={settings.clubActivity}
              onChange={(v) => updateSetting('clubActivity', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Achievement Unlocked</span>
            </div>
            <Toggle
              checked={settings.achievementNotifications}
              onChange={(v) => updateSetting('achievementNotifications', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Friend Alerts</span>
              <span className={styles.settingDesc}>Friend requests, status changes</span>
            </div>
            <Toggle
              checked={settings.friendAlerts}
              onChange={(v) => updateSetting('friendAlerts', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Settlement Alerts</span>
              <span className={styles.settingDesc}>Chip settlement and transfer notifications</span>
            </div>
            <Toggle
              checked={settings.settlementAlerts}
              onChange={(v) => updateSetting('settlementAlerts', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Push Notifications</span>
              <span className={styles.settingDesc}>
                {pushEnabled ? '🔔 Enabled' : 'Allow browser notifications'}
              </span>
            </div>
            {pushEnabled ? (
              <span className={styles.statusBadge}>Active</span>
            ) : (
              <button
                className={styles.actionButton}
                onClick={handleEnablePush}
                disabled={pushLoading}
              >
                {pushLoading ? 'Enabling...' : 'Enable'}
              </button>
            )}
          </div>
        </section>

        {/* Privacy */}
        <section
          ref={privacyRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(5)}
        >
          <h2>Privacy</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Show Online Status</span>
              <span className={styles.settingDesc}>Let others see when you're online</span>
            </div>
            <Toggle
              checked={settings.showOnlineStatus}
              onChange={(v) => updateSetting('showOnlineStatus', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Allow Friend Requests</span>
            </div>
            <Toggle
              checked={settings.allowFriendRequests}
              onChange={(v) => updateSetting('allowFriendRequests', v)}
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Share Hand Histories</span>
              <span className={styles.settingDesc}>
                Allow others to view your shared hand replays
              </span>
            </div>
            <Toggle
              checked={settings.shareHandHistories}
              onChange={(v) => updateSetting('shareHandHistories', v)}
            />
          </div>
        </section>

        {/* Account */}
        <section
          ref={securityRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(6)}
        >
          <h2>Account</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Email</span>
              <span className={styles.settingDesc}>{userEmail || 'Loading...'}</span>
            </div>
            <button className={styles.actionButton} onClick={() => setShowEmailModal(true)}>
              Change
            </button>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Password</span>
            </div>
            <button className={styles.actionButton} onClick={() => setShowPasswordModal(true)}>
              Change
            </button>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Two-Factor Authentication</span>
              <span className={styles.settingDesc}>
                {twoFactorEnabled
                  ? '🛡️ Enabled — Your account is protected'
                  : 'Add extra security to your account'}
              </span>
            </div>
            {twoFactorEnabled ? (
              <button
                className={styles.dangerButton}
                onClick={handleDisable2FA}
                disabled={actionLoading}
              >
                {actionLoading ? 'Disabling...' : 'Disable'}
              </button>
            ) : (
              <button
                className={styles.actionButton}
                onClick={handleEnable2FA}
                disabled={actionLoading}
              >
                {actionLoading ? 'Setting up...' : 'Enable'}
              </button>
            )}
          </div>
        </section>

        {/* Danger Zone */}
        <section ref={dangerRef} className={`${styles.section} ${styles.dangerZone}`}>
          <h2>Danger Zone</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Export Data</span>
              <span className={styles.settingDesc}>Download all your data and hand histories</span>
            </div>
            <button
              className={styles.actionButtonSecondary}
              onClick={handleExportData}
              disabled={actionLoading}
            >
              {actionLoading ? 'Exporting...' : 'Export'}
            </button>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Delete Account</span>
              <span className={styles.settingDesc}>
                Permanently delete your account and all data
              </span>
            </div>
            <button
              className={styles.dangerButton}
              onClick={handleDeleteAccount}
              disabled={actionLoading}
            >
              Delete
            </button>
          </div>
        </section>
      </div>

      {/* Email Change Modal */}
      {showEmailModal && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => e.target === e.currentTarget && setShowEmailModal(false)}
        >
          <div className={styles.modal}>
            <h3>Change Email</h3>
            <p>A confirmation email will be sent to your new address.</p>
            <input
              type="email"
              placeholder="New email address"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className={styles.input}
            />
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setShowEmailModal(false)}>
                Cancel
              </button>
              <button
                className={styles.saveBtn}
                onClick={handleChangeEmail}
                disabled={actionLoading || !newEmail}
              >
                {actionLoading ? 'Updating...' : 'Update Email'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password Change Modal */}
      {showPasswordModal && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => e.target === e.currentTarget && setShowPasswordModal(false)}
        >
          <div className={styles.modal}>
            <h3>Change Password</h3>
            <p>Password must be at least 8 characters.</p>
            <input
              type="password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={styles.input}
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={styles.input}
              style={{ marginTop: '0.5rem' }}
            />
            {newPassword && confirmPassword && newPassword !== confirmPassword && (
              <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>Passwords don't match</p>
            )}
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setShowPasswordModal(false)}>
                Cancel
              </button>
              <button
                className={styles.saveBtn}
                onClick={handleChangePassword}
                disabled={
                  actionLoading ||
                  !newPassword ||
                  newPassword !== confirmPassword ||
                  newPassword.length < 8
                }
              >
                {actionLoading ? 'Updating...' : 'Update Password'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2FA Setup Modal */}
      {show2FAModal && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => e.target === e.currentTarget && setShow2FAModal(false)}
        >
          <div className={styles.modal}>
            <h3>🛡️ Set Up Two-Factor Authentication</h3>
            <p>Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)</p>

            {totpQRCode && (
              <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                <img
                  src={totpQRCode}
                  alt="2FA QR Code"
                  style={{ maxWidth: '200px', borderRadius: '8px' }}
                />
              </div>
            )}

            <p style={{ fontSize: '0.85rem', color: '#9ca3af' }}>
              Or enter this secret manually:{' '}
              <code
                style={{ background: '#1f2937', padding: '0.25rem 0.5rem', borderRadius: '4px' }}
              >
                {totpSecret}
              </code>
            </p>

            <input
              type="text"
              placeholder="Enter 6-digit code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={styles.input}
              style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.5rem' }}
              maxLength={6}
            />

            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setShow2FAModal(false)}>
                Cancel
              </button>
              <button
                className={styles.saveBtn}
                onClick={handleVerify2FA}
                disabled={actionLoading || verificationCode.length !== 6}
              >
                {actionLoading ? 'Verifying...' : 'Verify & Enable'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmAction}
        title={confirmAction?.title || 'Confirm'}
        message={confirmAction?.message || ''}
        variant={confirmAction?.variant || 'default'}
        confirmText={confirmAction?.type === 'delete-account' ? 'Delete My Account' : 'Confirm'}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
        loading={actionLoading}
      />
    </div>
  );
}
