/**
 * LIGHTNING PHASE 8: the pool's health, in the board's four words.
 * BUILDING (still gathering), ACTIVE, HOT (plenty of players) and THIN (few
 * left, or on its way back to MUST MOVE). A word, not a meter: nothing here
 * animates, so nothing here can fail to play (CLAUDE.md 10.6).
 */
import type { LightningPoolStatus } from '../../lightning/lightningLobby';
import './LightningSession.css';

export default function LightningPoolBadge({
  status,
  players,
}: {
  status: LightningPoolStatus | null;
  players?: number | null;
}) {
  if (!status) return null;
  return (
    <span
      className={`lightning-pool-badge lightning-pool-badge--${status.toLowerCase()}`}
      data-testid="lightning-pool-badge"
      data-status={status}
      title="Lightning Pool"
    >
      {status}
      {typeof players === 'number' && players > 0 ? (
        <span className="lightning-pool-badge__count">{players.toLocaleString()}</span>
      ) : null}
    </span>
  );
}
