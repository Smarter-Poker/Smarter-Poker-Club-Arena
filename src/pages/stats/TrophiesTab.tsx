/**
 * The Trophies tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('trophies')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { lazy } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import type { FullStats } from './types';

const TrophyRoom = lazy(() => import('../../components/stats/TrophyRoom'));

export interface TrophiesTabProps {
  panelResetKey: string;
  allTimeStats: FullStats | null;
  allTimeError: boolean;
  setAllTimeReload: (fn: (n: number) => number) => void;
}

export default function TrophiesTab({
  panelResetKey,
  allTimeStats,
  allTimeError,
  setAllTimeReload,
}: TrophiesTabProps) {
  return (
    <div>
      <PanelBoundary name="Trophy Room" resetKey={panelResetKey}>
        {/* Trophies are LIFETIME achievements. They read the all-time
                payload, never the range-windowed one, so switching to
                "7 Days" cannot un-earn a 10,000-hand milestone. */}
        {allTimeStats ? (
          <TrophyRoom
            overall={allTimeStats.overall}
            tournaments={allTimeStats.tournaments}
            lifetimeHands={allTimeStats.lifetime.hands}
          />
        ) : allTimeError ? (
          <div className="hand-empty" role="alert">
            Your All-Time Stats Could Not Be Loaded For The Trophy Room.{' '}
            <button className="hand-retry" onClick={() => setAllTimeReload((n) => n + 1)}>
              Try Again
            </button>
          </div>
        ) : (
          <div className="hand-empty hand-loading">Loading Your All-Time Record...</div>
        )}
      </PanelBoundary>
    </div>
  );
}
