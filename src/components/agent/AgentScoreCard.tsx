/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT SCORE CARD — Agent Performance Rating & Metrics
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Shows agent performance score (0–100) computed from:
 *  - Distribution activity volume (30d)
 *  - Player retention rate
 *  - Clawback rate (lower is better)
 *  - Active player count
 *
 *  #ClubArenaConsole: one console, closed flat. The grade in the pill, the
 *  overall score as the first row, the four sub-scores and the three
 *  headline figures as rows on the black glass (label in lit blue, value in
 *  the master's ink by threshold). No ring, no bars: nothing is drawn.
 *  Every read now binds its error and stops rather than scoring an agent
 *  off a query that failed.
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
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
      const { data: agentRow, error: agentError } = await supabase
        .from('agents')
        .select('id')
        .eq('user_id', userId)
        .eq('club_id', clubId)
        .maybeSingle();
      if (agentError) throw agentError;

      if (!agentRow?.id) {
        if (isMounted.current) setLoading(false);
        return;
      }

      // Get distributions (30d)
      const { data: distributions, error: distributionsError } = await supabase
        .from('chip_transactions')
        .select('id, amount, clawed_back')
        .eq('from_user_id', userId)
        .eq('club_id', clubId)
        .in('transaction_type', ['agent_to_player', 'promo_agent_to_player'])
        .gte('created_at', thirtyDaysAgo);
      if (distributionsError) throw distributionsError;

      // Get unique recipients (players)
      const { data: recipients, error: recipientsError } = await supabase
        .from('chip_transactions')
        .select('to_user_id')
        .eq('from_user_id', userId)
        .eq('club_id', clubId)
        .in('transaction_type', ['agent_to_player', 'promo_agent_to_player']);
      if (recipientsError) throw recipientsError;

      // Get active players (seen in last 7 days)
      const uniquePlayerIds = [
        ...new Set((recipients || []).map((r: any) => r.to_user_id).filter(Boolean)),
      ];
      let activePlayers = 0;
      if (uniquePlayerIds.length > 0) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        const { data: activeProfiles, error: activeError } = await supabase
          .from('profiles')
          .select('id')
          .in('id', uniquePlayerIds.slice(0, 50))
          .gte('last_seen', sevenDaysAgo);
        if (activeError) throw activeError;
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

  /* A score prints in the master's own ink by threshold: green from 80,
     blue from 60, gold from 40, red below. */
  const getScoreInk = (score: number): ConsoleInk => {
    if (score >= 80) return 'green';
    if (score >= 60) return 'blue';
    if (score >= 40) return 'gold';
    return 'red';
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
      <SpadeConsole
        className="agent-score-card"
        eyebrow="Agent"
        title="Performance Score"
        titleId="agent-score-title"
        pill="Scoring"
        pillInk="muted"
        foot="foot"
      >
        <p className="sc-copy sc-copy--center asc__state" aria-busy="true">
          Scoring The Last 30 Days...
        </p>
      </SpadeConsole>
    );
  }

  if (!data) {
    return (
      <SpadeConsole
        className="agent-score-card"
        eyebrow="Agent"
        title="Performance Score"
        titleId="agent-score-title"
        pill="No Data"
        pillInk="muted"
        foot="foot"
      >
        <p className="sc-copy sc-copy--center asc__state">No Performance Data Available Yet</p>
      </SpadeConsole>
    );
  }

  const overallInk = getScoreInk(data.overallScore);

  return (
    <SpadeConsole
      className="agent-score-card"
      eyebrow="Agent / Last 30 Days"
      title="Performance Score"
      titleId="agent-score-title"
      pill={`Grade ${getGrade(data.overallScore)}`}
      pillInk={overallInk}
      foot="foot"
    >
      <div className="asc__row asc__row--overall">
        <span className="asc__row-label sc-ink--blue">Overall Score</span>
        <span className={`asc__overall sc-ink--${overallInk}`}>{data.overallScore}</span>
      </div>

      {/* Sub-scores */}
      <section className="asc__section" aria-label="Score Breakdown">
        <ScoreRow
          label="Distribution Volume"
          score={data.distributionScore}
          ink={getScoreInk(data.distributionScore)}
          detail={`${data.totalDistributions30d} Txns`}
        />
        <ScoreRow
          label="Player Retention"
          score={data.retentionScore}
          ink={getScoreInk(data.retentionScore)}
          detail={`${data.activePlayers}/${data.totalPlayers} Active`}
        />
        <ScoreRow
          label="Clawback Health"
          score={data.clawbackScore}
          ink={getScoreInk(data.clawbackScore)}
          detail={`${data.clawbackRate.toFixed(1)}% Rate`}
        />
        <ScoreRow
          label="Network Activity"
          score={data.activityScore}
          ink={getScoreInk(data.activityScore)}
          detail={`${data.activePlayers} Active Players`}
        />
      </section>

      {/* Headline figures */}
      <section className="asc__section" aria-label="Headline Figures">
        <div className="asc__row">
          <span className="asc__row-label sc-ink--blue">Avg Distribution</span>
          <span className="asc__row-value sc-ink--silver">
            {compactChips(data.avgDistribution)}
          </span>
        </div>
        <div className="asc__row">
          <span className="asc__row-label sc-ink--blue">Clawback Rate</span>
          <span
            className={`asc__row-value ${data.clawbackRate > 10 ? 'sc-ink--red' : 'sc-ink--green'}`}
          >
            {data.clawbackRate.toFixed(1)}%
          </span>
        </div>
        <div className="asc__row">
          <span className="asc__row-label sc-ink--blue">Retention</span>
          <span
            className={`asc__row-value ${data.retentionRate > 50 ? 'sc-ink--green' : 'sc-ink--gold'}`}
          >
            {data.retentionRate.toFixed(0)}%
          </span>
        </div>
      </section>
    </SpadeConsole>
  );
}

function ScoreRow({
  label,
  score,
  ink,
  detail,
}: {
  label: string;
  score: number;
  ink: ConsoleInk;
  detail: string;
}) {
  return (
    <div className="asc__row">
      <span className="asc__row-lead">
        <span className="asc__row-label sc-ink--blue">{label}</span>
        <span className="asc__row-detail sc-ink--muted">{titleCase(detail)}</span>
      </span>
      <span className={`asc__row-value sc-ink--${ink}`}>{score}</span>
    </div>
  );
}
