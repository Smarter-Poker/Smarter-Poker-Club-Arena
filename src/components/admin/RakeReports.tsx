/**
 * ♠ CLUB ARENA — Rake Reports
 * Club rake analytics and reports
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './RakeReports.css';
import { reportError } from '../../utils/errorReporter';

interface RakeData {
  period: string;
  totalRake: number;
  totalHands: number;
  avgRakePerHand: number;
  topGames: { game: string; rake: number; hands: number }[];
  dailyBreakdown: { date: string; rake: number; hands: number }[];
}

interface RakeReportsProps {
  clubId: string;
}

/**
 * WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): per-hand breakdown returned by
 * fn_hand_rake_breakdown — the operator's dispute/audit drill-down. The RPC is
 * authorised server-side (club owner, union overseer, or engine); this panel
 * is a viewer, not the control.
 */
interface HandBreakdown {
  found: boolean;
  error?: string;
  hand_id?: string;
  rake_method?: string;
  gross_pot?: number | null;
  regular_rake_collected?: number;
  bbj_drop_collected?: number | null;
  net_pot_paid_to_players?: number | null;
  total_eligible_contributions?: number;
  players?: Array<{
    player_id: string;
    gross_contribution: number | null;
    returned_uncalled: number | null;
    eligible_contribution: number | null;
    contribution_weight: number | null;
    weighted_rake_credit: number | null;
    bbj_attributed_contribution: number | null;
  }>;
  reconciliation?: {
    expected_regular_rake: number;
    allocated_regular_rake: number;
    difference: number;
    valid: boolean;
  };
}

export const RakeReports: React.FC<RakeReportsProps> = ({ clubId }) => {
  const toast = useToast();
  const [data, setData] = useState<RakeData | null>(null);
  const [rawRecords, setRawRecords] = useState<any[]>([]);
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'year'>('week');
  const [loading, setLoading] = useState(true);
  const [lookupInput, setLookupInput] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [breakdown, setBreakdown] = useState<HandBreakdown | null>(null);
  const isMounted = useIsMounted();
  const { style: barStyle } = useStaggerAnimation(data?.dailyBreakdown.length || 0);

  useEffect(() => {
    loadRakeData();
  }, [clubId, period]);

  const loadRakeData = async () => {
    setLoading(true);
    try {
      // Calculate date ranges based on period
      const now = new Date();
      const startDate = new Date();

      if (period === 'today') {
        startDate.setHours(0, 0, 0, 0);
      } else if (period === 'week') {
        startDate.setDate(now.getDate() - 7);
      } else if (period === 'month') {
        startDate.setMonth(now.getMonth() - 1);
      } else if (period === 'year') {
        startDate.setFullYear(now.getFullYear() - 1);
      }

      const resolvedId = await resolveClubUUID(clubId);
      const { data: records, error } = await supabase
        .from('rake_records')
        .select('rake_amount, created_at')
        .eq('club_id', resolvedId)
        .gte('created_at', startDate.toISOString());

      if (error) throw error;

      setRawRecords(records || []);

      let totalRake = 0;
      const dailyData: Record<string, { rake: number; hands: number }> = {};

      (records || []).forEach((record: any) => {
        totalRake += Number(record.rake_amount || 0);

        // Group by day for the chart
        const dateKey = new Date(record.created_at).toLocaleDateString();
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = { rake: 0, hands: 0 };
        }
        dailyData[dateKey].rake += Number(record.rake_amount || 0);
        dailyData[dateKey].hands += 1;
      });

      // Map dailyData to array
      const dailyBreakdown = Object.keys(dailyData)
        .map((date) => ({
          date,
          rake: Math.round(dailyData[date].rake * 100) / 100,
          hands: dailyData[date].hands,
        }))
        .slice(-7); // Keep last 7 days for the chart

      const totalHands = records?.length || 0;

      const liveData: RakeData = {
        period: `Past ${period}`,
        totalRake: Math.round(totalRake * 100) / 100,
        totalHands,
        avgRakePerHand: totalHands > 0 ? totalRake / totalHands : 0,
        topGames: [], // Need table joins for this, empty for now
        dailyBreakdown:
          dailyBreakdown.length > 0 ? dailyBreakdown : [{ date: 'Today', rake: 0, hands: 0 }],
      };
      setData(liveData);
    } catch (error) {
      reportError(error, 'RakeReports.Failed_to_load_rake_data');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const exportCSV = () => {
    if (rawRecords.length === 0) {
      toast.info('No rake records found for this period.');
      return;
    }

    const headers = ['Date', 'Time', 'Rake Amount'];
    const rows = rawRecords.map((record) => {
      const dateObj = new Date(record.created_at);
      const date = dateObj.toLocaleDateString();
      const time = dateObj.toLocaleTimeString();
      const amount = record.rake_amount || 0;
      return [date, time, amount].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `rake_report_${clubId}_${period}_${new Date().toISOString().split('T')[0]}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const lookupHand = async () => {
    const raw = lookupInput.trim();
    if (!raw) {
      toast.info('Enter a hand id or hand number to look up.');
      return;
    }
    setLookupBusy(true);
    setBreakdown(null);
    try {
      let handId: string | null = null;
      const isUuid =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw);
      if (isUuid) {
        handId = raw;
      } else if (/^\d+$/.test(raw)) {
        // A hand NUMBER: resolve it to the hand id through this club's
        // rake_records (RLS keeps the lookup club-scoped).
        const resolvedId = await resolveClubUUID(clubId);
        const { data: rec, error: lookupErr } = await supabase
          .from('rake_records')
          .select('hand_id')
          .eq('club_id', resolvedId)
          .eq('global_hand_id', Number(raw))
          .not('hand_id', 'is', null)
          .limit(1)
          .maybeSingle();
        if (lookupErr) throw lookupErr;
        handId = (rec?.hand_id as string) ?? null;
      }
      if (!handId) {
        toast.info('No raked hand found for that id or number in this club.');
        return;
      }
      const { data: result, error } = await supabase.rpc('fn_hand_rake_breakdown', {
        p_hand_id: handId,
      });
      if (error) throw error;
      const bd = result as HandBreakdown;
      if (!bd?.found) {
        toast.info(
          bd?.error === 'not_authorised'
            ? 'Only the club owner or a union overseer can view hand breakdowns.'
            : 'No rake record exists for that hand.'
        );
        return;
      }
      setBreakdown(bd);
    } catch (err) {
      reportError(err, 'RakeReports.Hand_breakdown_lookup_failed');
      toast.error('Could not load the hand breakdown.');
    } finally {
      if (isMounted.current) setLookupBusy(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="rake-reports loading">
        <div className="spinner" />
      </div>
    );
  }

  const maxRake = Math.max(...data.dailyBreakdown.map((d) => d.rake));

  return (
    <div className="rake-reports">
      <div className="reports-header">
        <h2>Rake Reports</h2>
        <div className="period-selector">
          {(['today', 'week', 'month', 'year'] as const).map((p) => (
            <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="summary-cards">
        <div className="summary-card">
          <span className="card-value">{data.totalRake.toLocaleString()}</span>
          <span className="card-label">Total Rake</span>
        </div>
        <div className="summary-card">
          <span className="card-value">{data.totalHands.toLocaleString()}</span>
          <span className="card-label">Hands Played</span>
        </div>
        <div className="summary-card">
          <span className="card-value">{Math.trunc(data.avgRakePerHand * 100) / 100}</span>
          <span className="card-label">Avg Per Hand</span>
        </div>
      </div>

      {/* Daily Chart */}
      <div className="daily-chart">
        <h3>Daily Breakdown</h3>
        <div className="chart-bars">
          {data.dailyBreakdown.map((day, i) => (
            <div key={day.date} className="bar-group" style={barStyle(i)}>
              <div className="bar-container">
                <div className="bar-fill" style={{ height: `${(day.rake / maxRake) * 100}%` }} />
              </div>
              <span className="bar-label">{day.date}</span>
              <span className="bar-value">{day.rake}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Top Games */}
      <div className="top-games">
        <h3>Top Games By Rake</h3>
        <div className="games-list">
          {data.topGames.map((game, index) => (
            <div key={game.game} className="game-row">
              <span className="game-rank">#{index + 1}</span>
              <span className="game-name">{game.game}</span>
              <div className="game-stats">
                <span className="game-rake">{game.rake.toLocaleString()}</span>
                <span className="game-hands">{game.hands.toLocaleString()} Hands</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Hand Rake Breakdown (weighted contributed rake drill-down) */}
      <div className="top-games">
        <h3>Hand Rake Breakdown</h3>
        <p style={{ opacity: 0.7, fontSize: '0.85rem', margin: '4px 0 10px' }}>
          Look Up Any Raked Hand By Hand ID Or Hand Number To See Each Player&apos;S Contribution,
          Weight And Credited Rake.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') lookupHand();
            }}
            placeholder="Hand ID Or Hand Number"
            style={{ flex: 1, padding: '8px 10px', borderRadius: 8 }}
            aria-label="Hand ID Or Hand Number"
          />
          <button className="export-btn" onClick={lookupHand} disabled={lookupBusy}>
            {lookupBusy ? 'Loading' : 'Look Up'}
          </button>
        </div>
        {breakdown && breakdown.found && (
          <div>
            <div className="summary-cards">
              <div className="summary-card">
                <span className="card-value">
                  {Number(breakdown.regular_rake_collected ?? 0).toLocaleString()}
                </span>
                <span className="card-label">Rake Collected</span>
              </div>
              <div className="summary-card">
                <span className="card-value">
                  {Number(breakdown.bbj_drop_collected ?? 0).toLocaleString()}
                </span>
                <span className="card-label">BBJ Drop</span>
              </div>
              <div className="summary-card">
                <span className="card-value">
                  {breakdown.reconciliation?.valid ? 'Valid' : 'MISMATCH'}
                </span>
                <span className="card-label">
                  Reconciliation (
                  {breakdown.rake_method === 'WEIGHTED_CONTRIBUTED' ? 'Weighted' : 'Legacy Equal'})
                </span>
              </div>
            </div>
            <div className="games-list">
              {(breakdown.players ?? []).map((p, index) => (
                <div key={p.player_id} className="game-row">
                  <span className="game-rank">#{index + 1}</span>
                  <span className="game-name" title={p.player_id}>
                    {p.player_id.slice(0, 8)}
                  </span>
                  <div className="game-stats">
                    <span className="game-rake">
                      Credit {Number(p.weighted_rake_credit ?? 0).toFixed(2)}
                    </span>
                    <span className="game-hands">
                      In {Number(p.eligible_contribution ?? 0).toLocaleString()}
                      {Number(p.returned_uncalled ?? 0) > 0
                        ? ` (Returned ${Number(p.returned_uncalled).toLocaleString()})`
                        : ''}
                      {' | '}
                      {(Number(p.contribution_weight ?? 0) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Export Button */}
      <button className="export-btn" onClick={exportCSV}>
        Export Report
      </button>
    </div>
  );
};

export default RakeReports;
