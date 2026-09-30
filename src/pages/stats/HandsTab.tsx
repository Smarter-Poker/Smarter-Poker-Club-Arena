/**
 * The Hands tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('hands')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { lazy } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import { CHIP_STATS, type StatsScope } from '../../services/statsScope';

const HoleCardHeatmap = lazy(() => import('../../components/stats/HoleCardHeatmap'));

export interface HandsTabProps {
  /** The asset the page reads: chips, or Diamonds in the Diamond Arena. */
  scope?: StatsScope;
  panelResetKey: string;
  targetUserId: string | undefined;
  windowDays: number | null;
}

export default function HandsTab({
  scope = CHIP_STATS,
  panelResetKey,
  targetUserId,
  windowDays,
}: HandsTabProps) {
  return (
    <div>
      <PanelBoundary name="Starting Hands" resetKey={panelResetKey}>
        <HoleCardHeatmap userId={targetUserId} days={windowDays} scope={scope} />
      </PanelBoundary>
    </div>
  );
}
