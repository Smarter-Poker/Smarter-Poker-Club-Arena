/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  JACKPOT HISTORY — Big Wins
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * List of recent Bad Beat Jackpot hits.
 * - Winner info
 * - Hand details
 * - Payout amounts
 * - Replay link
 */

import React, { useState, useEffect, useRef } from 'react';
import './JackpotHistory.css';

export interface JackpotHit {
  id: string;
  date: string;
  winnerName: string;
  loserName: string; // The person who had the bad beat (main winner)
  hand: string; // e.g. "Quad Aces vs Royal Flush"
  totalJackpot: number;
  winnerShare: number;
  tableShare: number;
}

export interface JackpotHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  hits: JackpotHit[];
  currency?: string;
  onReplay: (id: string) => void;
}

export function JackpotHistory({
  isOpen,
  onClose,
  hits,
  currency = '',
  onReplay,
}: JackpotHistoryProps) {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = hits.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    } else {
      setVisibleItems(new Set());
    }
  }, [isOpen, hits.length]);

  if (!isOpen) return null;

  return (
    <div className="jackpot-overlay" onClick={onClose}>
      <div className="jackpot-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="jackpot-header">
          <div className="jackpot-title-group">
            <span className="jackpot-icon"></span>
            <h2 className="jackpot-title">Jackpot History</h2>
          </div>
          <button className="jackpot-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Content */}
        <div className="jackpot-content">
          <table className="jackpot-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Bad Beat Winner</th>
                <th>Winning Hand</th>
                <th>Hand Matchup</th>
                <th>Total Pool</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {hits.length > 0 ? (
                hits.map((hit, i) => (
                  <tr
                    key={hit.id}
                    style={{
                      opacity: visibleItems.has(i) ? 1 : 0,
                      transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <td className="col-date">{hit.date}</td>
                    <td className="col-player">
                      <span className="player-highlight">{hit.loserName}</span>
                      <span className="sub-text">
                        Won {currency}
                        {hit.winnerShare.toLocaleString()}
                      </span>
                    </td>
                    <td className="col-player">
                      <span>{hit.winnerName}</span>
                    </td>
                    <td className="col-hand">{hit.hand}</td>
                    <td className="col-amount">
                      {currency}
                      {hit.totalJackpot.toLocaleString()}
                    </td>
                    <td>
                      <button className="replay-btn" onClick={() => onReplay(hit.id)}>
                        ▶ Replay
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    No Jackpot Hits Yet. Keep Grinding!
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default JackpotHistory;
