/**
 * ♠ CLUB ARENA — Player Stats Dashboard
 * VPIP, PFR, Aggression Factor, Graphs, Analysis
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import './PlayerStatsDashboard.css';

const STAT_CARDS = [
  { id: 'vpip', label: 'VPIP' },
  { id: 'pfr', label: 'PFR' },
  { id: 'af', label: 'AF' },
  { id: 'bb100', label: 'BB/100' },
];

interface PlayerStats {
  vpip: number; // Voluntarily Put chips In Pot
  pfr: number; // Pre-Flop Raise
  af: number; // Aggression Factor
  wtsd: number; // Went To ShowDown
  wsd: number; // Won at ShowDown
  bbPer100: number; // Big Blinds won per 100 hands
  totalHands: number;
  totalProfit: number;
}

interface SessionData {
  date: string;
  profit: number;
  hands: number;
}

export const PlayerStatsDashboard: React.FC<{ playerId?: string }> = ({ playerId }) => {
  const { user } = useAuthUser();
  const [stats, setStats] = useState<PlayerStats>({
    vpip: 24.5,
    pfr: 18.2,
    af: 2.8,
    wtsd: 28.5,
    wsd: 52.3,
    bbPer100: 4.2,
    totalHands: 15420,
    totalProfit: 12500,
  });
  const [sessionData, setSessionData] = useState<SessionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'hands' | 'leaks'>('overview');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    loadStats();
    generateSessionData();
  }, [playerId]);

  const loadStats = async () => {
    // In production, fetch from Supabase
    setLoading(false);
    setVisibleItems(new Set());
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = STAT_CARDS.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  };

  const generateSessionData = () => {
    const data: SessionData[] = [];
    let cumulative = 0;
    for (let i = 30; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const profit = Math.floor(Math.random() * 1000) - 300;
      cumulative += profit;
      data.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        profit: cumulative,
        hands: Math.floor(Math.random() * 200) + 50,
      });
    }
    setSessionData(data);
  };

  const radarData = [
    { stat: 'VPIP', value: stats.vpip, fullMark: 40 },
    { stat: 'PFR', value: stats.pfr, fullMark: 30 },
    { stat: 'AF', value: stats.af * 10, fullMark: 50 },
    { stat: 'WTSD', value: stats.wtsd, fullMark: 40 },
    { stat: 'WSD', value: stats.wsd, fullMark: 100 },
  ];

  const getStatColor = (stat: string, value: number) => {
    // Optimal ranges for TAG player
    const ranges: Record<string, [number, number]> = {
      vpip: [20, 28],
      pfr: [15, 22],
      af: [2.5, 4.0],
    };
    const range = ranges[(stat || '').toLowerCase()];
    if (!range) return 'var(--text-primary)';
    return value >= range[0] && value <= range[1] ? 'var(--accent-green)' : 'var(--accent-orange)';
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'hands', label: 'Hands' },
    { id: 'leaks', label: 'Leak Finder' },
  ] as const;

  return (
    <div className="stats-dashboard">
      <header className="stats-header">
        <h1>📊 Player Statistics</h1>
        <span className="hands-count">{stats.totalHands.toLocaleString()} hands tracked</span>
      </header>

      {/* Tabs */}
      <div className="stats-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <>
          {/* Key Stats Cards */}
          <div className="stats-grid">
            <div
              className="stat-card"
              style={{
                opacity: visibleItems.has(0) ? 1 : 0,
                transform: visibleItems.has(0) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="stat-label">VPIP</span>
              <span className="stat-value" style={{ color: getStatColor('vpip', stats.vpip) }}>
                {stats.vpip}%
              </span>
              <span className="stat-hint">Voluntarily Put In Pot</span>
            </div>
            <div
              className="stat-card"
              style={{
                opacity: visibleItems.has(1) ? 1 : 0,
                transform: visibleItems.has(1) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="stat-label">PFR</span>
              <span className="stat-value" style={{ color: getStatColor('pfr', stats.pfr) }}>
                {stats.pfr}%
              </span>
              <span className="stat-hint">Pre-Flop Raise</span>
            </div>
            <div
              className="stat-card"
              style={{
                opacity: visibleItems.has(2) ? 1 : 0,
                transform: visibleItems.has(2) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="stat-label">AF</span>
              <span className="stat-value" style={{ color: getStatColor('af', stats.af) }}>
                {stats.af}
              </span>
              <span className="stat-hint">Aggression Factor</span>
            </div>
            <div
              className="stat-card"
              style={{
                opacity: visibleItems.has(3) ? 1 : 0,
                transform: visibleItems.has(3) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="stat-label">BB/100</span>
              <span
                className="stat-value"
                style={{ color: stats.bbPer100 >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
              >
                {stats.bbPer100 > 0 ? '+' : ''}
                {stats.bbPer100}
              </span>
              <span className="stat-hint">Win Rate</span>
            </div>
          </div>

          {/* Profit Graph */}
          <div className="chart-section">
            <h3>📈 Profit Over Time</h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={sessionData}>
                <defs>
                  <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2ecc71" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#2ecc71" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="date" stroke="#6b7280" fontSize={10} />
                <YAxis stroke="#6b7280" fontSize={10} />
                <Tooltip
                  contentStyle={{
                    background: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                  }}
                  formatter={(value) => [`${Number(value).toLocaleString()} chips`, 'Profit']}
                />
                <Area
                  type="monotone"
                  dataKey="profit"
                  stroke="#2ecc71"
                  fillOpacity={1}
                  fill="url(#profitGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Radar Chart */}
          <div className="chart-section">
            <h3>🎯 Playing Style</h3>
            <ResponsiveContainer width="100%" height={250}>
              <RadarChart data={radarData}>
                <PolarGrid stroke="#374151" />
                <PolarAngleAxis dataKey="stat" stroke="#9ca3af" fontSize={12} />
                <PolarRadiusAxis stroke="#374151" />
                <Radar
                  name="Stats"
                  dataKey="value"
                  stroke="#1877f2"
                  fill="#1877f2"
                  fillOpacity={0.5}
                />
              </RadarChart>
            </ResponsiveContainer>
            <div className="style-label">
              <span className="style-badge">TAG</span>
              <span>Tight-Aggressive</span>
            </div>
          </div>
        </>
      )}

      {activeTab === 'leaks' && (
        <div className="leaks-section">
          <h3>🔍 Potential Leaks</h3>
          <div className="leak-item">
            <span className="leak-icon">⚠️</span>
            <div className="leak-info">
              <span className="leak-title">3-Bet Frequency Too Low</span>
              <p>
                You're 3-betting only 4.2% which is below optimal (6-8%). Consider widening your
                3-bet range in position.
              </p>
            </div>
          </div>
          <div className="leak-item">
            <span className="leak-icon">💡</span>
            <div className="leak-info">
              <span className="leak-title">C-Bet Too High on Turn</span>
              <p>
                Your turn c-bet of 72% is higher than optimal. Consider checking more missed draws.
              </p>
            </div>
          </div>
          <button className="btn-analyze">🧠 Get Analysis</button>
        </div>
      )}

      {activeTab === 'hands' && (
        <div className="hands-section">
          <h3>📝 Recent Hands</h3>
          <p className="hands-placeholder">View hand history in the Hand History page</p>
        </div>
      )}
    </div>
  );
};

export default PlayerStatsDashboard;
