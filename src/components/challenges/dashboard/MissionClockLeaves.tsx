import { useMemo } from 'react';
import styles from '../../../pages/DailyChallengesPage.module.css';
import { useChallengeClockNow } from '../../../hooks/useChallengeClock';
import type { Tier } from '../../../services/DailyChallengeService';
import {
  formatChallengeCountdown,
  getChallengeResetAt,
  msUntilChallengeReset,
} from '../../../utils/challengeReset';
import { MISSION_RESET_FORMATTER, TIER_LABELS } from './missionPresentation';

/** Countdown leaf: its 1 Hz clock never enters DailyChallengesPage state. */
export function MissionCycleCountdown({
  tier,
  serverClockOffsetMs,
}: {
  tier: Tier;
  serverClockOffsetMs: number | null;
}) {
  const clientNow = useChallengeClockNow();
  if (serverClockOffsetMs === null) return <>Synchronizing</>;
  const serverNow = clientNow + serverClockOffsetMs;
  return <>{formatChallengeCountdown(msUntilChallengeReset(tier, serverNow))}</>;
}

/** The only reset panel subtree that re-renders as the wall clock advances. */
export function MissionResetReadout({
  tier,
  isRefreshing,
  activeUnclaimed,
  serverClockOffsetMs,
}: {
  tier: Tier;
  isRefreshing: boolean;
  activeUnclaimed: number;
  serverClockOffsetMs: number | null;
}) {
  const clientNow = useChallengeClockNow();
  const serverNow = serverClockOffsetMs === null ? null : clientNow + serverClockOffsetMs;
  const resetMs = serverNow === null ? null : msUntilChallengeReset(tier, serverNow);
  const urgent = resetMs !== null && resetMs <= 60 * 60 * 1000;
  const resetLabel = useMemo(
    () =>
      serverNow === null
        ? 'Server Time Pending'
        : MISSION_RESET_FORMATTER.format(getChallengeResetAt(tier, serverNow)),
    [tier, serverNow]
  );

  return (
    <div className={`${styles.resetReadout} ${urgent ? styles.resetUrgent : ''}`}>
      <span>{isRefreshing ? 'Refreshing Challenge Ledger' : `${TIER_LABELS[tier]} Reset`}</span>
      <strong>{resetMs === null ? 'Synchronizing' : formatChallengeCountdown(resetMs)}</strong>
      <small>{resetLabel}</small>
      {urgent && activeUnclaimed > 0 && (
        <em>
          Claim {activeUnclaimed} Ready Reward{activeUnclaimed === 1 ? '' : 's'} Before Reset
        </em>
      )}
    </div>
  );
}
