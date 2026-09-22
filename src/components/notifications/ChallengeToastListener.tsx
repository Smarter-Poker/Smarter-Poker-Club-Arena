import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusBroadcastChannel } from '../../hooks/useMasterBusBroadcastChannel';
import { readClubContextParam, withClubContext } from '../../utils/clubScopedPath';
import { dailyMissionCompletionFromPayload } from '../../utils/dailyMissionCompletion';
import { clubIdFromPath } from '../club/clubIdFromPath';
import { useToast } from '../common/Toast';

/** A live table owns the whole screen, and every tap on it. */
const AT_LIVE_TABLE = /^\/table(?:\/|$)/;

export function ChallengeToastListener() {
  const { user } = useAuthUser();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = user?.id;
  const toastRef = useRef(toast);
  const processedRef = useRef<Set<string>>(new Set());
  /* The toast tells the player to open Daily Challenges, so a tap on it does,
     except at a live table. A mission completes the moment a hand ends, the
     phone toast is a full-width bar over the action buttons, and a tap meant
     for the next decision must never carry the player off the felt, so there
     the toast only informs. It stays up for seconds and can outlive the page
     it arrived on, so where the player stands is read again at the tap. The
     club comes from the path a club page carries (/clubs/:club/...) or the
     ?club= a club-scoped global page carries; a page that names no club
     opens plain /challenges. */
  const openDailyChallengesRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    openDailyChallengesRef.current = AT_LIVE_TABLE.test(location.pathname)
      ? null
      : () =>
          navigate(
            withClubContext(
              '/challenges',
              clubIdFromPath(location.pathname) ?? readClubContextParam(location.search)
            )
          );
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    processedRef.current.clear();
  }, [userId]);

  const handleCompletion = useCallback((payload: unknown) => {
    const completion = dailyMissionCompletionFromPayload(payload);
    if (!completion || processedRef.current.has(completion.id)) return;
    processedRef.current.add(completion.id);

    const rewardCopy =
      completion.diamondReward > 0
        ? ` Claim ${completion.diamondReward.toLocaleString()} Diamonds In Daily Challenges.`
        : ' Open Daily Challenges To Claim Your Reward.';
    const openDailyChallenges = openDailyChallengesRef.current
      ? () => openDailyChallengesRef.current?.()
      : undefined;
    toastRef.current.success(
      `Challenge Complete: ${completion.name}.${rewardCopy}`,
      undefined,
      openDailyChallenges
    );
  }, []);

  useMasterBusBroadcastChannel({
    channelName: userId ? `daily-mission-completion:${userId}` : null,
    event: 'daily_mission_completed',
    enabled: !!userId,
    private: true,
    onPayload: handleCompletion,
  });

  return null;
}
