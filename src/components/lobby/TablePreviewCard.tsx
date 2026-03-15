/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE PREVIEW CARD — Rich lobby table card with mini-table visualization
 * ═══════════════════════════════════════════════════════════════════════════════
 * Replaces flat text-list table entries with visual cards showing:
 * - Mini felt oval with seated player avatar circles
 * - Active pot / stakes label / game type icon
 * - Player count progress ring
 */

import './TablePreviewCard.css';

interface SeatedPlayer {
  id: string;
  username: string;
  avatarUrl?: string;
}

interface TablePreviewCardProps {
  tableId: string;
  name: string;
  gameType: 'NLH' | 'PLO' | 'OFC' | 'MTT' | 'SNG';
  stakes: string;
  seatedPlayers: SeatedPlayer[];
  maxSeats: number;
  activePot?: number;
  isRunning?: boolean;
  onClick?: () => void;
}

const GAME_ICONS: Record<string, string> = {
  NLH: '♠',
  PLO: '🎴',
  OFC: '🀄',
  MTT: '🏆',
  SNG: '⚡',
};

// Generate seat positions around an oval for max seats
const getSeatPositions = (maxSeats: number): Array<{ x: number; y: number }> => {
  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < maxSeats; i++) {
    // Distribute evenly around an ellipse
    const angle = (2 * Math.PI * i) / maxSeats - Math.PI / 2;
    const rx = 38; // horizontal radius %
    const ry = 32; // vertical radius %
    positions.push({
      x: 50 + rx * Math.cos(angle),
      y: 50 + ry * Math.sin(angle),
    });
  }
  return positions;
};

export default function TablePreviewCard({
  tableId,
  name,
  gameType,
  stakes,
  seatedPlayers,
  maxSeats,
  activePot = 0,
  isRunning = false,
  onClick,
}: TablePreviewCardProps) {
  const seatPositions = getSeatPositions(maxSeats);
  const occupancy = seatedPlayers.length / maxSeats;
  const icon = GAME_ICONS[gameType] || '♠';

  return (
    <div
      className={`table-preview-card ${isRunning ? 'active' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      {/* Mini Table Visualization */}
      <div className="tp-felt">
        {/* The felt oval */}
        <div className="tp-oval">
          {/* Center info */}
          <div className="tp-center-info">
            <span className="tp-pot">{activePot > 0 ? activePot.toLocaleString() : '—'}</span>
          </div>
        </div>

        {/* Seat positions */}
        {seatPositions.map((pos, i) => {
          const player = seatedPlayers[i];
          return (
            <div
              key={i}
              className={`tp-seat ${player ? 'occupied' : 'empty'}`}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            >
              {player ? (
                player.avatarUrl ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={player.avatarUrl}
                    alt={player.username}
                    className="tp-avatar"
                  />
                ) : (
                  <div className="tp-avatar-fallback">
                    {player.username.charAt(0).toUpperCase()}
                  </div>
                )
              ) : (
                <div className="tp-empty-seat" />
              )}
            </div>
          );
        })}

        {/* Running indicator */}
        {isRunning && <div className="tp-running-dot" />}
      </div>

      {/* Card Info */}
      <div className="tp-info">
        <div className="tp-header-row">
          <span className="tp-game-icon">{icon}</span>
          <span className="tp-name">{name}</span>
        </div>
        <div className="tp-meta-row">
          <span className="tp-stakes">{stakes}</span>
          <span className="tp-occupancy">
            <span className="tp-occ-fill" style={{ width: `${occupancy * 100}%` }} />
            <span className="tp-occ-text">
              {seatedPlayers.length}/{maxSeats}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
