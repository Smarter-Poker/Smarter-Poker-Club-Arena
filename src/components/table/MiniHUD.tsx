/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Smart Mini-HUD (Pro Upgrade)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ClubGG/premium-style opponent statistics overlay with:
 * - VPIP/PFR progress bars with color coding
 * - Player type label (Nit, TAG, LAG, Whale, etc.)
 * - Heat indicator with animated glow
 * - Compact and full display modes
 */

import { memo, useMemo } from 'react';
import '../../styles/table-design-tokens.css';
import './MiniHUD.css';

export interface MiniHUDStats {
  handsPlayed: number;
  vpipCount: number; // Voluntarily Put In Pot
  pfrCount: number; // Pre-Flop Raise
  threeBetCount: number; // 3-bet frequency
  cBetCount: number; // Continuation bet
  wtsdCount: number; // Went To ShowDown
  wonCount: number; // Hands won
  totalBuyIn: number; // Total bought in
  totalCashOut: number; // Total cashed out
}

export interface MiniHUDProps {
  stats: MiniHUDStats | null;
  isVisible: boolean;
  compact?: boolean; // Ultra-compact mode for small screens
}

/** Player archetype based on VPIP + PFR */
type PlayerType = 'Nit' | 'TAG' | 'LAG' | 'Whale' | 'Rock' | 'Maniac' | 'Fish' | 'Reg';

function classifyPlayer(vpip: number, pfr: number): PlayerType {
  const aggFactor = vpip > 0 ? pfr / vpip : 0;

  if (vpip < 15 && pfr < 10) return 'Nit';
  if (vpip < 15) return 'Rock';
  if (vpip < 24 && pfr >= 16 && aggFactor > 0.6) return 'TAG';
  if (vpip < 28 && pfr >= 12) return 'Reg';
  if (vpip >= 40 && pfr >= 25) return 'Maniac';
  if (vpip >= 35 && pfr >= 20) return 'LAG';
  if (vpip >= 40 && pfr < 15) return 'Whale';
  if (vpip >= 30 && pfr < 15) return 'Fish';
  return 'Reg';
}

function getTypeColor(type: PlayerType): string {
  switch (type) {
    case 'Nit':
      return '#60a5fa'; // Blue - very tight
    case 'Rock':
      return '#93c5fd'; // Light blue
    case 'TAG':
      return '#3fb950'; // Green - solid
    case 'Reg':
      return '#4dc660'; // Light green
    case 'LAG':
      return '#f59e0b'; // Amber - aggressive
    case 'Maniac':
      return '#ef4444'; // Red - very aggressive
    case 'Fish':
      return '#fb923c'; // Orange - loose passive
    case 'Whale':
      return '#f87171'; // Light red - loose passive
  }
}

/** Heat index: 0-3 (ice, cool, warm, hot) based on VPIP */
function getHeatLevel(vpip: number): 0 | 1 | 2 | 3 {
  if (vpip < 18) return 0; // Tight/ice
  if (vpip < 28) return 1; // Normal/cool
  if (vpip < 40) return 2; // Loose/warm
  return 3; // Very loose/hot
}

function getHeatColor(level: 0 | 1 | 2 | 3): string {
  switch (level) {
    case 0:
      return '#3b82f6'; // Blue - tight
    case 1:
      return '#3fb950'; // Green - normal
    case 2:
      return '#f59e0b'; // Amber - loose
    case 3:
      return '#ef4444'; // Red - very loose
  }
}

const MiniHUD = memo(
  function MiniHUD({ stats, isVisible, compact = false }: MiniHUDProps) {
    const computed = useMemo(() => {
      if (!stats || stats.handsPlayed < 5) return null;

      const vpip = Math.round((stats.vpipCount / stats.handsPlayed) * 100);
      const pfr = Math.round((stats.pfrCount / stats.handsPlayed) * 100);
      const heat = getHeatLevel(vpip);
      const type = classifyPlayer(vpip, pfr);
      /* `winRate` deleted 2026-08-25: computed here on every stats change and
         read by nothing in the render below. The memo's own comparator does
         watch `wonCount`, so it was also re-running this whole block for a
         number that never reached the screen. Hands won is shown on the stats
         card, not on the per-seat HUD, which has room for two figures. */

      return { vpip, pfr, heat, hands: stats.handsPlayed, type };
    }, [stats]);

    if (!isVisible || !computed) return null;

    const heatColor = getHeatColor(computed.heat);
    const typeColor = getTypeColor(computed.type);

    // VPIP bar width (clamped 0-100, scaled so 50% VPIP fills the bar)
    const vpipWidth = Math.min(100, (computed.vpip / 60) * 100);
    const pfrWidth = Math.min(100, (computed.pfr / 40) * 100);

    // Color-code VPIP/PFR values: <20% = tight (blue), 20-40% = normal (green), >40% = loose (orange), >60% = whale (red)
    const getVpipColor = (vpip: number) => {
      if (vpip < 20) return '#3b82f6'; // Blue - tight
      if (vpip < 40) return '#3fb950'; // Green - normal
      if (vpip < 60) return '#f59e0b'; // Orange - loose
      return '#ef4444'; // Red - whale
    };

    const vpipColor = getVpipColor(computed.vpip);

    return (
      <div
        className={`mini-hud ${compact ? 'mini-hud--compact' : ''} mini-hud--heat-${computed.heat} mini-hud--glass`}
        title={`${computed.type} - VPIP: Voluntarily Put In Pot (Hands You Play) | PFR: Pre-Flop Raise (Aggressive Plays)`}
      >
        {/* Player Type Label */}
        <span className="mini-hud__type" style={{ color: typeColor }}>
          {computed.type}
        </span>

        {/* VPIP / PFR with micro progress bars & color-coding */}
        <div className="mini-hud__stats" title="Player Statistics">
          <div
            className="mini-hud__stat-row"
            title="Voluntarily Put In Pot - How Often Player Enters Pot"
          >
            <span className="mini-hud__label">V</span>
            <div className="mini-hud__bar">
              <div
                className="mini-hud__bar-fill mini-hud__bar-fill--vpip"
                style={{ width: `${vpipWidth}%`, backgroundColor: vpipColor }}
              />
            </div>
            <span className="mini-hud__value" style={{ color: vpipColor }}>
              {computed.vpip}
            </span>
          </div>
          <div
            className="mini-hud__stat-row"
            title="Pre-Flop Raise - How Often Player Raises Pre-Flop"
          >
            <span className="mini-hud__label">P</span>
            <div className="mini-hud__bar">
              <div
                className="mini-hud__bar-fill mini-hud__bar-fill--pfr"
                style={{ width: `${pfrWidth}%` }}
              />
            </div>
            <span className="mini-hud__value">{computed.pfr}</span>
          </div>
        </div>

        {/* Heat dot */}
        <span
          className="mini-hud__heat"
          style={{ backgroundColor: heatColor, boxShadow: `0 0 6px ${heatColor}` }}
        />

        {!compact && (
          <span className="mini-hud__hands" title="Hands Observed">
            {computed.hands < 100 ? computed.hands : '99+'}
          </span>
        )}
      </div>
    );
  },
  (prev, next) => {
    if (prev.isVisible !== next.isVisible) return false;
    if (prev.compact !== next.compact) return false;
    if (!prev.stats && !next.stats) return true;
    if (!prev.stats || !next.stats) return false;
    return (
      prev.stats.handsPlayed === next.stats.handsPlayed &&
      prev.stats.vpipCount === next.stats.vpipCount &&
      prev.stats.pfrCount === next.stats.pfrCount &&
      prev.stats.wonCount === next.stats.wonCount
    );
  }
);

export default MiniHUD;
