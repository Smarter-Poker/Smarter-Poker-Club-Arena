/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POSITION STATS POPUP — Tap player avatar for positional breakdown
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows VPIP%, PFR%, 3-Bet%, Fold-to-3-Bet%, Win Rate by position.
 * Fetches from player_position_stats table via Supabase.
 */

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import {
  playerStyleClassifier,
  type PlayerStyleResult,
} from '../../services/PlayerStyleClassifier';
import './PositionStatsPopup.css';
import { reportError } from '../../utils/errorReporter';

interface PositionStatsPopupProps {
  playerId: string;
  playerName: string;
  isOpen: boolean;
  onClose: () => void;
  anchorX: number;
  anchorY: number;
}

interface PositionRow {
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  fold_to_three_bet_count: number;
  hands_won: number;
  total_profit: number;
}

const POS_ORDER = ['BTN', 'CO', 'HJ', 'MP', 'UTG', 'SB', 'BB'];

export default function PositionStatsPopup({
  playerId,
  playerName,
  isOpen,
  onClose,
  anchorX,
  anchorY,
}: PositionStatsPopupProps) {
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [styleResult, setStyleResult] = useState<PlayerStyleResult | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);

  // Fetch data
  useEffect(() => {
    if (!isOpen || !playerId) return;
    setLoading(true);

    (async () => {
      try {
        const { data, error } = await supabase
          .from('player_position_stats')
          .select(
            'position, hands_played, vpip_count, pfr_count, three_bet_count, fold_to_three_bet_count, hands_won, total_profit'
          )
          .eq('user_id', playerId)
          .limit(20);

        if (error) {
          console.warn('[PositionStatsPopup] Fetch error:', error.message);
          setRows([]);
        } else {
          // Sort by position order
          const sorted = (data || []).sort(
            (a, b) => POS_ORDER.indexOf(a.position) - POS_ORDER.indexOf(b.position)
          );
          setRows(sorted);

          // Classify player style from aggregate
          const totals = (data || []).reduce(
            (acc, r) => ({
              handsPlayed: acc.handsPlayed + r.hands_played,
              vpipCount: acc.vpipCount + r.vpip_count,
              pfrCount: acc.pfrCount + r.pfr_count,
              threeBetCount: acc.threeBetCount + r.three_bet_count,
            }),
            { handsPlayed: 0, vpipCount: 0, pfrCount: 0, threeBetCount: 0 }
          );
          setStyleResult(playerStyleClassifier.classify(totals));
        }
      } catch (err) {
        reportError(err, 'PositionStatsPopup.Error');
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen, playerId]);

  if (!isOpen) return null;

  const totalHands = rows.reduce((s, r) => s + r.hands_played, 0);

  // Position popup
  const style: React.CSSProperties = {
    left: Math.min(anchorX, window.innerWidth - 300),
    top: Math.min(anchorY + 10, window.innerHeight - 400),
  };

  return (
    <div className="psp-overlay">
      <div className="psp-popup" ref={popupRef} style={style}>
        {/* Header */}
        <div className="psp-header">
          <div className="psp-player-info">
            <span className="psp-name">{playerName}</span>
            {styleResult && (
              <span
                className="psp-style-badge"
                style={{ color: styleResult.color, background: styleResult.bgColor }}
              >
                {styleResult.icon} {styleResult.label}
              </span>
            )}
          </div>
          <button className="psp-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Total hands */}
        <div className="psp-total">
          {totalHands.toLocaleString()} Hands Tracked
          {styleResult && styleResult.confidence > 0 && (
            <span className="psp-confidence">
              Confidence: {Math.round(styleResult.confidence * 100)}%
            </span>
          )}
        </div>

        {loading ? (
          <div className="psp-loading">
            <div className="psp-skeleton" />
            <div className="psp-skeleton" />
            <div className="psp-skeleton" />
          </div>
        ) : rows.length === 0 ? (
          <div className="psp-empty">No Position Data Available</div>
        ) : (
          <>
            {/* Table header */}
            <div className="psp-table-header">
              <span>Pos</span>
              <span>Hands</span>
              <span>VPIP</span>
              <span>PFR</span>
              <span>3B</span>
              <span>Win%</span>
              <span>P/L</span>
            </div>

            {/* Data rows */}
            {rows.map((r) => {
              const vpip =
                r.hands_played > 0 ? Math.round((r.vpip_count / r.hands_played) * 100) : 0;
              const pfr = r.hands_played > 0 ? Math.round((r.pfr_count / r.hands_played) * 100) : 0;
              const threeBet =
                r.hands_played > 0 ? Math.round((r.three_bet_count / r.hands_played) * 100) : 0;
              const winRate =
                r.hands_played > 0 ? Math.round((r.hands_won / r.hands_played) * 100) : 0;
              const plClass = r.total_profit >= 0 ? 'psp-positive' : 'psp-negative';

              return (
                <div key={r.position} className="psp-row">
                  <span className="psp-pos">{r.position}</span>
                  <span className="psp-val">{r.hands_played}</span>
                  <span
                    className="psp-val"
                    style={{ color: vpip > 35 ? '#ef4444' : vpip < 18 ? '#3b82f6' : '#22c55e' }}
                  >
                    {vpip}%
                  </span>
                  <span className="psp-val" style={{ color: pfr > 25 ? '#f59e0b' : '#9ca3af' }}>
                    {pfr}%
                  </span>
                  <span className="psp-val">{threeBet}%</span>
                  <span className="psp-val" style={{ color: winRate > 50 ? '#22c55e' : '#9ca3af' }}>
                    {winRate}%
                  </span>
                  <span className={`psp-val ${plClass}`}>
                    {r.total_profit >= 0 ? '+' : ''}
                    {r.total_profit.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
