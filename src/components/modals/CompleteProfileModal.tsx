/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Complete Profile Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Forces users to configure their Poker Alias, Real Name, and Avatar
 * if they signed in via a provider (Google) that skipped the Hub signup form.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { reportError } from '../../utils/errorReporter';
import { STORAGE_KEYS } from '../../lib/storage';
import styles from './CompleteProfileModal.module.css';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { AvatarGallery } from '../customization/AvatarGallery';

interface CompleteProfileModalProps {
  isOpen: boolean;
  onComplete: () => void;
}

export default function CompleteProfileModal({ isOpen, onComplete }: CompleteProfileModalProps) {
  const { user, setUser } = useUserStore();
  const [alias, setAlias] = useState('');
  const [realName, setRealName] = useState('');
  const [mounted, setMounted] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showAvatarGallery, setShowAvatarGallery] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (user) {
        setAlias(user.username.startsWith('Player') ? '' : user.username);
        setRealName(user.display_name === 'New Player' ? '' : user.display_name || '');
      }
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen, user]);

  if (!isOpen || !user) return null;

  const hasAvatar = !!user.avatar_url;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    if (!hasAvatar) {
      setError('Please select an Avatar.');
      setIsSaving(false);
      return;
    }

    const safeAlias = sanitizeInput(alias);
    const safeRealName = sanitizeInput(realName) || safeAlias; // Fallback

    if (!safeAlias) {
      setError('Poker Alias is required.');
      setIsSaving(false);
      return;
    }

    try {
      // 1. Update Profiles Table
      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          username: safeAlias,
          display_name: safeRealName,
        })
        .eq('id', user.id);

      if (profileError) {
        if (profileError.code === '23505') {
          throw new Error('This Poker Alias is already taken.');
        }
        throw profileError;
      }

      // 2. Update Public Users table
      await supabase.from('users').update({ username: safeAlias }).eq('id', user.id);

      // 3. Update Local Store
      setUser({
        ...user,
        username: safeAlias,
        display_name: safeRealName,
      });

      onComplete();
    } catch (err: any) {
      reportError(err, 'CompleteProfileModal.SaveFailed');
      setError(safeErrorMessage(err, 'Failed to save profile. Try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <div className={styles.overlay}>
        <div
          className={styles.modal}
          style={{
            opacity: mounted ? 1 : 0,
            transform: mounted ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <header className={styles.header}>
            <h2>Complete Your Profile</h2>
          </header>

          <div className={styles.content}>
            <p className={styles.intro}>
              Welcome To Club Arena! Before You Hit The Tables, Please Choose Your Poker Alias And
              Avatar.
            </p>

            <div className={styles.avatarSection}>
              <label>Profile Avatar (Required)</label>
              <div className={styles.avatarControls}>
                <div
                  className={`${styles.avatarPreview} ${!hasAvatar ? styles.avatarPreviewNeedsAvatar : ''}`}
                  onClick={() => setShowAvatarGallery(true)}
                >
                  {hasAvatar ? (
                    <img src={user.avatar_url!} alt="Your Avatar" className={styles.avatarImg} />
                  ) : (
                    <div className={styles.avatarPlaceholder}>
                      <span>+</span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={styles.selectAvatarBtn}
                  onClick={() => setShowAvatarGallery(true)}
                >
                  {hasAvatar ? 'Change Avatar' : 'Select Avatar'}
                </button>
              </div>
            </div>

            <form id="complete-profile-form" onSubmit={handleSave} className={styles.formGroup}>
              <div className={styles.formGroup}>
                <label>Poker Alias (Required)</label>
                <div className={styles.inputWrapper}>
                  <span className={styles.inputIcon}>◆</span>
                  <input
                    className={styles.input}
                    placeholder="E.g. SharkPro99"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    maxLength={16}
                    required
                  />
                </div>
              </div>

              <div className={styles.formGroup} style={{ marginTop: '0.5rem' }}>
                <label>Real Name (Optional)</label>
                <div className={styles.inputWrapper}>
                  <span className={styles.inputIcon}>◉</span>
                  <input
                    className={styles.input}
                    placeholder="E.g. John Doe"
                    value={realName}
                    onChange={(e) => setRealName(e.target.value)}
                    maxLength={24}
                  />
                </div>
              </div>

              {error && <div className={styles.errorText}>{error}</div>}

              <div className={styles.infoBox}>
                <p>You Can Change These Later In Your Profile Settings.</p>
              </div>
            </form>
          </div>

          <footer className={styles.footer}>
            <button
              type="submit"
              form="complete-profile-form"
              className={styles.submitButton}
              disabled={isSaving || !alias.trim() || !hasAvatar}
            >
              {isSaving ? 'Saving...' : 'Enter Arena'}
            </button>
          </footer>
        </div>
      </div>

      {/* Modals rendered outside so they overlay properly */}
      <AvatarGallery
        userId={user.id}
        currentAvatarUrl={user.avatar_url || ''}
        isVip={user.vip_level !== 'bronze'}
        isOpen={showAvatarGallery}
        onClose={() => setShowAvatarGallery(false)}
        onAvatarChanged={(newUrl) => {
          // Synchronize local state immediately so the required gate clears
          setUser({ ...user, avatar_url: newUrl });
        }}
      />
    </>
  );
}

/**
 * Hook to manage forcing profile completion for Google sign-in bypasses
 */
export function useCompleteProfile(user: any) {
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsReady(true);
      return;
    }

    const hasCompletedLocal = localStorage.getItem('profile_alias_configured') === 'true';

    // Detect system-generated 'Player1234' names OR completely empty names
    const isSystemGenerated =
      /^Player\d{4}$/.test(user.username || '') || !(user.username || '').trim();

    // Google logins initially have NO avatar_url
    const isMissingAvatar = !user.avatar_url;

    // Only show if it's a new or system-generated account that hasn't configured an alias yet
    if (isSystemGenerated || isMissingAvatar) {
      setShowProfileModal(true);
    } else {
      // Auto-flag as complete if they already have a custom name and avatar
      if (!hasCompletedLocal) {
        localStorage.setItem('profile_alias_configured', 'true');
      }
      setShowProfileModal(false);
    }

    setIsReady(true);
  }, [user?.username, user?.avatar_url]); // Re-evaluate when username or avatar changes

  const finishProfile = () => {
    localStorage.setItem('profile_alias_configured', 'true');
    setShowProfileModal(false);
  };

  return {
    showProfileModal,
    isReady,
    finishProfile,
  };
}
