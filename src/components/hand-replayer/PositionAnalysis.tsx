/**
 * Position Analysis Component
 * Shows position-specific strategy advice with visual indicators
 */

import React, { useMemo } from 'react';
import { getPositionInfo, getPositionColor } from '../../utils/pokerOdds';
import './PositionAnalysis.css';

interface PositionAnalysisProps {
  position: string;
  totalSeats: number;
  seatIndex: number;
  dealerSeat: number;
}

export default function PositionAnalysis({
  position,
  totalSeats,
  seatIndex,
  dealerSeat,
}: PositionAnalysisProps) {
  const positionInfo = useMemo(() => getPositionInfo(position), [position]);
  const positionColor = useMemo(() => getPositionColor(positionInfo.tier), [positionInfo.tier]);

  const getTierLabel = (tier: string) => {
    switch (tier) {
      case 'utg':
        return 'Early Position';
      case 'mid':
        return 'Middle Position';
      case 'late':
        return 'Late Position';
      case 'blind':
        return 'Blind Position';
      default:
        return 'Position';
    }
  };

  // Generate seat map visualization
  const seatPositions = Array.from({ length: totalSeats }, (_, i) => {
    const isCurrentSeat = i === seatIndex;
    const isDealer = i === dealerSeat;
    return { index: i, isCurrentSeat, isDealer };
  });

  return (
    <div className="position-analysis">
      {/* Header with position badge */}
      <div className="position-header">
        <div className="position-badge" style={{ backgroundColor: positionColor }}>
          <span className="position-name">{position}</span>
        </div>
        <div className="position-tier">{getTierLabel(positionInfo.tier)}</div>
      </div>

      {/* Position display name */}
      <div className="position-full-name">{positionInfo.displayName}</div>

      {/* Strategy advice */}
      <div className="position-advice">
        <span className="advice-icon">◍</span>
        <p>{positionInfo.advice}</p>
      </div>

      {/* Seat map visualization */}
      <div className="seat-map">
        <h4 className="seat-map-title">Table Position</h4>
        <div className="seat-diagram">
          {seatPositions.map((seat) => (
            <div
              key={seat.index}
              className={`seat-indicator ${seat.isCurrentSeat ? 'active' : ''} ${
                seat.isDealer ? 'dealer' : ''
              }`}
              style={{
                backgroundColor: seat.isCurrentSeat ? positionColor : 'rgba(255, 255, 255, 0.1)',
              }}
              title={
                seat.isCurrentSeat
                  ? `You (${position})`
                  : seat.isDealer
                    ? 'Dealer Button'
                    : `Seat ${seat.index + 1}`
              }
            >
              {seat.isDealer && <span className="dealer-mark">D</span>}
              {seat.isCurrentSeat && <span className="active-mark">●</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Strategy metrics */}
      <div className="position-metrics">
        <div className="metric">
          <span className="metric-label">Hand Range</span>
          <span className="metric-value">{getHandRangePercent(positionInfo.tier)}%</span>
        </div>
        <div className="metric">
          <span className="metric-label">Aggression</span>
          <span className="metric-value">{getAggressionLevel(positionInfo.tier)}</span>
        </div>
      </div>
    </div>
  );
}

function getHandRangePercent(tier: string): string {
  switch (tier) {
    case 'utg':
      return '15-20';
    case 'mid':
      return '25-35';
    case 'late':
      return '50-70';
    case 'blind':
      return '40-60';
    default:
      return '30';
  }
}

function getAggressionLevel(tier: string): string {
  switch (tier) {
    case 'utg':
      return 'Conservative';
    case 'mid':
      return 'Moderate';
    case 'late':
      return 'Aggressive';
    case 'blind':
      return 'Reactive';
    default:
      return 'Balanced';
  }
}
