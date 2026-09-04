/**
 * The Positions tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('positions')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { lazy } from 'react';
import PanelBoundary from '../../components/stats/PanelBoundary';
import type { FullStats, HandEvidenceFilter } from './types';

const PositionWinRates = lazy(() => import('../../components/stats/PositionWinRates'));
const PositionalRadar = lazy(() => import('../../components/stats/PositionalRadar'));

export interface PositionsTabProps {
  full: FullStats | null;
  panelResetKey: string;
  targetUserId: string | undefined;
  windowDays: number | null;
  openHandEvidence: (filter?: HandEvidenceFilter) => void;
}

export default function PositionsTab({
  full,
  panelResetKey,
  targetUserId,
  windowDays,
  openHandEvidence,
}: PositionsTabProps) {
  return (
    <div>
      <div className="stats-position-evidence" aria-label="Review Hands By Position">
        {(full?.positions || []).map((position) => (
          <button
            type="button"
            key={position.position}
            onClick={() => openHandEvidence({ position: position.position })}
          >
            {position.position} · {position.hands_played.toLocaleString()} Hands
          </button>
        ))}
      </div>
      {/* Positional shape first: a player reads the SHAPE of their game
          before they read any individual number, and a web that pinches
          at the button is a leak no table of rates makes obvious. Pure
          presentation over full.positions, which is already loaded. */}
      <PanelBoundary name="Positional Shape" resetKey={panelResetKey}>
        <PositionalRadar positions={full?.positions} />
      </PanelBoundary>
      <PanelBoundary name="Position Win Rates" resetKey={panelResetKey}>
        <PositionWinRates
          userId={targetUserId}
          initialPositions={full?.positions}
          days={windowDays}
        />
      </PanelBoundary>
    </div>
  );
}
