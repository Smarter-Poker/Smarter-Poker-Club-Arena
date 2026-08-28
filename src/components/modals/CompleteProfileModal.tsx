/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Complete Profile Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Forces users to configure their Poker Alias, Real Name, and Avatar
 * if they signed in via a provider (Google) that skipped the Hub signup form.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { reportError } from '../../utils/errorReporter';
import styles from './CompleteProfileModal.module.css';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { AvatarGallery } from '../customization/AvatarGallery';
import { generateAvatarSvg } from '../../utils/avatarGenerator';
import { avatarService } from '../../services/AvatarService';

const ADJECTIVES = [
  'River',
  'AllIn',
  'Flop',
  'Turn',
  'Pocket',
  'Royal',
  'Flush',
  'Straight',
  'Lucky',
  'Iron',
  'Golden',
  'Silver',
  'Bronze',
  'Diamond',
  'Platinum',
  'Tilt',
  'Bluff',
  'Raise',
  'Call',
  'Fold',
  'Check',
  'Split',
  'Pot',
  'Blind',
  'Straddle',
  'Nit',
  'Aggro',
  'Loose',
  'Tight',
  'Crazy',
  'Wild',
  'Sneaky',
  'Silent',
  'Loud',
  'Fast',
  'Slow',
  'Hot',
  'Cold',
  'Big',
  'Small',
];

const NOUNS = [
  'Shark',
  'Pro',
  'Master',
  'Crusher',
  'Grinder',
  'Hero',
  'Ace',
  'King',
  'Queen',
  'Jack',
  'Joker',
  'Spade',
  'Heart',
  'Club',
  'Diamond',
  'Chip',
  'Stack',
  'Blind',
  'Dealer',
  'Player',
  'Roller',
  'Whale',
  'Fish',
  'Donk',
  'Legend',
  'Boss',
  'Champ',
  'Winner',
  'Runner',
  'Chaser',
  'Bluffer',
  'Caller',
];

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
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [aliasAvailable, setAliasAvailable] = useState<boolean | null>(null);
  const [aliasLocalError, setAliasLocalError] = useState<string | null>(null);
  const [isCheckingAlias, setIsCheckingAlias] = useState(false);

  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [generatedFallbackUrl, setGeneratedFallbackUrl] = useState<string | null>(null);

  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (user) {
        setAlias(user.username.startsWith('Player') ? '' : user.username);
        setRealName(user.display_name === 'New Player' ? '' : user.display_name || '');
        if (!user.avatar_url) {
          setGeneratedFallbackUrl(generateAvatarSvg(user.username || 'P', user.username || 'P'));
        }
      }
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
      setGeneratedFallbackUrl(null);
      setIsSuccess(false);
    }
  }, [isOpen, user]);

  // Real-time alias checking
  useEffect(() => {
    if (!isOpen || !alias.trim()) {
      setAliasAvailable(null);
      setIsCheckingAlias(false);
      setAliasLocalError(null);
      return;
    }

    const safeAlias = sanitizeInput(alias);
    if (!safeAlias || safeAlias === user?.username) {
      setAliasAvailable(safeAlias === user?.username ? true : null);
      setIsCheckingAlias(false);
      setAliasLocalError(null);
      return;
    }

    if (safeAlias.length < 3) {
      setAliasAvailable(false);
      setIsCheckingAlias(false);
      setAliasLocalError('Alias must be at least 3 characters.');
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(safeAlias)) {
      setAliasAvailable(false);
      setIsCheckingAlias(false);
      setAliasLocalError('Only letters, numbers, and underscores allowed.');
      return;
    }

    setAliasLocalError(null);

    if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);

    setIsCheckingAlias(true);
    setAliasAvailable(null);

    checkTimeoutRef.current = setTimeout(async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id')
          .ilike('username', safeAlias)
          .neq('id', user?.id)
          .maybeSingle();

        if (error) throw error;
        setAliasAvailable(!data);
      } catch (err) {
        console.error('Error checking alias:', err);
        setAliasAvailable(null); // Unknown state
      } finally {
        setIsCheckingAlias(false);
      }
    }, 400);

    return () => {
      if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);
    };
  }, [alias, isOpen, user?.username, user?.id]);

  if (!isOpen || !user) return null;

  const currentAvatar = user.avatar_url || generatedFallbackUrl;
  const hasAvatar = !!currentAvatar;

  const handleRandomize = () => {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(Math.random() * 99) + 1;
    setAlias(`${adj}${noun}${num}`);
  };

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

    if (aliasAvailable === false || aliasLocalError) {
      setError(aliasLocalError || 'This Poker Alias is already taken.');
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

      if (currentAvatar && currentAvatar !== user.avatar_url) {
        await avatarService.setUserAvatar(user.id, currentAvatar);
      }

      // 3. Update Local Store (Removed users table update to prevent silent RLS failures)
      setUser({
        ...user,
        username: safeAlias,
        display_name: safeRealName,
        avatar_url: currentAvatar,
      });

      setIsSuccess(true);
      setTimeout(() => {
        onComplete();
      }, 500);
    } catch (err: any) {
      reportError(err, 'CompleteProfileModal.SaveFailed');
      setError(safeErrorMessage(err, 'Failed to save profile. Try again.'));
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
                    <img src={currentAvatar!} alt="Your Avatar" className={styles.avatarImg} />
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
                  {user.avatar_url ? 'Change Avatar' : 'Select Avatar'}
                </button>
              </div>
            </div>

            <form id="complete-profile-form" onSubmit={handleSave} className={styles.formGroup}>
              <div className={styles.formGroup}>
                <div className={styles.labelRow}>
                  <label>Poker Alias (Required)</label>
                  <button type="button" className={styles.randomizeBtn} onClick={handleRandomize}>
                    ⚄ Randomize
                  </button>
                </div>
                <div
                  className={`${styles.inputWrapper} ${aliasAvailable === false ? styles.inputInvalid : ''} ${aliasAvailable === true ? styles.inputValid : ''}`}
                >
                  <span className={styles.inputIcon}>◆</span>
                  <input
                    className={styles.input}
                    placeholder="E.g. SharkPro99"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    minLength={3}
                    maxLength={16}
                    required
                  />
                  <div className={styles.availabilityIndicator}>
                    {isCheckingAlias && <span className={styles.spinner}>↻</span>}
                    {!isCheckingAlias && aliasAvailable === true && (
                      <span className={styles.iconAvailable}>✓</span>
                    )}
                    {!isCheckingAlias && aliasAvailable === false && !aliasLocalError && (
                      <span className={styles.iconTaken}>✗</span>
                    )}
                  </div>
                </div>
                {aliasLocalError && <div className={styles.localErrorText}>{aliasLocalError}</div>}
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
              className={`${styles.submitButton} ${isSuccess ? styles.submitSuccess : ''}`}
              disabled={
                isSaving || isSuccess || !alias.trim() || !hasAvatar || aliasAvailable === false
              }
            >
              {isSuccess ? '✓ Welcome!' : isSaving ? 'Saving...' : 'Enter Arena'}
            </button>
          </footer>
        </div>
      </div>

      <AvatarGallery
        userId={user.id}
        currentAvatarUrl={user.avatar_url || ''}
        isVip={user.vip_level !== 'bronze'}
        isOpen={showAvatarGallery}
        onClose={() => setShowAvatarGallery(false)}
        onAvatarChanged={(newUrl) => {
          setUser({ ...user, avatar_url: newUrl });
          setGeneratedFallbackUrl(null); // Clear fallback so they strictly use their chosen one
        }}
      />
    </>
  );
}

export function useCompleteProfile(user: any) {
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsReady(true);
      return;
    }

    const hasCompletedLocal = localStorage.getItem('profile_alias_configured') === 'true';

    const isSystemGenerated =
      /^Player\d{4}$/.test(user.username || '') || !(user.username || '').trim();
    const isMissingAvatar = !user.avatar_url;

    if (isSystemGenerated || isMissingAvatar) {
      setShowProfileModal(true);
    } else {
      if (!hasCompletedLocal) {
        localStorage.setItem('profile_alias_configured', 'true');
      }
      setShowProfileModal(false);
    }

    setIsReady(true);
  }, [user?.username, user?.avatar_url]);

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
