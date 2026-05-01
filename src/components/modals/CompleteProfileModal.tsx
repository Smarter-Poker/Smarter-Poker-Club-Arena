/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Complete Profile Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Forces users to configure their Poker Alias (and optionally Real Name)
 * if they signed in via a provider (Google) that skipped the Hub signup form.
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { reportError } from '../../utils/errorReporter';
import { STORAGE_KEYS } from '../../lib/storage';
import styles from './CompleteProfileModal.module.css';

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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

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
      setError(err.message || 'Failed to save profile. Try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
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
            Welcome to Club Arena! Before you hit the tables, please choose your Poker Alias. This
            is how other players will identify you.
          </p>

          <form id="complete-profile-form" onSubmit={handleSave} className={styles.formGroup}>
            <div className={styles.formGroup}>
              <label>Poker Alias (Required)</label>
              <div className={styles.inputWrapper}>
                <span className={styles.inputIcon}>🎭</span>
                <input
                  className={styles.input}
                  placeholder="e.g. SharkPro99"
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
                <span className={styles.inputIcon}>👤</span>
                <input
                  className={styles.input}
                  placeholder="e.g. John Doe"
                  value={realName}
                  onChange={(e) => setRealName(e.target.value)}
                  maxLength={24}
                />
              </div>
            </div>

            {error && <div className={styles.errorText}>{error}</div>}

            <div className={styles.infoBox}>
              <p>You can change these later in your Profile settings.</p>
            </div>
          </form>
        </div>

        <footer className={styles.footer}>
          <button
            type="submit"
            form="complete-profile-form"
            className={styles.submitButton}
            disabled={isSaving || !alias.trim()}
          >
            {isSaving ? 'Saving...' : 'Enter Arena'}
          </button>

          <button
            type="button"
            className={styles.cancelButton}
            onClick={() => {
              // If they explicitly choose to keep the auto-generated name, let them bypass
              onComplete();
            }}
          >
            Keep System Generated Name ({user.username})
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Hook to manage forcing profile completion for Google sign-in bypasses
 */
export function useCompleteProfile(user: any) {
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!user || !user.username) {
      setIsReady(true);
      return;
    }

    const hasCompleted = localStorage.getItem(STORAGE_KEYS.WELCOME_ACCEPTED)
      ? localStorage.getItem('profile_alias_configured') === 'true'
      : false;

    // Detect system-generated 'Player1234' names
    const isSystemGenerated = /^Player\d{4}$/.test(user.username);

    // Only show if it's a new or system-generated account that hasn't configured an alias yet
    if (isSystemGenerated && !hasCompleted) {
      setShowProfileModal(true);
    } else {
      // Auto-flag as complete if they already have a custom name
      if (!isSystemGenerated && !hasCompleted) {
        localStorage.setItem('profile_alias_configured', 'true');
      }
    }

    setIsReady(true);
  }, [user]);

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
