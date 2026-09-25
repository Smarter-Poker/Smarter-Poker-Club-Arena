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
  /** The rake read FAILED. Not the same fact as an empty ledger. */
  rakeError: boolean;
  /** Re-runs the rake read. */
  onRetryRake: () => void;
  /** null while unknown: still loading, or unreadable (see agentRolesError). */
  agentRoles: AgentRoleRow[] | null;
  /** The agent-roles read FAILED. No role is inferred from it, and none denied. */
  agentRolesError: boolean;
  /** Re-runs the agent-roles read. */
  onRetryAgentRoles: () => void;
  isOwnProfile: boolean;
  panelResetKey: string;
}

/**
 * A FAILED READ SAYS SO (Stats contract truth, 2026-09-20).
 *
 * Both reads behind this tab used to collapse a failure into an empty answer,
 * and the tab then made a statement about the player's book on no evidence:
 * a rake read that could not reach the database rendered "Rake Ledger Empty",
 * and a roles read that failed removed an agent's Downline Rake section. The
 * empty state is now made only from reads that succeeded, and each failure
 * gets the page's own unavailable readout (the "Readout Unavailable" state
 * the page shows when the whole payload fails) with a Try Again that re-runs
 * exactly that read.
 */
export default function RakeTab({
  rakeLoading,
  rakeStats,
  rakeError,
  onRetryRake,
  agentRoles,
  agentRolesError,
  onRetryAgentRoles,
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

      {!rakeLoading && rakeError && (
        <div className="stats-empty-state" role="alert">
          <span className="empty-status">Readout Unavailable</span>
          <span className="empty-title">Couldn't Load Your Rake</span>
          <span className="empty-description">
            Your Rake Record Is Still There - We Just Could Not Reach It For This Analysis Window.
          </span>
          <button type="button" className="empty-cta" onClick={onRetryRake}>
            Try Again
          </button>
        </div>
      )}

      {/* "Empty" is a statement about the ledger, so it needs both reads to
          have succeeded: an unreadable rake figure is not zero rake, and an
          unreadable roles list is not "no downline". */}
      {!rakeLoading &&
        !rakeError &&
        !agentRolesError &&
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

      {/* The Downline Rake section stays on the tab when the roles read
          fails. Hiding it would tell a real agent their role is gone. */}
      {agentRolesError && (
        <div className="stats-empty-state" role="alert">
          <span className="empty-status">Readout Unavailable</span>
          <span className="empty-title">Couldn't Load Your Downline Rake</span>
          <span className="empty-description">
            Your Agent Roles Could Not Be Read Right Now, So Your Downline Cannot Be Shown.
          </span>
          <button type="button" className="empty-cta" onClick={onRetryAgentRoles}>
            Try Again
          </button>
        </div>
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
