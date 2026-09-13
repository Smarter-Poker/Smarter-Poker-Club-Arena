/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Complete Profile Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Forces users to configure their Poker Alias, Real Name, and Avatar
 * if they signed in via a provider (Google) that skipped the Hub signup form.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
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

      /* The result was discarded here until 2026-08-30. `setUserAvatar` REFUSES
         rather than throws (AvatarService's library-only guard returns false for
         anything that is not library art), so a refused write left this modal
         showing "Welcome!", closing, and then re-appearing on the next load with
         no explanation — the same gate, for the same reason, forever. If the
         avatar did not land, say so and stay open. */
      if (currentAvatar && currentAvatar !== user.avatar_url) {
        const avatarSaved = await avatarService.setUserAvatar(user.id, currentAvatar);
        if (!avatarSaved) {
          throw new Error('Could not save that avatar. Please choose another.');
        }
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
      {/*
       * THE GATE STANDS DOWN WHILE THE GALLERY IS UP.
       *
       * 2026-08-30: "Select Avatar" silently did nothing. Nothing was broken in
       * the gallery — it opened every time, and then painted UNDERNEATH this
       * modal. AvatarGallery portals to document.body at `z-index: 9999`; this
       * overlay is a sibling in the same root stacking context at `z-index:
       * 10000` with `rgba(0,0,0,0.85)` and an 8px backdrop blur over the whole
       * viewport. So the player got a dead button, a locked body scroll
       * (AvatarGallery sets `overflow: hidden`) and a focus trap inside a dialog
       * they could not see. That is the whole "Poker Arena is blocking play"
       * report.
       *
       * Raising the gallery instead would have been the wrong end: Toast sits at
       * 10000 deliberately so "Avatar Updated" lands ON TOP of the gallery, and
       * lifting the gallery past it would have traded a dead button for a
       * silent save. Only one of these two can be the front-most surface at a
       * time, so the one that is not being used steps off the screen.
       */}
      {!showAvatarGallery && (
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
                Welcome To Poker Arena! Before You Hit The Tables, Please Choose Your Poker Alias
                And Avatar.
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
                      placeholder="E.G. SharkPro99"
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
                  {aliasLocalError && (
                    <div className={styles.localErrorText}>{aliasLocalError}</div>
                  )}
                </div>

                <div className={styles.formGroup} style={{ marginTop: '0.5rem' }}>
                  <label>Real Name (Optional)</label>
                  <div className={styles.inputWrapper}>
                    <span className={styles.inputIcon}>◉</span>
                    <input
                      className={styles.input}
                      placeholder="E.G. John Doe"
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
      )}

      <AvatarGallery
        userId={user.id}
        currentAvatarUrl={currentAvatar || ''}
        /* 2026-09-05: this was `user.vip_level !== 'bronze'`. vip_level is
           profiles.tier, which is 'Newcomer' on every row, so the comparison
           was true for all 1,310 accounts and the VIP avatar collection was
           free to everyone. vip_status is the resolved membership. */
        isVip={user.vip_status === 'vip' || user.vip_status === 'lifetime'}
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE GATE ASKS THE DATABASE, NOT THE STORE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-30: established members with an alias AND an avatar were being stopped
 * at this modal. Nothing was wrong with their rows — danimal5022 has
 * `arena_avatar_url = /avatars/table/free_samurai@2x.webp` and always did. The
 * gate was reading the Zustand user, and FOUR separate paths seed that store
 * with a session STUB before the profile row arrives:
 *
 *   IdentityDNA.hydrateUserFromSession   username: email.split('@')[0]
 *   useAuthUser.rehydrate                avatar_url: metadata?.avatar_url ?? null
 *   AuthGuard.hydrateStoreFromSession    (same)
 *   AuthGuard.hydrateStoreFromLocalStorage  avatar_url: null, hard-coded
 *
 * Every one of them writes `avatar_url: null` for a player who has an avatar,
 * because the avatar lives in `profiles.arena_avatar_url` and a JWT does not
 * carry it. The gate read that null as "this player has never chosen an avatar"
 * and threw up a blocking modal — on every cold load, and again on every token
 * refresh, since `hydrateUserFromSession` runs on SIGNED_IN, TOKEN_REFRESHED and
 * USER_UPDATED alike. It cleared itself a moment later when the profile landed,
 * which is exactly why it read as "glitching": a hard gate flickering over a
 * player who had already passed it.
 *
 * So the decision is made from the one place that actually knows, and:
 *
 *   - A query that DID NOT ANSWER is not a missing profile. An error or a
 *     dropped connection leaves the gate DOWN and retries the same account on
 *     a bounded backoff, rather than locking a paid-up member out because the
 *     network hiccuped.
 *   - The check runs ONCE per account id, not once per store write. A token
 *     refresh must never re-litigate a gate the player already walked through.
 *   - `isReady` stays false until the answer is in, and AppLayout does not mount
 *     the modal until then, so there is no window in which it can flash.
 */
export function useCompleteProfile(user: any) {
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [decision, setDecision] = useState<{
    userId: string | null;
    status: 'pending' | 'complete' | 'incomplete' | 'unavailable';
  }>({ userId: null, status: 'pending' });
  /** Account id this hook has already decided for. Null means undecided. */
  const decidedForRef = useRef<string | null>(null);
  const retryAccountRef = useRef<string | null>(null);
  const retryAttemptRef = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);

  const userId: string | undefined = user?.id;

  useEffect(() => {
    if (!userId) {
      decidedForRef.current = null;
      retryAccountRef.current = null;
      retryAttemptRef.current = 0;
      setShowProfileModal(false);
      setDecision({ userId: null, status: 'complete' });
      setIsReady(true);
      return;
    }

    if (retryAccountRef.current !== userId) {
      retryAccountRef.current = userId;
      retryAttemptRef.current = 0;
    }

    if (decidedForRef.current === userId) return;
    decidedForRef.current = userId;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const retryOrSetUnavailable = (error?: unknown) => {
      if (error) reportError(error, 'useCompleteProfile.ProfileReadFailed');
      decidedForRef.current = null;
      setShowProfileModal(false);

      const delays = [1_000, 2_000, 4_000] as const;
      const attempt = retryAttemptRef.current;
      if (attempt < delays.length) {
        retryAttemptRef.current = attempt + 1;
        setDecision({ userId, status: 'pending' });
        setIsReady(false);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!cancelled) setRetryRevision((revision) => revision + 1);
        }, delays[attempt]);
        return;
      }

      setDecision({ userId, status: 'unavailable' });
      setIsReady(true);
    };

    (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('username, arena_avatar_url')
          .eq('id', userId)
          .maybeSingle();

        if (cancelled) return;

        if (error || !data) {
          /* Unanswered, not empty. Keep the gate down and retry this same
             account on a short bounded backoff. Waiting for an identity change
             did not actually retry for a stable signed-in user, so one failed
             profile read could leave every protected route indeterminate until
             a remount. */
          retryOrSetUnavailable(error || new Error('profile row was unavailable'));
          return;
        }

        const username = String(data.username || '').trim();
        const needsAlias = !username || /^Player\d{4}$/.test(username);
        const needsAvatar = !String(data.arena_avatar_url || '').trim();

        const incomplete = needsAlias || needsAvatar;
        retryAttemptRef.current = 0;
        setShowProfileModal(incomplete);
        setDecision({ userId, status: incomplete ? 'incomplete' : 'complete' });
        setIsReady(true);
      } catch (err) {
        if (cancelled) return;
        retryOrSetUnavailable(err);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [retryRevision, userId]);

  const finishProfile = useCallback(() => {
    setShowProfileModal(false);
    setDecision({ userId: userId ?? null, status: 'complete' });
  }, [userId]);

  const profileStatus = !userId
    ? 'complete'
    : decision.userId === userId
      ? decision.status
      : 'pending';

  return {
    showProfileModal,
    isReady,
    profileStatus,
    finishProfile,
  };
}
