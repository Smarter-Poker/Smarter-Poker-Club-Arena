/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STYLE RADAR — 6-axis spider chart of player profile
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Axes: Aggression, Tightness, Position Awareness, Showdown Rate,
 *        Bluff Frequency (inverse of showdown), Win Rate
 *
 * Data source: Aggregated from session_history and player_position_stats
 *
 * Improvements:
 *  - Exponential backoff retry on transient fetch failures
 *  - SWR cache: show cached data instantly, refresh in background
 *  - Supabase Realtime subscription for cross-tab sync
 *  - ARIA labels on SVG chart for accessibility
 *  - Enhanced empty state with visual guidance
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { retryFetch } from '../../utils/retryFetch';
import {
  playerStyleClassifier,
  type PlayerStyleResult,
} from '../../services/PlayerStyleClassifier';
import './PlayerStyleRadar.css';
import { reportError } from '../../utils/errorReporter';

interface PlayerStyleRadarProps {
  userId: string;
}

interface RadarAxis {
  label: string;
  value: number; // 0 - 100
  color: string;
}

// ── SWR Cache helpers ──
const CACHE_PREFIX = 'psr_cache_';
function getCached(userId: string): RadarAxis[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch (err: unknown) {
    reportError(err instanceof Error ? err.message : String(err), 'PlayerStyleRadar.Error');
    return null;
  }
}
function setCache(userId: string, data: RadarAxis[]) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + userId, JSON.stringify(data));
  } catch (err: unknown) {
    reportError(err instanceof Error ? err.message : String(err), 'PlayerStyleRadar.Error');
    /* quota exceeded — ignore */
  }
}

export default function PlayerStyleRadar({ userId }: PlayerStyleRadarProps) {
  const [axes, setAxes] = useState<RadarAxis[]>([]);
  const [style, setStyle] = useState<PlayerStyleResult | null>(null);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const hasDataRef = useRef(false);

  // Show cached data instantly on mount (SWR pattern)
  useEffect(() => {
    if (!userId) return;
    const cached = getCached(userId);
    if (cached && cached.length > 0) {
      setAxes(cached);
      hasDataRef.current = true;
      setLoading(false); // Show cached immediately, will refresh in background
    }
  }, [userId]);

  const loadData = useCallback(async () => {
    if (!userId) return;
    // Only show full loading state if we have no cached/existing data
    if (!hasDataRef.current) setLoading(true);

    try {
      // Fetch session aggregates with retry
      const { data: sessions, error: sessError } = await retryFetch(
        () =>
          supabase
            .from('session_history')
            .select('vpip_percent, pfr_percent, hands_played, hands_won, bb_won')
            .eq('user_id', userId)
            .limit(200)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (sessError) {
        console.warn('[PlayerStyleRadar] Session fetch error:', sessError.message);
      }

      // Fetch position stats with retry
      const { data: posStats, error: posError } = await retryFetch(
        () =>
          supabase
            .from('player_position_stats')
            .select('position, hands_played, vpip_count, pfr_count, three_bet_count, hands_won')
            .eq('user_id', userId)
            .limit(50)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (posError) {
        console.warn('[PlayerStyleRadar] Position stats fetch error:', posError.message);
      }

      const sess = sessions || [];
      const pos = posStats || [];

      if (sess.length === 0 && pos.length === 0) {
        if (isMounted.current) setAxes([]);
        if (isMounted.current) setLoading(false);
        return;
      }

      // Calculate aggregate stats
      const totalHands =
        sess.reduce((s: number, r: { hands_played: number }) => s + r.hands_played, 0) || 1;
      const totalWon = sess.reduce((s: number, r: { hands_won: number }) => s + r.hands_won, 0);
      const avgVPIP =
        sess.reduce((s: number, r: { vpip_percent: number }) => s + r.vpip_percent, 0) /
        (sess.length || 1);
      const avgPFR =
        sess.reduce((s: number, r: { pfr_percent: number }) => s + r.pfr_percent, 0) /
        (sess.length || 1);

      // Position awareness: variance in VPIP across positions (higher = more aware)
      const posVPIPs = pos.map((p: { hands_played: number; vpip_count: number }) =>
        p.hands_played > 0 ? (p.vpip_count / p.hands_played) * 100 : 0
      );
      const posAwarenessVariance =
        posVPIPs.length > 1
          ? Math.sqrt(
              posVPIPs.reduce((s: number, v: number) => s + Math.pow(v - avgVPIP, 2), 0) /
                posVPIPs.length
            )
          : 0;

      // Normalize each axis to 0-100
      const aggression = Math.min(100, (avgPFR / 30) * 100);
      const tightness = Math.min(100, Math.max(0, (1 - avgVPIP / 50) * 100));
      const posAwareness = Math.min(100, (posAwarenessVariance / 15) * 100);
      const winRate = Math.min(100, totalHands > 0 ? (totalWon / totalHands) * 200 : 0);
      const showdownRate = Math.min(100, totalHands > 0 ? (totalWon / totalHands) * 150 : 0);
      const bluffFreq = Math.min(100, Math.max(0, 100 - showdownRate + avgPFR / 2));

      const radarAxes: RadarAxis[] = [
        { label: 'Aggression', value: Math.round(aggression), color: '#ef4444' },
        { label: 'Tightness', value: Math.round(tightness), color: '#3b82f6' },
        { label: 'Position', value: Math.round(posAwareness), color: '#a78bfa' },
        { label: 'Win Rate', value: Math.round(winRate), color: '#22c55e' },
        { label: 'Showdown', value: Math.round(showdownRate), color: '#f59e0b' },
        { label: 'Bluff Freq', value: Math.round(bluffFreq), color: '#ec4899' },
      ];

      if (isMounted.current) {
        setAxes(radarAxes);
        hasDataRef.current = true;
        setCache(userId, radarAxes); // Update SWR cache
      }

      // Classify overall style
      const totalPosHands = pos.reduce(
        (s: number, r: { hands_played: number }) => s + r.hands_played,
        0
      );
      const totalPosVPIP = pos.reduce(
        (s: number, r: { vpip_count: number }) => s + r.vpip_count,
        0
      );
      const totalPosPFR = pos.reduce((s: number, r: { pfr_count: number }) => s + r.pfr_count, 0);
      const total3Bet = pos.reduce(
        (s: number, r: { three_bet_count: number }) => s + r.three_bet_count,
        0
      );

      if (isMounted.current) {
        setStyle(
          playerStyleClassifier.classify({
            handsPlayed: totalPosHands || totalHands,
            vpipCount: totalPosVPIP || Math.round((avgVPIP / 100) * totalHands),
            pfrCount: totalPosPFR || Math.round((avgPFR / 100) * totalHands),
            threeBetCount: total3Bet,
          })
        );
      }
    } catch (err: unknown) {
      reportError(err instanceof Error ? err.message : String(err), 'PlayerStyleRadar.Error');
      if (isMounted.current) setAxes([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    loadData();
  }, [userId, loadData]);

  // Bus listeners for live stat updates
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('HAND_COMPLETED', () => loadData(), 2000),
      masterBus.subscribeDebounced('SESSION_ENDED', () => loadData(), 1000),
      masterBus.subscribeDebounced('DATA_MUTATED', () => loadData(), 3000),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadData]);

  // Supabase Realtime subscription for cross-tab sync
  useEffect(() => {
    if (!userId) return;
    const channelKey = `psr_realtime_${userId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'session_history', filter: `user_id=eq.${userId}` },
        () => loadData()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'PlayerStyleRadar._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[PlayerStyleRadar] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [userId, loadData]);

  // SVG radar chart with ARIA
  const chartSVG = useMemo(() => {
    if (axes.length < 3) return null;

    const CX = 120;
    const CY = 120;
    const R = 90;
    const n = axes.length;
    const angleStep = (2 * Math.PI) / n;
    const startAngle = -Math.PI / 2;

    const rings = [0.25, 0.5, 0.75, 1.0];

    const getPolygonPoints = (values: number[]) =>
      values
        .map((v, i) => {
          const angle = startAngle + i * angleStep;
          const r = (v / 100) * R;
          return `${CX + r * Math.cos(angle)},${CY + r * Math.sin(angle)}`;
        })
        .join(' ');

    const dataPoints = getPolygonPoints(axes.map((a) => a.value));

    // Build ARIA description
    const ariaDesc = axes.map((a) => `${a.label}: ${a.value}/100`).join(', ');

    return (
      <svg
        className="psr-svg"
        viewBox="0 0 240 240"
        role="img"
        aria-label={`Player Style Radar Chart. ${ariaDesc}`}
      >
        <title>Player Style Radar</title>
        <desc>{ariaDesc}</desc>

        {/* Grid rings */}
        {rings.map((scale) => (
          <polygon
            key={scale}
            points={getPolygonPoints(Array(n).fill(scale * 100))}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="0.5"
          />
        ))}

        {/* Axis lines */}
        {axes.map((_, i) => {
          const angle = startAngle + i * angleStep;
          return (
            <line
              key={i}
              x1={CX}
              y1={CY}
              x2={CX + R * Math.cos(angle)}
              y2={CY + R * Math.sin(angle)}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="0.5"
            />
          );
        })}

        {/* Data polygon with gradient fill */}
        <defs>
          <radialGradient id="radar-fill-grad">
            <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.1" />
          </radialGradient>
        </defs>
        <polygon
          points={dataPoints}
          fill="url(#radar-fill-grad)"
          stroke="#60a5fa"
          strokeWidth="1.5"
          strokeLinejoin="round"
          className="psr-data-polygon"
        />

        {/* Data points */}
        {axes.map((axis, i) => {
          const angle = startAngle + i * angleStep;
          const r = (axis.value / 100) * R;
          return (
            <circle
              key={i}
              cx={CX + r * Math.cos(angle)}
              cy={CY + r * Math.sin(angle)}
              r="3"
              fill={axis.color}
              stroke="#18191a"
              strokeWidth="1"
            />
          );
        })}

        {/* Axis labels */}
        {axes.map((axis, i) => {
          const angle = startAngle + i * angleStep;
          const labelR = R + 18;
          const x = CX + labelR * Math.cos(angle);
          const y = CY + labelR * Math.sin(angle);
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              className="psr-label"
              fill={axis.color}
            >
              {axis.label}
            </text>
          );
        })}
      </svg>
    );
  }, [axes]);

  if (loading) {
    return (
      <div className="psr-widget">
        <h3 className="psr-title">Player Profile</h3>
        <div className="psr-loading">
          <div className="psr-skeleton-circle" />
        </div>
      </div>
    );
  }

  if (axes.length === 0) {
    return (
      <div className="psr-widget">
        <h3 className="psr-title">Player Profile</h3>
        <div className="psr-empty">
          <div className="psr-empty-icon">--</div>
          <div className="psr-empty-title">No Profile Data Yet</div>
          <div className="psr-empty-desc">
            Play Hands At The Tables To Build Your Player Profile. Your Aggression, Tightness,
            Position Awareness, And More Will Be Tracked Automatically.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="psr-widget">
      <div className="psr-header">
        <h3 className="psr-title">Player Profile</h3>
        {style && (
          <span
            className="psr-style-badge"
            style={{ color: style.color, background: style.bgColor }}
          >
            {style.icon} {style.label}
          </span>
        )}
      </div>

      {/* Radar chart */}
      <div className="psr-chart-container">{chartSVG}</div>

      {/* Axis values */}
      <div className="psr-values">
        {axes.map((axis) => (
          <div key={axis.label} className="psr-axis-row">
            <span className="psr-axis-label" style={{ color: axis.color }}>
              {axis.label}
            </span>
            <div className="psr-axis-bar">
              <div
                className="psr-axis-fill"
                style={{ width: `${axis.value}%`, background: axis.color }}
              />
            </div>
            <span className="psr-axis-value">{axis.value}</span>
          </div>
        ))}
      </div>

      {style && <div className="psr-tooltip">{style.tooltip}</div>}
    </div>
  );
}
