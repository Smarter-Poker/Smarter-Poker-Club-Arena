import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mayLeaveCurrentPage } from '../../lib/navigationGuard';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusBroadcastChannel } from '../../hooks/useMasterBusBroadcastChannel';
import { readClubContextParam, withClubContext } from '../../utils/clubScopedPath';
import { dailyMissionCompletionFromPayload } from '../../utils/dailyMissionCompletion';
import { clubIdFromPath } from '../club/clubIdFromPath';
import { useToast } from '../common/Toast';

export function ChallengeToastListener() {
  const { user } = useAuthUser();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = user?.id;
  const toastRef = useRef(toast);
  const processedRef = useRef<Set<string>>(new Set());
  // Navigation is always an explicit tap, including while a table is open.
  const openDailyChallengesRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    openDailyChallengesRef.current = () => {
      if (!mayLeaveCurrentPage()) return;
      navigate(
        withClubContext(
          '/challenges',
          clubIdFromPath(location.pathname) ?? readClubContextParam(location.search)
        )
      );
    };
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
