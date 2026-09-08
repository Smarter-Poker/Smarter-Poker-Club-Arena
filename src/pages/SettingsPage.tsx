/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Settings Page
 * Complete app and gameplay settings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useId, useRef, type RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { STORAGE_KEYS } from '../lib/storage';
import { identityDNA } from '../core/IdentityDNA';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
/**
 * Push, 2026-08-27. This page used to call
 * `notificationService.requestPermission()`, which does nothing but await
 * `Notification.requestPermission()` and hand back a boolean. It created no
 * subscription, told the server nothing, and then toasted "Push notifications
 * enabled!" and rendered a green Active badge. `pushEnabled` was read from
 * `Notification.permission` alone, so the badge stayed Active forever while
 * the account could not receive a single push. Every one of the 2,432 seat
 * offers skipped for `no_subscription` in the week before this was fixed
 * belonged to somebody who may well have pressed that button.
 *
 * It now drives the real VAPID flow, and its state comes from whether a
 * subscription actually exists on this device.
 */
import {
  disablePush,
  enablePush,
  hasLocalSubscription,
  isIos,
  isIosStandalonePwa,
  isWebPushSupported,
  notificationPermission,
  sendTestPush,
} from '../lib/pushClient';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTableSettings } from '../hooks/useTableSettings';
import {
  DEFAULT_SETTINGS,
  fromTableSettings,
  toTableSettings,
  validateSettings,
  type UserSettings,
} from '../lib/settingsBridge';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import styles from './SettingsPage.module.css';
import ConfirmModal from '../components/common/ConfirmModal';
import { useToast } from '../components/common/Toast';
import { reportError } from '../utils/errorReporter';
import { ThemeSettingsModal } from '../components/table/ThemeSettingsModal';
import AccountSurfaceHeader from '../components/account/AccountSurfaceHeader';
import { IS_NATIVE_BUILD, isNativePlatform } from '../lib/appBase';
import { getAnalyticsConsent, setAnalyticsConsent } from '../lib/consent';

const settingsSectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `animationsFadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

type SettingsSectionId = 'audio' | 'display' | 'notifications' | 'account' | 'data';

const resolveSettingsSection = (tab: string | null): SettingsSectionId | null => {
  switch (tab?.toLowerCase()) {
    case 'audio':
      return 'audio';
    case 'appearance':
    case 'display':
    case 'gameplay':
    case 'table':
    case 'language':
      return 'display';
    case 'notifications':
      return 'notifications';
    case 'security':
    case 'account':
      return 'account';
    case 'data':
      return 'data';
    default:
      return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) => (
  <label className={styles.toggle}>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
    />
    <span className={styles.toggleSlider} />
  </label>
);

const Slider = ({
  value,
  onChange,
  min = 0,
  max = 100,
  disabled = false,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  label: string;
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
      aria-label={label}
      aria-valuetext={`${value} Percent`}
    />
    <span className={styles.sliderValue}>{value}%</span>
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function SettingsPage() {
  useEffect(() => {
    document.title = 'Settings | Smarter Poker';
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const activeSettingsSection = resolveSettingsSection(searchParams.get('tab'));
  const toast = useToast();
  const { user: authUser } = useAuthUser();
  const { settings: tableSettings, updateSettings: updateTableSettings } = useTableSettings();
  const tableSettingsRef = useRef(tableSettings);
  tableSettingsRef.current = tableSettings;

  /**
   * LAZY INITIALIZER (2026-08-28, first-paint flash sweep): this began at
   * DEFAULT_SETTINGS and the real values arrived in a passive effect — the
   * read is SYNCHRONOUS localStorage, so every visit to /settings painted
   * every toggle, the theme selector and the card-back dropdown at their
   * defaults for one frame and then snapped to the saved state. Same class
   * as the table-theme first-paint fix. The mount effect below still runs
   * (it re-merges and loads the email); it now confirms rather than swaps.
   */
  const [settings, setSettings] = useState<UserSettings>(() => {
    let initial = DEFAULT_SETTINGS;
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (saved) initial = validateSettings(JSON.parse(saved));
    } catch {
      /* hostile storage: defaults */
    }
    return fromTableSettings(tableSettingsRef.current, initial);
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userEmail, setUserEmail] = useState<string>('');
  const [showThemeSettings, setShowThemeSettings] = useState(false);
  const [isVip, setIsVip] = useState(false);

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
  const [pushTesting, setPushTesting] = useState(false);

  // Section refs for tab navigation
  const audioRef = useRef<HTMLElement>(null);
  const appearanceRef = useRef<HTMLElement>(null);
  const notificationsRef = useRef<HTMLElement>(null);
  const securityRef = useRef<HTMLElement>(null);
  const dangerRef = useRef<HTMLElement>(null);
  const emailDialogTitleId = useId();
  const passwordDialogTitleId = useId();
  const twoFactorDialogTitleId = useId();

  useEffect(() => {
    if (!showEmailModal && !showPasswordModal && !show2FAModal) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowEmailModal(false);
      setShowPasswordModal(false);
      setShow2FAModal(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [show2FAModal, showEmailModal, showPasswordModal]);

  // Tab-based scroll navigation
  useEffect(() => {
    if (!activeSettingsSection) return;

    const sectionToRef: Record<SettingsSectionId, React.RefObject<HTMLElement | null>> = {
      audio: audioRef,
      display: appearanceRef,
      notifications: notificationsRef,
      account: securityRef,
      data: dangerRef,
    };

    const targetRef = sectionToRef[activeSettingsSection];
    if (targetRef?.current) {
      setTimeout(() => {
        targetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [activeSettingsSection]);

  const jumpToSection = (tab: SettingsSectionId, target: RefObject<HTMLElement | null>) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
    target.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Load settings from localStorage on mount
  useEffect(() => {
    let isMounted = true;
    const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    // The table's own store wins for the keys the two share: it is what the
    // table is actually using right now, and it can be changed from the
    // in-table settings panel while this page is closed. Opening this page must
    // not silently show — and then save back — a stale copy.
    let initial = DEFAULT_SETTINGS;
    if (saved) {
      try {
        initial = validateSettings(JSON.parse(saved));
      } catch (e) {
        reportError(e, 'SettingsPage.Failed_to_load_settings');
      }
    }
    setSettings(fromTableSettings(tableSettingsRef.current, initial));
    // Get current user email from auth session (avoid redundant getUser() call)
    if (authUser?.id) {
      supabase.auth
        .getSession()
        .then(({ data: { session } }) => {
          if (isMounted && session?.user?.email) setUserEmail(session.user.email);
        })
        .catch((e) => console.warn('[SettingsPage] Failed to fetch user session:', e));
    }
    return () => {
      isMounted = false;
    };
  }, [authUser?.id]);

  useEffect(() => {
    if (!authUser?.id) {
      setIsVip(false);
      return;
    }
    let mounted = true;
    supabase
      .from('profiles')
      .select('is_vip, tier')
      .eq('id', authUser.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          reportError(error, 'SettingsPage.Vip_status_load_failed');
          return;
        }
        if (mounted) setIsVip(data?.is_vip === true || data?.tier === 'vip');
      });
    return () => {
      mounted = false;
    };
  }, [authUser?.id]);

  /**
   * CROSS-DEVICE HYDRATION (2026-09-04). Every save wrote profiles.settings and
   * the three push columns, and NOTHING ever read them back: this page only
   * ever read localStorage, so a second phone, a cleared browser or a fresh
   * install showed factory defaults while the server held the player's real
   * choices - and the next Save silently overwrote them with the defaults.
   *
   * Local wins for the table keys (the felt may have changed them while this
   * page was closed); the server wins for the three push switches, because
   * those columns are what the push sender actually consults. A device with
   * no saved copy at all takes the whole server record.
   */
  useEffect(() => {
    if (!authUser?.id) return;
    let mounted = true;
    const hasLocal = (() => {
      try {
        return !!localStorage.getItem(STORAGE_KEYS.SETTINGS);
      } catch {
        return false;
      }
    })();
    Promise.all([
      supabase.from('profiles').select('settings').eq('id', authUser.id).maybeSingle(),
      supabase
        .from('user_notification_preferences')
        .select('tournament_reminders, friend_activity, club_updates')
        .eq('user_id', authUser.id)
        .maybeSingle(),
    ]).then(([profileRes, prefsRes]) => {
      if (!mounted) return;
      if (profileRes.error) reportError(profileRes.error, 'SettingsPage.server_settings_read');
      if (prefsRes.error) reportError(prefsRes.error, 'SettingsPage.notification_prefs_read');
      const serverSettings =
        !hasLocal && profileRes.data?.settings && typeof profileRes.data.settings === 'object'
          ? validateSettings(profileRes.data.settings)
          : null;
      const prefs = prefsRes.data;
      if (!serverSettings && !prefs) return;
      setSettings((prev) => {
        const base = serverSettings
          ? fromTableSettings(tableSettingsRef.current, serverSettings)
          : prev;
        if (!prefs) return base;
        return {
          ...base,
          tournamentReminders: prefs.tournament_reminders ?? base.tournamentReminders,
          friendAlerts: prefs.friend_activity ?? base.friendAlerts,
          clubActivity: prefs.club_updates ?? base.clubActivity,
        };
      });
    });
    return () => {
      mounted = false;
    };
  }, [authUser?.id]);

  // Bus listeners: re-read settings from localStorage when profile/settings change externally
  useEffect(() => {
    let isMounted = true;
    const reloadSettings = () => {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (saved) {
        try {
          setSettings(validateSettings(JSON.parse(saved)));
        } catch {
          /* parse error */
        }
      }
    };
    const unsub1 = masterBus.subscribeDebounced('SETTINGS_UPDATED', reloadSettings, 300);
    const unsub2 = masterBus.subscribeDebounced(
      'PROFILE_UPDATED',
      () => {
        getAuthUser().then(({ data }) => {
          if (isMounted && data?.user?.email) setUserEmail(data.user.email);
        });
      },
      300
    );
    return () => {
      isMounted = false;
      unsub1();
      unsub2();
    };
  }, []);

  // Refresh data when user returns to tab
  useVisibilityRefresh(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (saved) {
      try {
        setSettings(validateSettings(JSON.parse(saved)));
      } catch {
        /* parse error */
      }
    }
    getAuthUser().then(({ data }) => {
      if (data?.user?.email) setUserEmail(data.user.email);
    });
  });

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
      reportError(err, 'SettingsPage.Email_update_failed');
      toast.error(err?.message || 'Failed to update email.');
    }
    setActionLoading(false);
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      toast.error('Password must include at least one uppercase letter and one number');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setActionLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setShowPasswordModal(false);
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated successfully!');
    } catch (err: any) {
      reportError(err, 'SettingsPage.Password_update_failed');
      toast.error(err?.message || 'Failed to update password.');
    }
    setActionLoading(false);
  };

  const [analyticsConsent, setAnalyticsConsentState] = useState(() => getAnalyticsConsent());

  const handleExportData = async () => {
    setActionLoading(true);
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) {
        // The old early return skipped setActionLoading(false), so a signed
        // out tab kept every account button disabled behind "Exporting...".
        toast.error('Sign in again to export your data.');
        return;
      }

      // Fetch user data from various tables
      const [profiles, wallets, achievements, handHistory] = await Promise.all([
        supabase
          .from('profiles')
          /**
           * `streak_days` REMOVED FROM THIS EXPORT (2026-08-29).
           *
           * It is a dead column: 0 non-zero values across all 1,023 profiles,
           * and nothing in the repo has ever written it. `login_streak` is the
           * live one — `AchievementTriggerService.onLogin` maintains it against
           * `last_login_date`. This export fetched `streak_days` and then never
           * read it, which is harmless in itself but is exactly how a dead
           * column stays alive: the next person greps, finds a reader, and
           * assumes it means something.
           *
           * See the migration of the same date, which puts that fact in a
           * COMMENT on the column where a schema reader will find it.
           */
          .select(
            'id, display_name, username, avatar_url:arena_avatar_url, bio, role, created_at, last_login'
          )
          .eq('id', user.id)
          .maybeSingle(),
        // A DATA EXPORT MUST NOT EXPORT A FROZEN NUMBER (fixed 2026-08-27).
        // This exported rows from the retired global wallet table, frozen
        // since 2026-08-21 - handing the player a formatted, confident,
        // six-day-stale balance as their own record. The live club-scoped
        // pool is what they actually hold.
        supabase
          .from('club_members')
          .select('club_id, user_id, chip_balance, promo_balance, locked_chips')
          .eq('user_id', user.id)
          // Ordered so a re-export of unchanged data is byte-identical, and
          // so the membership-cap rule in tests/unit/clubMemberStatus.test.ts
          // reads this chain unambiguously (it scans to the next semicolon,
          // which here runs on into the sibling query's own .limit()).
          .order('club_id', { ascending: true }),
        supabase
          .from('training_user_achievements')
          .select('id, user_id, achievement_id, unlocked_at, progress')
          .eq('user_id', user.id),
        // Round 38 audit Pass 1 fix: hand_history has no player_id column.
        // .eq('player_id', user.id) returned an error/empty for every export.
        // Players live in the JSONB players array — use contains().
        supabase
          .from('hand_history')
          .select(
            'id, hand_number, game_variant, small_blind, big_blind, pot_size, community_cards, winners, players, created_at'
          )
          .contains('players', [{ userId: user.id }])
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
      const exportName = `club-arena-export-${new Date().toISOString().split('T')[0]}.json`;
      // THE APP (2026-09-08): a webview honours no <a download>; the share
      // sheet on the written file (src/lib/native/share.ts).
      if (isNativePlatform()) {
        const { nativeShareBlob } = await import('../lib/native/share');
        await nativeShareBlob(blob, exportName, 'Club Arena Data Export');
        toast.success('Data exported successfully!');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Data exported successfully!');
    } catch (err) {
      reportError(err, 'SettingsPage.Export_failed');
      toast.error('Failed to export data. Please try again.');
    } finally {
      setActionLoading(false);
    }
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
        /* Until 2026-09-04 this button signed the player out, cleared two
           local caches and toasted "contact support" - while its label read
           "Permanently Delete Your Account And All Data". Nothing was deleted
           and nothing was requested. The World Hub owns account deletion
           (DELETE /api/auth/delete-account, same origin, bearer session, the
           same shape NotificationsPage uses for the feed). Only a confirmed
           server success signs the player out; a refusal is shown verbatim
           and the account stays exactly as it was. */
        const sessionRes = await supabase.auth.getSession();
        const token = sessionRes.data?.session?.access_token;
        if (!token) throw new Error('Sign in again before closing your account.');
        const res = await fetch('/api/auth/delete-account', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ confirm: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.success === false) {
          throw new Error(
            typeof body?.error === 'string' && body.error
              ? body.error
              : `The deletion request was refused (HTTP ${res.status}).`
          );
        }
        try {
          const keys = Object.keys(sessionStorage);
          keys.forEach((k) => {
            if (k.startsWith('profile_cache_')) sessionStorage.removeItem(k);
          });
          localStorage.removeItem(STORAGE_KEYS.SETTINGS);
        } catch {
          /* cleanup best-effort */
        }
        toast.success('Your account has been closed. Signing you out.');
        await identityDNA.logout();
        // AuthGuard will handle redirect to /auth
      } catch (err) {
        reportError(err, 'SettingsPage.Account_deletion_failed');
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : 'The account could not be closed. Please try again.'
        );
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
        reportError(err, 'SettingsPage.Failed_to_disable_2FA');
        toast.error('Failed to disable 2FA. Please try again.');
      }
      setActionLoading(false);
    } else if (actionType === 'reset-settings') {
      /* A RESET DOES NOT REACH INTO WHAT THE PLAYER BOUGHT (2026-09-05).
         This was `setSettings(DEFAULT_SETTINGS)`, and DEFAULT_SETTINGS.cardBack
         is 'classic_blue'. Card backs are a real purchase - feature_pricing
         sells them at 75 to 300 diamonds - so resetting silently put a paying
         player back on the free deck with nothing in the dialog that said so.
         Ownership was never lost, but the selection was, and re-picking it
         means going and finding it again.

         Everything else genuinely is a preference and resets. */
      setSettings((current) => ({ ...DEFAULT_SETTINGS, cardBack: current.cardBack }));
      setHasChanges(true);
    }
  };

  const handleDeleteAccount = () => {
    setConfirmAction({
      type: 'delete-account',
      title: 'Close Account',
      message:
        'This asks Smarter Poker to permanently delete your account, profile and history. Accounts still holding club chips or a seat are refused until they are settled. This cannot be undone.',
      variant: 'danger',
    });
  };

  const handleSignOut = async () => {
    setActionLoading(true);
    try {
      // identityDNA owns the signOut lifecycle (see HamburgerMenu): it runs the
      // auth listener and the store teardown that a bare supabase.auth.signOut
      // would skip.
      await identityDNA.logout();
    } catch (err) {
      reportError(err, 'SettingsPage.Sign_out_failed');
      toast.error('Could not sign out. Please try again.');
      setActionLoading(false);
    }
  };

  // 2FA Handlers
  const check2FAStatus = async () => {
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) return;

      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.find((f) => f.status === 'verified');
      setTwoFactorEnabled(!!totpFactor);
      if (totpFactor) setFactorId(totpFactor.id);
    } catch (err) {
      reportError(err, 'SettingsPage.Failed_to_check_2FA_status');
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
      reportError(err, 'SettingsPage.Failed_to_enable_2FA');
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
      reportError(err, 'SettingsPage.Failed_to_verify_2FA');
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

  // Does THIS device hold a push subscription? Not "did the OS dialog get
  // accepted at some point", which is the question the old code asked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const subscribed = await hasLocalSubscription();
      if (!cancelled) setPushEnabled(subscribed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * DELIBERATE: enablePush() is awaited directly out of the click handler with
   * nothing before it. iOS only honours Notification.requestPermission() while
   * the originating tap gesture is alive, so any await placed ahead of it can
   * eat the gesture window and the OS prompt then never appears at all.
   */
  const handleEnablePush = async () => {
    setPushLoading(true);
    try {
      const result = await enablePush();
      setPushEnabled(result.ok);
      if (result.ok) {
        toast.success('Push notifications are on for this device');
      } else if (isIos() && !isIosStandalonePwa()) {
        // The one instruction that unblocks an iPhone. Web push does not exist
        // in mobile Safari until the site is installed to the Home Screen.
        toast.error('Add Smarter Poker to your Home Screen first, then open it from there');
      } else {
        toast.error(result.error || 'Could not enable push notifications');
      }
    } catch (err) {
      reportError(err, 'SettingsPage.Failed_to_enable_push');
      toast.error('Failed to enable push notifications');
    }
    setPushLoading(false);
  };

  /**
   * Off means off. This unsubscribes locally, deactivates the row server-side,
   * and records the opt-out marker that stops PushSubscriptionSync quietly
   * re-subscribing the device on the next boot. Without that marker the
   * repair loop would undo this within the hour, because the OS permission
   * stays granted after an unsubscribe.
   */
  const handleDisablePush = async () => {
    setPushLoading(true);
    try {
      const result = await disablePush();
      if (result.ok) {
        setPushEnabled(false);
        toast.success('Push notifications are off for this device');
      } else {
        toast.error(result.error || 'Could not turn off push notifications');
      }
    } catch (err) {
      reportError(err, 'SettingsPage.Failed_to_disable_push');
      toast.error('Failed to turn off push notifications');
    }
    setPushLoading(false);
  };

  /**
   * Prove the subscription actually delivers.
   *
   * A green "On for this device" row only means a subscription was persisted.
   * It cannot tell anyone whether a notification will reach the phone, and the
   * gap between those two is exactly where this stack has failed before. The
   * toast reports the DEVICE COUNT rather than just success, because "sent to
   * 0 devices" is the informative answer: it means the row exists and the push
   * service rejected it, which is a different fault from never having enrolled.
   */
  const handleTestPush = async () => {
    setPushTesting(true);
    try {
      const result = await sendTestPush();
      if (result.ok) {
        toast.success(
          result.sent === 1
            ? 'Test sent to 1 device. It should arrive in a moment'
            : `Test sent to ${result.sent} devices. It should arrive in a moment`
        );
      } else {
        toast.error(result.error || 'The test push was not delivered');
      }
    } catch (err) {
      reportError(err, 'SettingsPage.Failed_to_send_test_push');
      toast.error('Failed to send the test notification');
    }
    setPushTesting(false);
  };

  const updateSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const settingsToPersist = settings;
      // Save to localStorage
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));

      // …and into the store the TABLE reads. updateSettings persists to
      // club-arena-table-settings and emits SETTINGS_CHANGED per key, which the
      // useTableSettings instance inside an open TablePage subscribes to — so a
      // table already on screen picks these up without a reload.
      /* Pass the CURRENT table settings so a speed this page cannot name (2, in
         a scale of 0.5|1|1.5|2 rendered as three labels) survives a Save that
         never touched the animation control. */
      updateTableSettings(toTableSettings(settings, tableSettingsRef.current));

      /* Dan 2026-08-28: the Sound Effects switch on this page never reached
         the sound engine. It persisted soundEnabled into
         club-arena-table-settings, but the gate that actually silences
         playback (utils/soundGate, consulted by SoundService.shouldPlay)
         reads 'club_arena_sounds' / 'ca_sound_enabled' — neither of which
         this page wrote. So muting here said "Settings saved!", the felt
         kept playing, and the in-table switch still read ON: two switches
         permanently disagreeing. setEnabled() updates the live engine AND
         persists BOTH gate keys (the HamburgerMenu path); volume is applied
         live for the same reason rather than waiting for a table mount. */
      /* Neither volume nor the sound gate is applied here any more.
         `updateTableSettings` above commits both to the store, and the store's
         `applyGateChanges` (useTableSettings.ts) is the one caller of
         soundService.setEnabled and writes both gate keys. The second block
         this comment used to sit beside was a byte-for-byte duplicate. */

      /* Sync theme to Zustand store so Shell.tsx applies it immediately.
         2026-08-26: "Auto (System)" was offered in the dropdown, accepted by
         validation, saved, and then DROPPED here by an
         `if (dark || light)` guard — the page said "Settings saved!" and the
         app kept whatever theme it already had. Auto now resolves against the
         OS preference at save time, which is what the label promises. */
      const { setTheme } = useSettingsStore.getState();
      if (settings.theme === 'dark' || settings.theme === 'light') {
        setTheme(settings.theme, authUser?.id);
      } else if (settings.theme === 'auto') {
        const prefersLight =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-color-scheme: light)').matches;
        setTheme(prefersLight ? 'light' : 'dark', authUser?.id);
      }

      // Sync to Supabase profiles table
      const {
        data: { user },
      } = await getAuthUser();

      /* A SAVE THAT PERSISTED NOTHING MUST NOT SAY "SAVED" (2026-09-05).
         Everything below was inside `if (user)`, and `setHasChanges(false)`
         plus the success toast were outside it. So a session whose auth had
         lapsed - the exact case where a save fails - skipped every write,
         cleared the unsaved-changes flag and reported "Settings saved!". The
         player then navigated away believing their controls were stored.
         Local state (the theme store and the table settings above) is real and
         survives, so this is not a bare throw: it says what actually happened. */
      if (!user) {
        toast.error('Your Session Expired. Sign In Again To Save These Settings.');
        return;
      }

      {
        const { error: profileErr } = await supabase
          .from('profiles')
          .update({ settings: settingsToPersist })
          .eq('id', user.id);
        if (profileErr) throw profileErr;

        /* PHANTOM COLUMN FIX 2026-08-27: this upsert named FIVE columns that
           do not exist on user_notification_preferences (table_alerts,
           achievement_alerts, friend_alerts, club_announcements,
           settlement_alerts). PostgREST returned PGRST204, the throw below
           fired, and setHasChanges(false) plus the success toast were never
           reached — so "Save Changes" failed 100% of the time and the button
           never cleared, for every user, on every save. Mapped to the real
           columns; the two settings with no column (achievements, settlement
           alerts) still live in profiles.settings, written just above.

           It is also no longer fatal: a push-preferences hiccup must not
           fail the whole settings save. */
        /* PHANTOM SETTING FIX 2026-08-28: this upsert also wrote
           `live_notifications: settings.handWonNotifications ?? true`, and
           every part of that line was wrong.

           `handWonNotifications` has NO CONTROL anywhere in this page, or
           anywhere in Club Arena. It is declared in settingsBridge.ts and
           defaults to FALSE, and `??` only falls through on null or undefined
           -- false is neither. So the expression evaluated to `false` on every
           save, for every user, unconditionally.

           `live_notifications` is not a Club Arena column in any meaningful
           sense: World Hub's gate maps `live`, `live_invite` and `live_gift`
           onto it (src/lib/push/push-prefs.js LEGACY_PREF_COLUMN), i.e. LIVE
           STREAMING. It has nothing to do with winning a hand. So pressing
           Save Changes here silently switched off a completely unrelated hub
           feature, permanently, with nothing in this UI that said so, and no
           way to switch it back on from Club Arena.

           A settings page must only write what it actually offers a control
           for. The three below each have a visible toggle in this section.
           `live_notifications` is owned by the hub's own notification
           settings, which is where a player can see and change it.

           `handWonNotifications` itself still round-trips through
           profiles.settings with the rest of the bridge; nothing reads it yet,
           so it is inert rather than harmful. */
        const { error: notifErr } = await supabase.from('user_notification_preferences').upsert(
          {
            user_id: user.id,
            tournament_reminders: settings.tournamentReminders ?? true,
            friend_activity: settings.friendAlerts ?? true,
            club_updates: settings.clubActivity ?? true,
          },
          { onConflict: 'user_id' }
        );
        if (notifErr) reportError(notifErr, 'SettingsPage.notification_prefs_upsert');
      }

      setHasChanges(false);

      // Notify other components that settings changed
      masterBus.emit('SETTINGS_UPDATED', {
        settings: settingsToPersist as unknown as Record<string, unknown>,
      });
      toast.success('Settings saved!');
    } catch (error) {
      reportError(error, 'SettingsPage.Failed_to_sync_settings');
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
        'Reset every setting to its default? Your card back is left alone, because you may have paid for it. You will still need to save for this to take effect.',
      variant: 'default',
    });
  };

  return (
    <StandardContentLayout className={styles.page}>
      <AccountSurfaceHeader
        artwork="images/account/control-room-hero-v1.webp"
        eyebrow="Account Control // Player Vault"
        title="Control Room"
        description="Sound, Table Display, Alerts, Device Access, Identity Security And Account Data. Every Control Here Is Live On The Felt The Moment You Save."
        status={hasChanges ? 'Changes Pending' : 'Systems Synced'}
      >
        <span className={styles.heroMetric}>
          <small>Identity</small>
          {userEmail || 'Authenticated'}
        </span>
        <span className={styles.heroMetric}>
          <small>2FA</small>
          {twoFactorEnabled ? 'Protected' : 'Available'}
        </span>
        <span className={styles.heroMetric}>
          <small>Push</small>
          {pushEnabled ? 'Connected' : 'Off'}
        </span>
      </AccountSurfaceHeader>

      <nav className={styles.controlIndex} aria-label="Settings Sections">
        {[
          { id: 'audio' as const, label: 'Audio', ref: audioRef },
          { id: 'display' as const, label: 'Table & Display', ref: appearanceRef },
          { id: 'notifications' as const, label: 'Alerts', ref: notificationsRef },
          { id: 'account' as const, label: 'Security', ref: securityRef },
          { id: 'data' as const, label: 'Account Data', ref: dangerRef },
        ].map((item) => (
          <button
            type="button"
            key={item.id}
            className={activeSettingsSection === item.id ? styles.controlIndexActive : ''}
            onClick={() => jumpToSection(item.id, item.ref)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className={styles.headerActions} aria-live="polite">
        <span className={styles.changeState}>
          {hasChanges ? 'Unsaved Controls Are Staged Locally.' : 'All Visible Controls Are Saved.'}
        </span>
        <div>
          {hasChanges && (
            <button className={styles.saveButton} onClick={saveSettings} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
          <button className={styles.resetButton} onClick={resetSettings}>
            Reset
          </button>
        </div>
      </div>

      <div className={styles.content}>
        {/* Audio Settings */}
        <section ref={audioRef} className={styles.section} style={settingsSectionAnimationStyle(0)}>
          <h2>Audio</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Sound Effects</span>
              <span className={styles.settingDesc}>Play Sounds For Actions And Events</span>
            </div>
            <Toggle
              checked={settings.soundEnabled}
              onChange={(v) => updateSetting('soundEnabled', v)}
              label="Sound Effects"
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
              label="Sound Volume"
            />
          </div>
        </section>

        {/* Display Settings */}
        <section
          ref={appearanceRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(1)}
        >
          <h2>Table &amp; Display</h2>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Theme</span>
            </div>
            <select
              className={styles.select}
              value={settings.theme}
              aria-label="Theme"
              onChange={(e) => updateSetting('theme', e.target.value as UserSettings['theme'])}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Auto (System)</option>
            </select>
          </div>

          <div className={`${styles.settingRow} ${styles.studioRow}`}>
            <div className={styles.settingInfo}>
              <span className={styles.settingEyebrow}>Appearance Suite</span>
              <span className={styles.settingLabel}>Table Studio</span>
              <span className={styles.settingDesc}>
                Tables, Backgrounds, Buttons And Card Backs In One Live Studio
              </span>
            </div>
            <button
              type="button"
              className={styles.studioButton}
              onClick={() => setShowThemeSettings(true)}
            >
              Open Studio
            </button>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Four-Color Deck</span>
              <span className={styles.settingDesc}>
                Hearts ♥, Diamonds ♦ (Blue), Clubs ♣ (Green), Spades ♠
              </span>
            </div>
            <Toggle
              checked={settings.fourColorDeck}
              onChange={(v) => updateSetting('fourColorDeck', v)}
              label="Four-Color Deck"
            />
          </div>

          {/* Dan 2026-08-28: "add a toggle... in the Club Arena settings to
              turn the ticker on or off." Same stored setting the in-table
              panel writes, so either surface flips the live bar. */}
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Announcement Ticker</span>
              <span className={styles.settingDesc}>
                Show The Scrolling Tournament And Announcement Ticker
              </span>
            </div>
            <Toggle
              checked={settings.showTicker}
              onChange={(v) => updateSetting('showTicker', v)}
              label="Announcement Ticker"
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Animation Speed</span>
            </div>
            <select
              className={styles.select}
              value={settings.animationSpeed}
              aria-label="Animation Speed"
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
              <span className={styles.settingDesc}>Display Pot Odds During Your Action</span>
            </div>
            <Toggle
              checked={settings.showPotOdds}
              onChange={(v) => updateSetting('showPotOdds', v)}
              label="Show Pot Odds"
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
              <span className={styles.settingDesc}>Notify Before Registered Tournaments Start</span>
            </div>
            <Toggle
              checked={settings.tournamentReminders}
              onChange={(v) => updateSetting('tournamentReminders', v)}
              label="Tournament Reminders"
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Club Activity</span>
              <span className={styles.settingDesc}>New Tables, Tournaments, And Announcements</span>
            </div>
            <Toggle
              checked={settings.clubActivity}
              onChange={(v) => updateSetting('clubActivity', v)}
              label="Club Activity"
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Achievement Unlocked</span>
            </div>
            <Toggle
              checked={settings.achievementNotifications}
              onChange={(v) => updateSetting('achievementNotifications', v)}
              label="Achievement Unlocked"
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Friend Alerts</span>
              <span className={styles.settingDesc}>Friend Requests, Status Changes</span>
            </div>
            <Toggle
              checked={settings.friendAlerts}
              onChange={(v) => updateSetting('friendAlerts', v)}
              label="Friend Alerts"
            />
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Settlement Alerts</span>
              <span className={styles.settingDesc}>Chip Settlement And Transfer Notifications</span>
            </div>
            <Toggle
              checked={settings.settlementAlerts}
              onChange={(v) => updateSetting('settlementAlerts', v)}
              label="Settlement Alerts"
            />
          </div>

          {/* Push. The description states what is true of THIS device, and the
            button is reachable in every state: an iPhone that has not been
            installed to the Home Screen gets the instruction rather than a
            dead control, a blocked browser is told where to unblock, and a
            subscribed device can turn it back off. The previous version had
            no off switch at all, so a player who enabled push had no way to
            change their mind from inside the app. */}
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Push Notifications</span>
              <span className={styles.settingDesc}>
                {pushEnabled
                  ? 'On For This Device'
                  : !isWebPushSupported() && isIos() && !isIosStandalonePwa()
                    ? 'Add To Your Home Screen First, Then Open It From There'
                    : !isWebPushSupported()
                      ? 'Not Supported By This Browser'
                      : notificationPermission() === 'denied'
                        ? 'Blocked. Allow Notifications In Your Browser Settings'
                        : 'Get Alerted The Moment Your Seat Opens'}
              </span>
            </div>
            {pushEnabled ? (
              <button
                className={styles.actionButton}
                onClick={handleDisablePush}
                disabled={pushLoading || pushTesting}
              >
                {pushLoading ? 'Turning Off...' : 'Turn Off'}
              </button>
            ) : (
              <button
                className={styles.actionButton}
                onClick={handleEnablePush}
                disabled={pushLoading || !isWebPushSupported()}
              >
                {pushLoading ? 'Enabling...' : 'Enable'}
              </button>
            )}
          </div>

          {/* Only shown once this device holds a subscription, because that is
            the only state in which the answer means anything. Offered to a
            device that never enrolled, a test that fails would say nothing the
            row above has not already said. */}
          {pushEnabled && (
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingLabel}>Send A Test Notification</span>
                <span className={styles.settingDesc}>
                  Check That Alerts Actually Reach This Device
                </span>
              </div>
              <button
                className={styles.actionButton}
                onClick={handleTestPush}
                disabled={pushTesting || pushLoading}
              >
                {pushTesting ? 'Sending...' : 'Send Test'}
              </button>
            </div>
          )}
        </section>

        {/* Account */}
        <section
          ref={securityRef}
          className={styles.section}
          style={settingsSectionAnimationStyle(6)}
        >
          <h2>Identity Security</h2>

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
                  ? 'Enabled - Your Account Is Protected'
                  : 'Add Extra Security To Your Account'}
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
                {actionLoading ? 'Setting Up...' : 'Enable'}
              </button>
            )}
          </div>

          {/* The one door out. It was only in the hamburger; a security
              section without a sign-out control sends a player hunting. */}
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Sign Out</span>
              <span className={styles.settingDesc}>End This Session On This Device</span>
            </div>
            <button
              type="button"
              className={styles.actionButtonSecondary}
              onClick={handleSignOut}
              disabled={actionLoading}
            >
              Sign Out
            </button>
          </div>
        </section>

        {/* Danger Zone */}
        <section ref={dangerRef} className={`${styles.section} ${styles.dangerZone}`}>
          <h2>Account Data &amp; Closure</h2>

          {/* THE APP: product analytics is opt-in (src/lib/consent.ts). The
              web's analytics are unchanged, so the switch only exists here. */}
          {IS_NATIVE_BUILD && (
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <span className={styles.settingLabel}>Share Usage Analytics</span>
                <span className={styles.settingDesc}>
                  Anonymous Usage Data To Improve Club Arena. Never Hands, Chips Or Messages.
                </span>
              </div>
              <Toggle
                checked={analyticsConsent === 'granted'}
                onChange={(v) => {
                  setAnalyticsConsent(v ? 'granted' : 'denied');
                  setAnalyticsConsentState(v ? 'granted' : 'denied');
                }}
                label="Share Usage Analytics"
              />
            </div>
          )}

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingLabel}>Export Data</span>
              <span className={styles.settingDesc}>Download All Your Data And Hand Histories</span>
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
              <span className={styles.settingLabel}>Close Account</span>
              <span className={styles.settingDesc}>
                Permanently Delete Your Account. Settle Every Club Balance First
              </span>
            </div>
            <button
              className={styles.dangerButton}
              onClick={handleDeleteAccount}
              disabled={actionLoading}
            >
              {actionLoading ? 'Working...' : 'Close Account'}
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
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby={emailDialogTitleId}
          >
            <h3 id={emailDialogTitleId}>Change Email</h3>
            <p>A Confirmation Email Will Be Sent To Your New Address.</p>
            <label className={styles.fieldLabel} htmlFor="settings-new-email">
              New Email Address
            </label>
            <input
              id="settings-new-email"
              type="email"
              placeholder="New Email Address"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className={styles.input}
              autoComplete="email"
              autoFocus
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
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby={passwordDialogTitleId}
          >
            <h3 id={passwordDialogTitleId}>Change Password</h3>
            <p>At Least 8 Characters, With One Uppercase Letter And One Number.</p>
            <label className={styles.fieldLabel} htmlFor="settings-new-password">
              New Password
            </label>
            <input
              id="settings-new-password"
              type="password"
              placeholder="New Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={styles.input}
              autoComplete="new-password"
              autoFocus
            />
            <label className={styles.fieldLabel} htmlFor="settings-confirm-password">
              Confirm New Password
            </label>
            <input
              id="settings-confirm-password"
              type="password"
              placeholder="Confirm New Password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={styles.input}
              autoComplete="new-password"
            />
            {newPassword && confirmPassword && newPassword !== confirmPassword && (
              <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>Passwords Don't Match</p>
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
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby={twoFactorDialogTitleId}
          >
            <h3 id={twoFactorDialogTitleId}>Set Up Two-Factor Authentication</h3>
            <p>Scan This QR Code With Your Authenticator App (Google Authenticator, Authy, Etc.)</p>

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
              Or Enter This Secret Manually:{' '}
              <code
                style={{ background: '#1f2937', padding: '0.25rem 0.5rem', borderRadius: '4px' }}
              >
                {totpSecret}
              </code>
            </p>

            <input
              aria-label="Six-Digit Authenticator Code"
              type="text"
              placeholder="Enter 6-Digit Code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={styles.input}
              style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.5rem' }}
              maxLength={6}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
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
      <ThemeSettingsModal
        isOpen={showThemeSettings}
        onClose={() => setShowThemeSettings(false)}
        userId={authUser?.id || ''}
        isVip={isVip}
      />

      <ConfirmModal
        isOpen={!!confirmAction}
        title={confirmAction?.title || 'Confirm'}
        message={confirmAction?.message || ''}
        variant={confirmAction?.variant || 'default'}
        confirmText={confirmAction?.type === 'delete-account' ? 'Close My Account' : 'Confirm'}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
        loading={actionLoading}
      />
    </StandardContentLayout>
  );
}
