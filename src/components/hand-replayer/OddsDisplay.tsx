/**
 * Odds Display Component
 * Shows hand equity, outs, pot odds, and drawing recommendations
 */

import React, { useMemo } from 'react';
import { countOuts, calculateEquity, classifyDrawType } from '../../utils/pokerOdds';
import { CardImage } from '../table/CardImage';
import type { Card } from '../table/CardImage';
import './OddsDisplay.css';

interface OddsDisplayProps {
  holeCards: string[];
  boardCards: string[];
  potSize: number;
  toCall?: number;
  isHero?: boolean;
}

export default function OddsDisplay({
  holeCards,
  boardCards,
  potSize,
  toCall = 0,
  isHero = false,
}: OddsDisplayProps) {
  const odds = useMemo(() => {
    if (holeCards.length < 2 || boardCards.length < 3) {
      return { equity: 0, outs: 0, potOdds: 0, isDrawing: false };
    }

    const outs = countOuts(holeCards, boardCards);
    const cardsTocome = 5 - boardCards.length;
    const equity = calculateEquity(outs, cardsTocome);
    const potOdds = toCall > 0 ? ((toCall / (potSize + toCall)) * 100).toFixed(1) : '0';

    return {
      equity,
      outs,
      potOdds: parseFloat(potOdds as string),
      isDrawing: equity < 50,
    };
  }, [holeCards, boardCards, potSize, toCall]);

  const drawType = useMemo(() => classifyDrawType(holeCards, boardCards), [holeCards, boardCards]);

  const getRecommendation = () => {
    if (toCall === 0) return { action: 'Check or Bet', color: '#10b981' };
    if (odds.equity >= parseFloat(odds.potOdds.toFixed(1))) {
      return { action: 'Call/Raise', color: '#10b981' };
    }
    return { action: 'Fold', color: '#ef4444' };
  };

  const recommendation = getRecommendation();
  const cardsTocome = 5 - boardCards.length;

  const parseCard = (cardStr: string): Card => {
    let rank = cardStr.slice(0, -1);
    const suit = cardStr.slice(-1) as Card['suit'];
    if (rank === '10') rank = 'T';
    return { rank: rank as Card['rank'], suit };
  };

  const getDrawTypeLabel = (type?: string) => {
    switch (type) {
      case 'flush-draw':
        return 'Flush Draw';
      case 'straight-draw':
        return 'Straight Draw';
      case 'combo-draw':
        return 'Combo Draw';
      case 'gutshot':
        return 'Gutshot';
      case 'overcards':
        return 'Overcards';
      default:
        return undefined;
    }
  };

  if (holeCards.length < 2 || boardCards.length < 3) {
    return (
      <div className="odds-display odds-display--placeholder">
        <p>Waiting For Hole Cards And Flop...</p>
      </div>
    );
  }

  return (
    <div className={`odds-display ${!isHero ? 'odds-display--opponent' : ''}`}>
      {/* Main equity display */}
      <div className="odds-main">
        <div className="equity-section">
          <div className="equity-value-wrapper">
            <span className="equity-label">Equity</span>
            <span className="equity-value">{odds.equity.toFixed(1)}%</span>
          </div>

          <div className="equity-bar">
            <div
              className="equity-fill"
              style={{
                width: `${odds.equity}%`,
                background: getEquityGradient(odds.equity),
              }}
            />
          </div>
        </div>

        {/* Outs and draw type */}
        <div className="outs-section">
          <div className="outs-badge">
            <span className="outs-number">{odds.outs}</span>
            <span className="outs-label">Outs</span>
          </div>

          {drawType && (
            <div className="draw-type-badge">
              <span className="draw-type-label">{getDrawTypeLabel(drawType)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Secondary metrics */}
      <div className="odds-metrics">
        <div className="metric-item">
          <span className="metric-label">Pot Odds</span>
          <span className="metric-value">{odds.potOdds.toFixed(1)}%</span>
        </div>

        <div className="metric-item">
          <span className="metric-label">Cards</span>
          <span className="metric-value">{cardsTocome} Left</span>
        </div>
      </div>

      {/* Recommendation */}
      {toCall > 0 && (
        <div className="recommendation" style={{ borderLeftColor: recommendation.color }}>
          <span className="rec-label">Decision</span>
          <span className="rec-action" style={{ color: recommendation.color }}>
            {recommendation.action}
          </span>
        </div>
      )}

      {/* Hand cards display */}
      <div className="hole-cards-mini">
        {holeCards.map((card, idx) => (
          <div key={idx} className="mini-card">
            <CardImage card={parseCard(card)} size="xs" />
          </div>
        ))}
      </div>
    </div>
  );
}

function getEquityGradient(equity: number): string {
  if (equity >= 70) return 'linear-gradient(90deg, #10b981, #06b6d4)';
  if (equity >= 50) return 'linear-gradient(90deg, #f59e0b, #10b981)';
  if (equity >= 30) return 'linear-gradient(90deg, #f97316, #f59e0b)';
  return 'linear-gradient(90deg, #ef4444, #f97316)';
}
