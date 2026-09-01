/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT SCORE CARD — Agent Performance Rating & Metrics
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Shows agent performance score (0–100) computed from:
 *  - Distribution activity volume (30d)
 *  - Player retention rate
 *  - Clawback rate (lower is better)
 *  - Active player count
 */

import { useState, useEffect, useCallback } from 'react';
import { AGENT_DISTRIBUTION_READ_TYPES } from '../../lib/agentDistributionTypes';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import './AgentScoreCard.css';
import { reportError } from '../../utils/errorReporter';

interface AgentScoreCardProps {
  userId: string;
  clubId: string;
}

interface ScoreData {
  overallScore: number;
  distributionScore: number;
  retentionScore: number;
  clawbackScore: number;
  activityScore: number;
  totalDistributions30d: number;
  totalClawbacks30d: number;
  clawbackRate: number;
  activePlayers: number;
  totalPlayers: number;
  retentionRate: number;
  avgDistribution: number;
}

export default function AgentScoreCard({ userId, clubId }: AgentScoreCardProps) {
  const [data, setData] = useState<ScoreData | null>(null);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  const loadScore = useCallback(async () => {
    setLoading(true);
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

      // Get agent PK
      const { data: agentRow } = await supabase
        .from('agents')
        .select('id')
        .eq('user_id', userId)
        .eq('club_id', clubId)
        .maybeSingle();

      if (!agentRow?.id) {
        if (isMounted.current) setLoading(false);
        return;
      }

      // Get distributions (30d)
      const { data: distributions } = await supabase
        .from('chip_transactions')
        .select('id, amount, clawed_back')
        .eq('from_user_id', userId)
        .eq('club_id', clubId)
        .in('transaction_type', [...AGENT_DISTRIBUTION_READ_TYPES])
        .gte('created_at', thirtyDaysAgo);

      // Get unique recipients (players)
      const { data: recipients } = await supabase
        .from('chip_transactions')
        .select('to_user_id')
        .eq('from_user_id', userId)
        .eq('club_id', clubId)
        .in('transaction_type', [...AGENT_DISTRIBUTION_READ_TYPES]);

      // Get active players (seen in last 7 days)
      const uniquePlayerIds = [
        ...new Set((recipients || []).map((r: any) => r.to_user_id).filter(Boolean)),
      ];
      let activePlayers = 0;
      if (uniquePlayerIds.length > 0) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        const { data: activeProfiles } = await supabase
          .from('profiles')
          .select('id')
          .in('id', uniquePlayerIds.slice(0, 50))
          .gte('last_seen', sevenDaysAgo);
        activePlayers = (activeProfiles || []).length;
      }

      if (!isMounted.current) return;

      const totalDist = (distributions || []).length;
      const clawedBack = (distributions || []).filter((d: any) => d.clawed_back).length;
      const clawbackRate = totalDist > 0 ? (clawedBack / totalDist) * 100 : 0;
      const totalPlayers = uniquePlayerIds.length;
      const retentionRate = totalPlayers > 0 ? (activePlayers / totalPlayers) * 100 : 0;
      const totalAmount = (distributions || []).reduce(
        (sum: number, d: any) => sum + (d.amount || 0),
        0
      );
      const avgDist = totalDist > 0 ? totalAmount / totalDist : 0;

      // Compute sub-scores (0–100 each)
      const distributionScore = Math.min(100, Math.round((totalDist / 50) * 100)); // 50+ = max
      const retentionScore = Math.round(retentionRate);
      const clawbackScore = Math.round(Math.max(0, 100 - clawbackRate * 5)); // 0% clawback = 100, 20% = 0
      const activityScore = Math.min(
        100,
        Math.round((activePlayers / Math.max(totalPlayers, 1)) * 100)
      );

      const overallScore = Math.round(
        distributionScore * 0.25 + retentionScore * 0.3 + clawbackScore * 0.25 + activityScore * 0.2
      );

      setData({
        overallScore,
        distributionScore,
        retentionScore,
        clawbackScore,
        activityScore,
        totalDistributions30d: totalDist,
        totalClawbacks30d: clawedBack,
        clawbackRate,
        activePlayers,
        totalPlayers,
        retentionRate,
        avgDistribution: avgDist,
      });
    } catch (err) {
      reportError(err, 'AgentScoreCard.Error');
    }
    if (isMounted.current) setLoading(false);
  }, [userId, clubId]);

  useEffect(() => {
    loadScore();
  }, [loadScore]);

  useMasterBusSubscription('CHIPS_DISTRIBUTED', () => {
    if (isMounted.current) loadScore();
  });
  useMasterBusSubscription('BALANCE_UPDATED', () => {
    if (isMounted.current) loadScore();
  });

  const getScoreColor = (score: number) => {
    if (score >= 80) return '#31A24C';
    if (score >= 60) return '#4599FF';
    if (score >= 40) return '#F7C52A';
    return '#FA383E';
  };

  const getGrade = (score: number) => {
    if (score >= 90) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B+';
    if (score >= 60) return 'B';
    if (score >= 50) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  };

  if (loading) {
    return (
      <div className="agent-score-card">
        <div className="score-header">
          <h3>Agent Performance Score</h3>
        </div>
        <div className="score-loading">
          <div className="score-skeleton score-skeleton-ring" />
          <div className="score-skeleton-grid">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="score-skeleton score-skeleton-bar" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="agent-score-card">
        <div className="score-header">
          <h3>Agent Performance Score</h3>
        </div>
        <div className="score-empty">
          <span className="score-empty-icon">★</span>
          <p>No Performance Data Available Yet</p>
        </div>
      </div>
    );
  }

  const scoreColor = getScoreColor(data.overallScore);
  const circumference = 2 * Math.PI * 54;
  const dashOffset = circumference - (data.overallScore / 100) * circumference;

  return (
    <div className="agent-score-card">
      <div className="score-header">
        <h3>Agent Performance Score</h3>
        <span className="score-period">Last 30 Days</span>
      </div>

      <div className="score-body">
        {/* Ring Gauge */}
        <div className="score-ring-container">
          <svg viewBox="0 0 120 120" className="score-ring-svg">
            <circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="8"
            />
            <circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              stroke={scoreColor}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 60 60)"
              style={{ transition: 'stroke-dashoffset 1s ease-in-out' }}
            />
          </svg>
          <div className="score-ring-center">
            <span className="score-ring-value" style={{ color: scoreColor }}>
              {data.overallScore}
            </span>
            <span className="score-ring-grade" style={{ color: scoreColor }}>
              {getGrade(data.overallScore)}
            </span>
          </div>
        </div>

        {/* Sub-scores */}
        <div className="score-breakdown">
          <ScoreBar
            label="Distribution Volume"
            score={data.distributionScore}
            detail={`${data.totalDistributions30d} txns`}
          />
          <ScoreBar
            label="Player Retention"
            score={data.retentionScore}
            detail={`${data.activePlayers}/${data.totalPlayers} active`}
          />
          <ScoreBar
            label="Clawback Health"
            score={data.clawbackScore}
            detail={`${data.clawbackRate.toFixed(1)}% rate`}
          />
          <ScoreBar
            label="Network Activity"
            score={data.activityScore}
            detail={`${data.activePlayers} active players`}
          />
        </div>
      </div>

      {/* Stats Footer */}
      <div className="score-stats">
        <div className="score-stat">
          <span className="score-stat-value">
            {data.avgDistribution >= 1000
              ? `${(data.avgDistribution / 1000).toFixed(1)}K`
              : data.avgDistribution.toFixed(0)}
          </span>
          <span className="score-stat-label">Avg Distribution</span>
        </div>
        <div className="score-stat">
          <span
            className="score-stat-value"
            style={{ color: data.clawbackRate > 10 ? '#FA383E' : '#31A24C' }}
          >
            {data.clawbackRate.toFixed(1)}%
          </span>
          <span className="score-stat-label">Clawback Rate</span>
        </div>
        <div className="score-stat">
          <span
            className="score-stat-value"
            style={{ color: data.retentionRate > 50 ? '#31A24C' : '#F7C52A' }}
          >
            {data.retentionRate.toFixed(0)}%
          </span>
          <span className="score-stat-label">Retention</span>
        </div>
      </div>
    </div>
  );
}

function ScoreBar({ label, score, detail }: { label: string; score: number; detail: string }) {
  const color =
    score >= 80 ? '#31A24C' : score >= 60 ? '#4599FF' : score >= 40 ? '#F7C52A' : '#FA383E';
  return (
    <div className="score-bar-item">
      <div className="score-bar-header">
        <span className="score-bar-label">{label}</span>
        <span className="score-bar-value" style={{ color }}>
          {score}
        </span>
      </div>
      <div className="score-bar-track">
        <div
          className="score-bar-fill"
          style={{ width: `${score}%`, background: color, transition: 'width 0.8s ease-in-out' }}
        />
      </div>
      <span className="score-bar-detail">{detail}</span>
    </div>
  );
}
