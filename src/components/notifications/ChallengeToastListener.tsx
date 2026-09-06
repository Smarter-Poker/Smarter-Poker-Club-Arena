import { useCallback, useEffect, useRef } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusBroadcastChannel } from '../../hooks/useMasterBusBroadcastChannel';
import { dailyMissionCompletionFromPayload } from '../../utils/dailyMissionCompletion';
import { useToast } from '../common/Toast';

export function ChallengeToastListener() {
  const { user } = useAuthUser();
  const toast = useToast();
  const userId = user?.id;
  const toastRef = useRef(toast);
  const processedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

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
    toastRef.current.success(`Challenge Complete: ${completion.name}.${rewardCopy}`);
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
