/**
 * Shareable Hand Highlight Component
 * Premium card showcasing a hand with share options
 */

import React, { useState } from 'react';
import { CardImage } from '../table/CardImage';
import type { Card } from '../table/CardImage';
import './ShareableHighlight.css';
import { reportError } from '../../utils/errorReporter';

interface ShareableHighlightProps {
  handId: string;
  playerName: string;
  playerCards: string[];
  boardCards: string[];
  potSize: number;
  result: 'win' | 'loss' | 'tie';
  actionSummary: string;
  playedAt: string;
}

export default function ShareableHighlight({
  handId,
  playerName,
  playerCards,
  boardCards,
  potSize,
  result,
  actionSummary,
  playedAt,
}: ShareableHighlightProps) {
  const [copied, setCopied] = useState(false);

  const parseCard = (cardStr: string): Card => {
    let rank = cardStr.slice(0, -1);
    const suit = cardStr.slice(-1) as Card['suit'];
    if (rank === '10') rank = 'T';
    return { rank: rank as Card['rank'], suit };
  };

  const shareUrl = `https://smarter.poker/hub/club-arena/share/hand/${handId}`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      reportError(err, 'ShareableHighlight.Failed_to_copy');
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Hand Replay - ${playerName}`,
          text: `Check out this poker hand! ${actionSummary}`,
          url: shareUrl,
        });
      } catch (err) {
        reportError(err, 'ShareableHighlight.Share_failed');
      }
    } else {
      handleCopyLink();
    }
  };

  const resultColor = result === 'win' ? '#10b981' : result === 'loss' ? '#ef4444' : '#f59e0b';
  const resultLabel = result === 'win' ? 'WINNER' : result === 'loss' ? 'LOSER' : 'SPLIT';
  const resultIcon = result === 'win' ? '★' : result === 'loss' ? '⚠' : '◈';

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (err) {
      reportError(err, 'ShareableHighlight.Error');
      return 'Recent';
    }
  };

  return (
    <div className={`shareable-highlight shareable-highlight--${result}`}>
      {/* Gradient border accent */}
      <div className="highlight-border-accent" />

      {/* Header with result badge */}
      <div className="highlight-header">
        <div className="player-section">
          <span className="player-name">{playerName}</span>
          <span className="played-date">{formatDate(playedAt)}</span>
        </div>

        <div className="result-badge" style={{ borderColor: resultColor }}>
          <span className="result-icon">{resultIcon}</span>
          <span className="result-label" style={{ color: resultColor }}>
            {resultLabel}
          </span>
        </div>
      </div>

      {/* Hand cards */}
      <div className="highlight-cards-section">
        <span className="section-label">Your Hand</span>
        <div className="highlight-cards">
          {playerCards.map((card, idx) => (
            <div key={idx} className="highlight-card">
              <CardImage card={parseCard(card)} size="sm" />
            </div>
          ))}
        </div>
      </div>

      {/* Board cards */}
      <div className="highlight-board-section">
        <span className="section-label">Board</span>
        <div className="highlight-board">
          {boardCards.map((card, idx) => (
            <div key={idx} className="highlight-card">
              <CardImage card={parseCard(card)} size="sm" />
            </div>
          ))}
        </div>
      </div>

      {/* Pot and summary */}
      <div className="highlight-summary">
        <div className="summary-item">
          <span className="summary-label">Pot</span>
          <span className="summary-value">${potSize.toLocaleString()}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">Action</span>
          <span className="summary-value action-text">{actionSummary}</span>
        </div>
      </div>

      {/* Share buttons */}
      <div className="highlight-actions">
        <button className="action-btn shareable-highlight__copy-btn" onClick={handleCopyLink}>
          {copied ? '✓ Copied!' : 'Copy Link'}
        </button>
        <button className="action-btn share-btn" onClick={handleShare}>
          Share
        </button>
      </div>

      {/* Branding footer */}
      <div className="highlight-footer">
        <span className="branding">♠ Club Arena</span>
      </div>
    </div>
  );
}
