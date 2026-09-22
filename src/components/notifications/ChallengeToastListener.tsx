import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusBroadcastChannel } from '../../hooks/useMasterBusBroadcastChannel';
import { readClubContextParam, withClubContext } from '../../utils/clubScopedPath';
import { dailyMissionCompletionFromPayload } from '../../utils/dailyMissionCompletion';
import { useToast } from '../common/Toast';

export function ChallengeToastListener() {
  const { user } = useAuthUser();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = user?.id;
  const toastRef = useRef(toast);
  const processedRef = useRef<Set<string>>(new Set());
  /* The toast tells the player to open Daily Challenges, so a tap on it does.
     It stays up for seconds and can outlive the page it arrived on, so the
     club is read at the tap, from wherever the player is by then; a page that
     names no club opens plain /challenges. */
  const openDailyChallengesRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    openDailyChallengesRef.current = () =>
      navigate(withClubContext('/challenges', readClubContextParam(location.search)));
  }, [location.search, navigate]);

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
    const openDailyChallenges = () => openDailyChallengesRef.current();
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
