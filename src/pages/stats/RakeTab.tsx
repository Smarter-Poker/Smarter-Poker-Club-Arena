/**
 * The Rake tab of the Player Stats page (Stats Page Programme phase 2).
 *
 * One lazy chunk per tab. The page keeps the data, the range, the realtime
 * subscription and the header; this file is the markup that used to sit
 * inline in PlayerStatsPage.tsx under `showTab('rake')`, moved verbatim so
 * that a visitor to the default tab downloads only the default tab. The
 * conditions that gate the tab (`showTab`, `hasData`, `isOwnProfile`) stay in
 * the page, where `printing` can override them for the dossier.
 */
import { Suspense, lazy } from 'react';
import type { AgentRoleRow } from '../../services/AgentRakeService';
import type { PlayerRakeStats } from '../../services/StatsFactsService';
import PanelBoundary from '../../components/stats/PanelBoundary';
import { StatRow } from './StatRow';

const DownlineRakePanel = lazy(() => import('../../components/agent/DownlineRakePanel'));

export interface RakeTabProps {
  rakeLoading: boolean;
  rakeStats: PlayerRakeStats | null;
  agentRoles: AgentRoleRow[] | null;
  isOwnProfile: boolean;
  panelResetKey: string;
}

export default function RakeTab({
  rakeLoading,
  rakeStats,
  agentRoles,
  isOwnProfile,
  panelResetKey,
}: RakeTabProps) {
  return (
    <>
      {rakeLoading && (
        <div className="stats-section-loading" role="status">
          Loading Rake For This Analysis Window...
        </div>
      )}

      {!rakeLoading &&
        agentRoles !== null &&
        (!rakeStats || rakeStats.hands === 0) &&
        agentRoles.length === 0 && (
          <div className="stats-empty-state" role="status">
            <span className="empty-status">Rake Ledger Empty</span>
            <span className="empty-title">No Rake In This Window</span>
            <span className="empty-description">
              Player-Attributed Rake Will Appear Here After A Raked Cash Hand Is Recorded.
            </span>
          </div>
        )}

      {/* Live downline earnings, agents only */}
      {isOwnProfile && rakeStats && rakeStats.hands > 0 && (
        <PanelBoundary name="Your Rake" resetKey={panelResetKey}>
          <div className="stats-grid">
            <StatRow
              label="Rake Paid"
              value={rakeStats.rake_paid.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              color="#f59e0b"
              highlight
            />
            <StatRow
              label="Rake Per 100 Hands"
              value={rakeStats.rake_per_100.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              color="#00d4ff"
            />
            <StatRow
              label="Rake In Big Blinds"
              value={rakeStats.rake_in_bb.toFixed(2)}
              color="#8b5cf6"
            />
            <StatRow
              label="Raked Hands"
              value={rakeStats.raked_hands.toLocaleString()}
              color="#22c55e"
            />
            <StatRow
              label="Average Per Raked Hand"
              value={rakeStats.avg_rake_per_raked_hand.toFixed(4)}
              color="#06b6d4"
            />
            <StatRow
              label="Cash Hands Counted"
              value={rakeStats.hands.toLocaleString()}
              color="#4169E1"
            />
          </div>
        </PanelBoundary>
      )}

      {agentRoles && agentRoles.length > 0 && (
        <PanelBoundary name="Downline Rake" resetKey={panelResetKey}>
          <Suspense
            fallback={<div className="stats-section-loading">Loading Downline Rake...</div>}
          >
            <DownlineRakePanel roles={agentRoles} />
          </Suspense>
        </PanelBoundary>
      )}
    </>
  );
}
