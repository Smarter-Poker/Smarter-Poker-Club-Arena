/**
 * The profile gate's decision, kept apart from the modal it opens so the app
 * shell can make the decision at boot and load the modal (its SpadeConsole art
 * and the AvatarGallery) only for the player it actually stops. Re-exported
 * from CompleteProfileModal so existing imports keep working.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';

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
