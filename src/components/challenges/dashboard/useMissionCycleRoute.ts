import { useCallback, useEffect, useState } from 'react';
import type { Location, NavigateFunction } from 'react-router-dom';
import type { ChallengeType, Tier } from '../../../services/DailyChallengeService';
import { getChallengeMissionAction } from '../../../utils/challengeMissionAction';
import { capture } from '../../../lib/analytics';
import { recordDailyMissionOperation } from '../../../services/DailyMissionTelemetryService';
import { withClubContext } from '../../../utils/clubScopedPath';
import { TIER_PRESENTATION, TIERS } from './missionPresentation';

/**
 * The active mission cycle as a bookmarkable route: the `/challenges/:cycle?`
 * parameter drives `activeTier`, the document title follows it, and every
 * tier or mission navigation keeps the club context, query and hash.
 */
export function useMissionCycleRoute({
  cycle,
  location,
  navigate,
  routeClubId,
  userId,
  setConfirmingRerollId,
}: {
  cycle: string | undefined;
  location: Location;
  navigate: NavigateFunction;
  routeClubId: string | null;
  userId: string | null;
  setConfirmingRerollId: (id: string | null) => void;
}) {
  const [activeTier, setActiveTier] = useState<Tier>(
    cycle === 'weekly' || cycle === 'monthly' ? cycle : 'daily'
  );

  useEffect(() => {
    document.title = `${TIER_PRESENTATION[activeTier].title} | Smarter Poker`;
  }, [activeTier]);

  // Each mission cycle is a real, bookmarkable subpage. Old or malformed
  // bookmarks fail safely to Daily instead of producing an empty dashboard.
  useEffect(() => {
    if (!cycle) {
      setActiveTier('daily');
      setConfirmingRerollId(null);
      return;
    }
    if (cycle === 'daily' || cycle === 'weekly' || cycle === 'monthly') {
      setActiveTier(cycle);
      setConfirmingRerollId(null);
      return;
    }
    navigate(withClubContext(`/challenges${location.search}${location.hash}`, routeClubId), {
      replace: true,
    });
  }, [cycle, location.hash, location.search, navigate, routeClubId, setConfirmingRerollId]);

  const openTier = useCallback(
    (tier: Tier) => {
      setActiveTier(tier);
      setConfirmingRerollId(null);
      navigate(
        withClubContext(`/challenges/${tier}${location.search}${location.hash}`, routeClubId)
      );
    },
    [location.hash, location.search, navigate, routeClubId, setConfirmingRerollId]
  );

  const handleTierKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tier: Tier) => {
      const index = TIERS.indexOf(tier);
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % TIERS.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TIERS.length) % TIERS.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = TIERS.length - 1;
      else return;

      event.preventDefault();
      const nextTier = TIERS[nextIndex];
      openTier(nextTier);
      requestAnimationFrame(() => document.getElementById(`mission-tab-${nextTier}`)?.focus());
    },
    [openTier]
  );

  const handleOpenMission = useCallback(
    (type: ChallengeType) => {
      const action = getChallengeMissionAction(type);
      capture('daily_mission_cta_clicked', { mission_type: type, destination: action.path });
      recordDailyMissionOperation({ userId, event: 'mission_cta_opened', tier: activeTier });
      navigate(withClubContext(action.path, routeClubId));
    },
    [activeTier, navigate, routeClubId, userId]
  );

  return { activeTier, openTier, handleTierKeyDown, handleOpenMission };
}
