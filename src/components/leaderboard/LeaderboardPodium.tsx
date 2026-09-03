/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD PODIUM — Visual top-3 celebration display
 * ═══════════════════════════════════════════════════════════════════════════════
 * Renders top 3 players as a visual podium with gold/silver/bronze trophies,
 * enlarged avatars, and smooth rank-change animations.
 */

import './LeaderboardPodium.css';

interface PodiumPlayer {
  id: string;
  username: string;
  avatarUrl?: string;
  score: number;
  rank: number;
  /** Optional delta from previous rank (positive = climbed, negative = dropped) */
  rankDelta?: number;
}

interface LeaderboardPodiumProps {
  players: PodiumPlayer[];
  metricLabel?: string;
}

const TROPHY_ICONS = ['★', '☆', '✧'];
const PODIUM_COLORS = [
  { gradient: 'linear-gradient(180deg, #FFD700 0%, #B8860B 100%)', glow: 'rgba(255, 215, 0, 0.3)' },
  {
    gradient: 'linear-gradient(180deg, #C0C0C0 0%, #808080 100%)',
    glow: 'rgba(192, 192, 192, 0.2)',
  },
  {
    gradient: 'linear-gradient(180deg, #CD7F32 0%, #8B4513 100%)',
    glow: 'rgba(205, 127, 50, 0.2)',
  },
];

export default function LeaderboardPodium({
  players,
  metricLabel = 'Score',
}: LeaderboardPodiumProps) {
  if (players.length < 3) return null;

  // Order: 2nd, 1st, 3rd for visual podium layout
  const ordered = [players[1], players[0], players[2]];
  const heights = ['100px', '130px', '80px'];

  return (
    <div className="lb-podium">
      {ordered.map((player, i) => {
        const actualRank = i === 1 ? 0 : i === 0 ? 1 : 2;
        const colors = PODIUM_COLORS[actualRank];
        const trophy = TROPHY_ICONS[actualRank];

        return (
          <div key={player.id} className={`podium-slot rank-${actualRank + 1}`}>
            {/* Avatar */}
            <div className="podium-avatar-ring" style={{ boxShadow: `0 0 16px ${colors.glow}` }}>
              {player.avatarUrl ? (
                <img
                  loading="lazy"
                  decoding="async"
                  src={player.avatarUrl}
                  alt={player.username}
                  className="podium-avatar"
                />
              ) : (
                <div className="podium-avatar-fallback">
                  {player.username.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="podium-trophy">{trophy}</span>
            </div>

            {/* Name */}
            <span className="podium-name">{player.username}</span>

            {/* Score */}
            <span className="podium-score">
              {player.score.toLocaleString()} {metricLabel}
            </span>

            {/* Rank delta */}
            {player.rankDelta !== undefined && player.rankDelta !== 0 && (
              <span className={`podium-delta ${player.rankDelta > 0 ? 'up' : 'down'}`}>
                {player.rankDelta > 0 ? `▲${player.rankDelta}` : `▼${Math.abs(player.rankDelta)}`}
              </span>
            )}

            {/* Podium pillar */}
            <div
              className="podium-pillar"
              style={{
                height: heights[i],
                background: colors.gradient,
              }}
            >
              <span className="pillar-rank">#{actualRank + 1}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
