/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Complete Profile Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * Forces users to configure their Poker Alias, Real Name, and Avatar
 * if they signed in via a provider (Google) that skipped the Hub signup form.
 *
 * ── ON THE SPADE CONSOLE (#ClubArenaConsole) ────────────────────────────────
 * This was a rounded card with a gradient header bar, a 96px avatar disc with
 * a dashed ring and a "+" tile inside it, two bordered input wells each with a
 * lozenge glyph glued to the left, a spinner / tick / cross glyph column for
 * alias availability, a die glyph on the randomiser, a tinted info box and a
 * blue gradient ENTER button. Every one of those was CSS pretending to be a
 * control, and four of them were glyphs stuck on top of a frame.
 *
 * It is now Dan's approved spade master, cut into head / rails / foot by
 * SpadeConsole: COMPLETE YOUR PROFILE engraved in the header well, whether the
 * form is ready in the well's painted pill slot, the avatar printed plainly on
 * the black glass, both fields as grooves cut into that glass, availability
 * said in the master's own inks as a WORD rather than a glyph, and the two
 * actions on the painted plates in the foot - CHANGE AVATAR on steel, ENTER
 * ARENA on the blue glass.
 *
 * Nothing about the behaviour changed. The store hydration, the debounce and
 * its cleanup, the sanitiser, the 23505 duplicate branch, the avatar-refused
 * guard, the "gate stands down while the gallery is up" rule, and the whole of
 * useCompleteProfile below are the ones that were here.
 */

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './CompleteProfileModal.module.css';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { AvatarGallery } from '../customization/AvatarGallery';
import { generateAvatarSvg } from '../../utils/avatarGenerator';
import { avatarService } from '../../services/AvatarService';
import { escapeLikePattern, isOfferableAlias } from '../../utils/aliasRules';

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
  /** Synchronous twin of isSaving: a second submit in the same tick is refused. */
  const savingRef = useRef(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [aliasAvailable, setAliasAvailable] = useState<boolean | null>(null);
  const [aliasLocalError, setAliasLocalError] = useState<string | null>(null);
  const [isCheckingAlias, setIsCheckingAlias] = useState(false);

  const [showAvatarGallery, setShowAvatarGallery] = useState(false);
  const [generatedFallbackUrl, setGeneratedFallbackUrl] = useState<string | null>(null);

  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Fields the player has typed in. A store write never overwrites them. */
  const aliasTouchedRef = useRef(false);
  const realNameTouchedRef = useRef(false);

  /* THE FORM IS FILLED FROM THE STORE, NEVER OVER THE PLAYER (2026-10-17).
     This effect used to run on every change to the `user` OBJECT and rewrite
     both fields each time. Picking an avatar writes the store (onAvatarChanged
     below), so a player who typed an alias and then chose an avatar came back
     to find their alias replaced. A field the player has typed in is theirs;
     until then it follows the store, which is what lets the real profile row
     replace a session stub (`email.split('@')[0]`, useAuthUser) when it lands.
     A store username that is not a legal alias is not offered as one. */
  useEffect(() => {
    if (!isOpen || !user) return;
    if (!aliasTouchedRef.current) {
      const stored = String(user.username || '');
      setAlias(isOfferableAlias(stored) ? stored : '');
    }
    if (!realNameTouchedRef.current) {
      setRealName(user.display_name === 'New Player' ? '' : user.display_name || '');
    }
  }, [isOpen, user?.id, user?.username, user?.display_name]);

  useEffect(() => {
    if (isOpen) {
      if (user && !user.avatar_url) {
        setGeneratedFallbackUrl(generateAvatarSvg(user.username || 'P', user.username || 'P'));
      }
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
      setGeneratedFallbackUrl(null);
      setIsSuccess(false);
      aliasTouchedRef.current = false;
      realNameTouchedRef.current = false;
    }
  }, [isOpen, user?.id]);

  // Real-time alias checking
  useEffect(() => {
    if (!isOpen || !alias.trim()) {
      setAliasAvailable(null);
      setIsCheckingAlias(false);
      setAliasLocalError(null);
      return;
    }

    const safeAlias = sanitizeInput(alias);
    if (!safeAlias) {
      setAliasAvailable(null);
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

    // Their own current alias is theirs: nothing to ask the database.
    if (safeAlias === user?.username) {
      setAliasAvailable(true);
      setIsCheckingAlias(false);
      return;
    }

    if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);

    setIsCheckingAlias(true);
    setAliasAvailable(null);

    checkTimeoutRef.current = setTimeout(async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id')
          // `_` is a one-character wildcard to ILIKE: "Tom_Tamale" also
          // matched "TomXTamale" and read as Taken. Matched literally now.
          .ilike('username', escapeLikePattern(safeAlias))
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
    aliasTouchedRef.current = true;
    setAlias(`${adj}${noun}${num}`);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setError(null);

    if (!hasAvatar) {
      setError('Please select an Avatar.');
      savingRef.current = false;
      setIsSaving(false);
      return;
    }

    const safeAlias = sanitizeInput(alias);
    const safeRealName = sanitizeInput(realName) || safeAlias; // Fallback

    if (!safeAlias) {
      setError('Poker Alias is required.');
      savingRef.current = false;
      setIsSaving(false);
      return;
    }

    if (aliasAvailable === false || aliasLocalError) {
      setError(aliasLocalError || 'This Poker Alias is already taken.');
      savingRef.current = false;
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

      // The rows are written: the player is through. No pause on a
      // "Welcome" label first (Dan 2026-10-17: "THIS NEEDS TO UPDATE
      // INSTANTLY IN REAL TIME").
      setIsSuccess(true);
      onComplete();
    } catch (err: any) {
      reportError(err, 'CompleteProfileModal.SaveFailed');
      setError(safeErrorMessage(err, 'Failed to save profile. Try again.'));
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  /* Availability is said in the master's own inks as a WORD. The spinner, the
     tick and the cross were three glyphs stuck on top of the frame. */
  const aliasState = isCheckingAlias
    ? { text: 'Checking', ink: 'sc-ink--blue' }
    : aliasLocalError
      ? { text: 'Not Allowed', ink: 'sc-ink--red' }
      : aliasAvailable === true
        ? { text: 'Available', ink: 'sc-ink--green' }
        : aliasAvailable === false
          ? { text: 'Taken', ink: 'sc-ink--red' }
          : null;

  const canSubmit =
    !isSaving && !isSuccess && !!alias.trim() && hasAvatar && aliasAvailable !== false;

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
            role="dialog"
            aria-modal="true"
            aria-labelledby="complete-profile-title"
            style={{
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div className={styles.scroller}>
              <SpadeConsole
                as="div"
                className={styles.console}
                eyebrow="Poker Arena"
                title="Complete Your Profile"
                titleId="complete-profile-title"
                pill={canSubmit ? 'Ready' : 'Required'}
                pillInk={canSubmit ? 'green' : 'gold'}
                plates={{
                  secondary: {
                    label: user.avatar_url ? 'Change Avatar' : 'Select Avatar',
                    onClick: () => setShowAvatarGallery(true),
                  },
                  primary: {
                    label: isSuccess ? 'Welcome' : isSaving ? 'Saving' : 'Enter Arena',
                    ink: 'white',
                    type: 'submit',
                    form: 'complete-profile-form',
                    disabled: !canSubmit,
                  },
                }}
              >
                <p className={`sc-copy sc-copy--center ${styles.intro}`}>
                  Welcome To Poker Arena! Before You Hit The Tables, Please Choose Your Poker Alias
                  And Avatar.
                </p>

                {/* The avatar prints plainly on the glass: no disc, no ring,
                    no dashed placeholder tile. The one way to change it is the
                    plate painted into the foot. */}
                <div className={styles.avatarRow}>
                  {hasAvatar ? (
                    <img src={currentAvatar!} alt="Your Avatar" className={styles.avatarImg} />
                  ) : (
                    <span className={`sc-label sc-ink--gold ${styles.avatarMissing}`}>
                      No Avatar Chosen Yet
                    </span>
                  )}
                </div>

                <form id="complete-profile-form" onSubmit={handleSave} className={styles.form}>
                  <div className={styles.field}>
                    <div className={styles.fieldHead}>
                      <label htmlFor="complete-profile-alias" className="sc-label sc-ink--blue">
                        Poker Alias (Required)
                      </label>
                      <button
                        type="button"
                        className={`${styles.word} sc-ink--blue`}
                        onClick={handleRandomize}
                      >
                        Randomize
                      </button>
                    </div>
                    <input
                      id="complete-profile-alias"
                      className={styles.input}
                      placeholder="E.G. SharkPro99"
                      value={alias}
                      onChange={(e) => {
                        aliasTouchedRef.current = true;
                        setAlias(e.target.value);
                      }}
                      minLength={3}
                      maxLength={16}
                      required
                    />
                    <span className={`sc-label ${styles.fieldState}`} aria-live="polite">
                      {aliasState && <span className={aliasState.ink}>{aliasState.text}</span>}
                    </span>
                    {aliasLocalError && (
                      <p className={`sc-copy sc-ink--red ${styles.fieldError}`}>
                        {aliasLocalError}
                      </p>
                    )}
                  </div>

                  <div className={styles.field}>
                    <div className={styles.fieldHead}>
                      <label htmlFor="complete-profile-real-name" className="sc-label sc-ink--blue">
                        Real Name (Optional)
                      </label>
                    </div>
                    <input
                      id="complete-profile-real-name"
                      className={styles.input}
                      placeholder="E.G. John Doe"
                      value={realName}
                      onChange={(e) => {
                        realNameTouchedRef.current = true;
                        setRealName(e.target.value);
                      }}
                      maxLength={24}
                    />
                  </div>

                  {error && (
                    <p className={`sc-copy sc-ink--red ${styles.fieldError}`} role="alert">
                      {error}
                    </p>
                  )}

                  <p className={`sc-copy sc-copy--center sc-ink--muted ${styles.note}`}>
                    You Can Change These Later In Your Profile Settings.
                  </p>
                </form>
              </SpadeConsole>
            </div>
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

export { useCompleteProfile } from './useCompleteProfile';
