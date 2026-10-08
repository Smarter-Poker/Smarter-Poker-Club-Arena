/**
 * LIGHTNING PHASE 8: YOUR LIGHTNING TABLES, ON THE LIGHTNING ENTRY.
 *
 * A player may hold Lightning in several Clusters at once, up to their
 * device's limit (desktop 4, tablet 3, phone 2 by default; the database
 * enforces the real number in the matcher). The entry lists the Clusters
 * they already play (fn_lightning_my_sessions), each with VIEW GAME, says
 * how many of the device's tables are in use, and offers the last Cluster
 * they played as a door back. Every door is a tap; joining another Cluster
 * goes through the Cluster's own entry and its buy-in confirmation.
 */
import { useEffect, useState } from 'react';
import {
  fetchLightningMySessions,
  type LightningMySessionRow,
} from '../../lightning/lightningSessionApi';
import { reportError } from '../../utils/errorReporter';
import './LightningSession.css';

export interface LightningMySessionsState {
  rows: LightningMySessionRow[] | null;
  failed: boolean;
}

export function useLightningMySessions(
  refreshKey: unknown = null,
  enabled = true
): LightningMySessionsState {
  const [state, setState] = useState<LightningMySessionsState>({ rows: null, failed: false });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchLightningMySessions()
      .then((rows) => {
        if (live) setState({ rows, failed: false });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({ rows: [], failed: true });
        reportError(err, 'LightningSession.my_sessions_read_failed');
      });
    return () => {
      live = false;
    };
  }, [refreshKey, enabled]);
  return state;
}

/**
 * Is another Cluster's JOIN LIGHTNING still within the device's limit?
 * The Cluster on screen does not count against itself.
 */
export function lightningJoinWithinLimit(
  rows: readonly LightningMySessionRow[] | null,
  clusterId: string,
  limit: number
): boolean {
  if (!rows) return true;
  return rows.filter((r) => r.clusterId !== clusterId).length < limit;
}

export default function LightningMySessions({
  rows,
  currentClusterId,
  limit,
  lastPlayed,
  onViewGame,
  onOpenCluster,
}: {
  rows: LightningMySessionRow[];
  currentClusterId: string;
  limit: number;
  lastPlayed: { clusterId: string; name: string | null; stakes: string | null } | null;
  onViewGame: (row: LightningMySessionRow) => void;
  onOpenCluster: (clusterId: string) => void;
}) {
  const others = rows.filter((r) => r.clusterId !== currentClusterId);
  const showLast =
    lastPlayed &&
    lastPlayed.clusterId !== currentClusterId &&
    !rows.some((r) => r.clusterId === lastPlayed.clusterId) &&
    rows.length < limit;
  if (others.length === 0 && !showLast) return null;
  return (
    <section
      className="lightning-mine"
      data-testid="lightning-my-sessions"
      aria-label="Your Lightning Tables"
    >
      <p className="lightning-mine__head">
        <span>Your Lightning Tables</span>
        <span className="lightning-mine__count" data-testid="lightning-table-count">
          {rows.length.toLocaleString()} Of {limit.toLocaleString()}
        </span>
      </p>
      {others.length > 0 ? (
        <ul className="lightning-mine__list">
          {others.map((r) => (
            <li key={r.poolSessionId} className="lightning-mine__row">
              <span className="lightning-mine__name">
                {r.name}
                {r.stakes ? <span className="lightning-mine__stakes"> {r.stakes}</span> : null}
              </span>
              <button
                type="button"
                className="lightning-mine__btn"
                data-testid="lightning-my-session-view"
                onClick={() => onViewGame(r)}
              >
                VIEW GAME
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {showLast && lastPlayed ? (
        <div
          className="lightning-mine__row lightning-mine__row--last"
          data-testid="lightning-last-played"
        >
          <span className="lightning-mine__name">
            Last Played: {lastPlayed.name ?? 'Lightning'}
            {lastPlayed.stakes ? (
              <span className="lightning-mine__stakes"> {lastPlayed.stakes}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="lightning-mine__btn"
            data-testid="lightning-last-played-open"
            onClick={() => onOpenCluster(lastPlayed.clusterId)}
          >
            JOIN LIGHTNING
          </button>
        </div>
      ) : null}
    </section>
  );
}
