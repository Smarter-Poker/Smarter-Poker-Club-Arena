/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STAKE LEVEL COMPARISON — Compare stats across different stakes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Groups session_history by big_blind and shows comparative metrics:
 * win rate, avg session P/L, VPIP, PFR, total hands, total profit.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './StakeLevelComparison.css';

interface StakeLevelComparisonProps {
  userId: string;
}

interface SessionRecord {
  big_blind: number;
  profit_loss: number;
  hands_played: number;
  hands_won: number;
  vpip_percent: number;
  pfr_percent: number;
  bb_won: number;
  duration_minutes: number;
}

interface StakeGroup {
  label: string;
  bigBlind: number;
  sessions: number;
  totalHands: number;
  totalProfit: number;
  avgVPIP: number;
  avgPFR: number;
  winRate: number;
  bbPer100: number;
  avgDuration: number;
}

export default function StakeLevelComparison({ userId }: StakeLevelComparisonProps) {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    loadRecords();
  }, [userId]);

  // Bus listeners for live updates
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('HAND_COMPLETED', () => loadRecords(), 2000),
      masterBus.subscribeDebounced('SESSION_ENDED', () => loadRecords(), 1000),
      masterBus.subscribeDebounced('DATA_MUTATED', () => loadRecords(), 3000),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const loadRecords = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    (async () => {
      try {
        const { data, error } = await supabase
          .from('session_history')
          .select(
            'big_blind, profit_loss, hands_played, hands_won, vpip_percent, pfr_percent, bb_won, duration_minutes'
          )
          .eq('user_id', userId)
          .order('big_blind', { ascending: true })
          .limit(500);

        if (error) {
          console.warn('[StakeLevelComparison] Fetch error:', error.message);
          if (isMounted.current) setRecords([]);
        } else {
          if (isMounted.current) setRecords(data || []);
        }
      } catch (err) {
        console.error('[StakeLevelComparison] Error:', err);
        if (isMounted.current) setRecords([]);
      } finally {
        if (isMounted.current) setLoading(false);
      }
    })();
  }, [userId]);

  const groups = useMemo<StakeGroup[]>(() => {
    if (records.length === 0) return [];

    const map = new Map<number, SessionRecord[]>();
    records.forEach((r) => {
      const existing = map.get(r.big_blind) || [];
      existing.push(r);
      map.set(r.big_blind, existing);
    });

    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([bb, recs]) => {
        const totalHands = recs.reduce((s, r) => s + r.hands_played, 0);
        const totalWon = recs.reduce((s, r) => s + r.hands_won, 0);
        const totalProfit = recs.reduce((s, r) => s + r.profit_loss, 0);
        const totalBBWon = recs.reduce((s, r) => s + r.bb_won, 0);
        const avgVPIP = recs.reduce((s, r) => s + r.vpip_percent, 0) / recs.length;
        const avgPFR = recs.reduce((s, r) => s + r.pfr_percent, 0) / recs.length;
        const avgDuration = recs.reduce((s, r) => s + r.duration_minutes, 0) / recs.length;

        return {
          label: `$${(bb / 2).toFixed(2)}/$${bb.toFixed(2)}`,
          bigBlind: bb,
          sessions: recs.length,
          totalHands,
          totalProfit,
          avgVPIP: Math.round(avgVPIP),
          avgPFR: Math.round(avgPFR),
          winRate: totalHands > 0 ? Math.round((totalWon / totalHands) * 100) : 0,
          bbPer100: totalHands > 0 ? parseFloat(((totalBBWon / totalHands) * 100).toFixed(1)) : 0,
          avgDuration: Math.round(avgDuration),
        };
      });
  }, [records]);

  // Find the best performing stake
  const bestStake = useMemo(() => {
    if (groups.length === 0) return null;
    return groups.reduce((best, g) => (g.bbPer100 > best.bbPer100 ? g : best), groups[0]);
  }, [groups]);

  if (loading) {
    return (
      <div className="slc-widget">
        <h3 className="slc-title">Stake Level Comparison</h3>
        <div className="slc-loading">
          <div className="slc-skeleton" />
          <div className="slc-skeleton" />
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="slc-widget">
        <h3 className="slc-title">Stake Level Comparison</h3>
        <div className="slc-empty">No session data available yet</div>
      </div>
    );
  }

  return (
    <div className="slc-widget">
      <h3 className="slc-title">Stake Level Comparison</h3>

      {bestStake && groups.length > 1 && (
        <div className="slc-best-badge">
          Best: <strong>{bestStake.label}</strong> ({bestStake.bbPer100 >= 0 ? '+' : ''}
          {bestStake.bbPer100} BB/100)
        </div>
      )}

      {/* Table */}
      <div className="slc-table-wrap">
        <div className="slc-table-header">
          <span>Stakes</span>
          <span>Sessions</span>
          <span>Hands</span>
          <span>P/L</span>
          <span>BB/100</span>
          <span>VPIP</span>
          <span>PFR</span>
        </div>

        {groups.map((g) => {
          const plClass = g.totalProfit >= 0 ? 'slc-positive' : 'slc-negative';
          const isBest = bestStake && g.bigBlind === bestStake.bigBlind && groups.length > 1;

          return (
            <div key={g.bigBlind} className={`slc-row ${isBest ? 'slc-row-best' : ''}`}>
              <span className="slc-stakes">{g.label}</span>
              <span className="slc-val">{g.sessions}</span>
              <span className="slc-val">{g.totalHands.toLocaleString()}</span>
              <span className={`slc-val ${plClass}`}>
                {g.totalProfit >= 0 ? '+' : ''}
                {g.totalProfit.toLocaleString()}
              </span>
              <span className={`slc-val ${g.bbPer100 >= 0 ? 'slc-positive' : 'slc-negative'}`}>
                {g.bbPer100 >= 0 ? '+' : ''}
                {g.bbPer100}
              </span>
              <span className="slc-val">{g.avgVPIP}%</span>
              <span className="slc-val">{g.avgPFR}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
