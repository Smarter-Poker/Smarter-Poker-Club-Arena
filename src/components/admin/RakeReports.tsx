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

export const RakeReports: React.FC<RakeReportsProps> = ({ clubId }) => {
  const toast = useToast();
  const [data, setData] = useState<RakeData | null>(null);
  const [rawRecords, setRawRecords] = useState<any[]>([]);
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'year'>('week');
  const [loading, setLoading] = useState(true);
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
      console.error('Failed to load rake data:', error);
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
        <h2>💰 Rake Reports</h2>
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
          <span className="card-label">Avg per Hand</span>
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
        <h3>Top Games by Rake</h3>
        <div className="games-list">
          {data.topGames.map((game, index) => (
            <div key={game.game} className="game-row">
              <span className="game-rank">#{index + 1}</span>
              <span className="game-name">{game.game}</span>
              <div className="game-stats">
                <span className="game-rake">{game.rake.toLocaleString()}</span>
                <span className="game-hands">{game.hands.toLocaleString()} hands</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Export Button */}
      <button className="export-btn" onClick={exportCSV}>
        📥 Export Report
      </button>
    </div>
  );
};

export default RakeReports;
