/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUS DEV TOOLS — Live MasterBus Diagnostics Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Admin page showing:
 *  - Live event log (streamed via onEvent callback)
 *  - Channel registry with health status
 *  - Subscriber count per event type
 *  - Offline queue status
 *  - Diagnostics snapshot (auto-refresh every 2s)
 *  - Test event emitter for debugging
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { masterBus, type BusEventType } from '../core/MasterBus';
import { OfflineQueueService } from '../services/OfflineQueueService';
import { busEventLogger } from '../services/BusEventLogger';
import { formatRelativeShort as formatTime } from '@/lib/date';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import './BusDevToolsPage.css';

interface EventLogItem {
  id: number;
  type: string;
  payload: unknown;
  timestamp: string;
}

interface DiagSnapshot {
  subscribers: Record<string, number>;
  channels: { key: string; state: string }[];
  pendingTimers: number;
  initialized: boolean;
  eventLogSize: number;
  channelFactories: number;
}

const STATE_COLORS: Record<string, string> = {
  joined: '#31A24C',
  subscribed: '#31A24C',
  closed: '#b91c1c',
  errored: '#dc2626',
  leaving: '#d97706',
  unknown: '#6b7280',
};

const TEST_EVENTS: { type: BusEventType; label: string }[] = [
  { type: 'AUTH_STATE_CHANGED', label: 'Auth Change' },
  { type: 'BALANCE_UPDATED', label: 'Balance' },
  { type: 'CLUB_JOINED', label: 'Club Join' },
  { type: 'TABLE_SEATED', label: 'Table Seat' },
  { type: 'NOTIFICATION_READ', label: 'Notif Read' },
];

export default function BusDevToolsPage() {
  const { user } = useAuthUser();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagSnapshot | null>(null);
  const [eventLog, setEventLog] = useState<EventLogItem[]>([]);
  const [offlineCount, setOfflineCount] = useState(0);
  const [loggerBatchSize, setLoggerBatchSize] = useState(0);
  const [filter, setFilter] = useState<string>('all');
  const [isPaused, setIsPaused] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of event log
  const scrollToBottom = useCallback(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Check admin role
  useEffect(() => {
    if (!user?.id) {
      setIsAdmin(false);
      return;
    }
    supabase
      .from('club_members')
      .select('role')
      .eq('user_id', user.id)
      .in('role', ['owner', 'co_owner', 'admin'])
      .limit(1)
      .maybeSingle()
      .then(
        ({ data }) => setIsAdmin(!!data),
        () => setIsAdmin(false)
      );
  }, [user?.id]);

  // Refresh diagnostics every 2s
  useEffect(() => {
    const refresh = async () => {
      setDiagnostics(masterBus.getDiagnostics());
      const count = await OfflineQueueService.getCount();
      setOfflineCount(count);
      setLoggerBatchSize(busEventLogger.getBatchSize());
    };
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, []);

  // Stream live events via onEvent callback
  useEffect(() => {
    if (isPaused) return;

    const unsub = masterBus.onEvent((entry) => {
      setEventLog((prev) => {
        const next = [
          ...prev,
          {
            id: entry.id,
            type: entry.type,
            payload: entry.payload,
            timestamp: entry.timestamp,
          },
        ];
        // Keep last 200
        return next.slice(-200);
      });
    });

    // Load existing log
    const existing = masterBus.getEventLog();
    setEventLog(
      existing.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        timestamp: e.timestamp,
      }))
    );

    return unsub;
  }, [isPaused]);

  // Auto-scroll on new events
  useEffect(() => {
    if (!isPaused) scrollToBottom();
  }, [eventLog.length, isPaused, scrollToBottom]);

  const filteredLog = filter === 'all' ? eventLog : eventLog.filter((e) => e.type === filter);

  const eventTypes = [...new Set(eventLog.map((e) => e.type))].sort();

  const handleEmitTest = (type: BusEventType) => {
    const payloads: Record<string, unknown> = {
      AUTH_STATE_CHANGED: { userId: 'test-user', isAuthenticated: true },
      BALANCE_UPDATED: { source: 'devtools-test' },
      CLUB_JOINED: { clubId: 'test-club', clubName: 'DevTools Test Club' },
      TABLE_SEATED: { tableId: 'test-table', seat: 1 },
      NOTIFICATION_READ: { notifId: 'test-notif', allRead: false },
    };
    (masterBus as any).emit(type, payloads[type] || {});
  };

  const handleClearLog = () => {
    masterBus.clearEventLog();
    setEventLog([]);
  };

  const handleClearOfflineQueue = async () => {
    await OfflineQueueService.clearAll();
    setOfflineCount(0);
  };

  const subscriberEntries = diagnostics
    ? Object.entries(diagnostics.subscribers).sort((a, b) => b[1] - a[1])
    : [];
  const maxSubscribers = Math.max(1, ...subscriberEntries.map(([, v]) => v));

  if (isAdmin === null)
    return (
      <div
        style={{
          padding: 40,
          color: '#aaa',
          background: '#111',
          minHeight: '100vh',
          fontFamily: 'monospace',
        }}
      >
        Checking Access...
      </div>
    );
  if (!isAdmin)
    return (
      <div
        style={{
          padding: 40,
          color: '#FA383E',
          background: '#111',
          minHeight: '100vh',
          fontFamily: 'monospace',
        }}
      >
        <h2>Access Denied</h2>
        <p>Admin Or Owner Role Required To View Bus DevTools.</p>
      </div>
    );

  return (
    <div className="bus-devtools">
      <header className="bdt-header">
        <div className="bdt-title-row">
          <h1>MasterBus DevTools</h1>
          <div className="bdt-status-pills">
            <span className={`bdt-pill ${diagnostics?.initialized ? 'green' : 'red'}`}>
              {diagnostics?.initialized ? '● ONLINE' : '● OFFLINE'}
            </span>
            <span className="bdt-pill blue">{diagnostics?.channels.length || 0} Channels</span>
            <span className="bdt-pill purple">
              {subscriberEntries.reduce((s, [, v]) => s + v, 0)} Subscribers
            </span>
          </div>
        </div>
      </header>

      {/* ═══ TOP ROW: Stats Cards ═══ */}
      <div className="bdt-stats-grid">
        <div className="bdt-stat-card">
          <span className="bdt-stat-icon">◉</span>
          <div className="bdt-stat-value">{diagnostics?.channels.length || 0}</div>
          <div className="bdt-stat-label">Active Channels</div>
        </div>
        <div className="bdt-stat-card">
          <span className="bdt-stat-icon">◉</span>
          <div className="bdt-stat-value">{subscriberEntries.reduce((s, [, v]) => s + v, 0)}</div>
          <div className="bdt-stat-label">Event Subscribers</div>
        </div>
        <div className="bdt-stat-card">
          <span className="bdt-stat-icon">◷</span>
          <div className="bdt-stat-value">{diagnostics?.pendingTimers || 0}</div>
          <div className="bdt-stat-label">Pending Debounce</div>
        </div>
        <div className="bdt-stat-card">
          <span className="bdt-stat-icon">▣</span>
          <div className="bdt-stat-value">{offlineCount}</div>
          <div className="bdt-stat-label">Offline Queue</div>
        </div>
        <div className="bdt-stat-card">
          <span className="bdt-stat-icon">▤</span>
          <div className="bdt-stat-value">{loggerBatchSize}</div>
          <div className="bdt-stat-label">Logger Batch</div>
        </div>
        <div className="bdt-stat-card">
          <span className="bdt-stat-icon">◇</span>
          <div className="bdt-stat-value">{diagnostics?.channelFactories || 0}</div>
          <div className="bdt-stat-label">Recovery Factories</div>
        </div>
      </div>

      {/* ═══ MAIN: Two-column layout ═══ */}
      <div className="bdt-main-grid">
        {/* LEFT: Event Log */}
        <div className="bdt-panel bdt-event-log">
          <div className="bdt-panel-header">
            <h2>Live Event Log</h2>
            <div className="bdt-log-controls">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="bdt-select"
              >
                <option value="all">All Events ({eventLog.length})</option>
                {eventTypes.map((t) => (
                  <option key={t} value={t}>
                    {t} ({eventLog.filter((e) => e.type === t).length})
                  </option>
                ))}
              </select>
              <button
                className={`bdt-btn ${isPaused ? 'bdt-btn-green' : 'bdt-btn-yellow'}`}
                onClick={() => setIsPaused(!isPaused)}
              >
                {isPaused ? '▶ Resume' : 'Pause'}
              </button>
              <button className="bdt-btn bdt-btn-red" onClick={handleClearLog}>
                ✕ Clear
              </button>
            </div>
          </div>
          <div className="bdt-log-scroll">
            {filteredLog.length === 0 ? (
              <div className="bdt-empty">
                No Events Yet - Interact With The App To See Events Flow
              </div>
            ) : (
              filteredLog.map((entry) => (
                <div key={entry.id} className="bdt-log-entry">
                  <span className="bdt-log-time">{formatTime(entry.timestamp)}</span>
                  <span className="bdt-log-type">{entry.type}</span>
                  <span className="bdt-log-payload">
                    {JSON.stringify(entry.payload).slice(0, 120)}
                  </span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* RIGHT: Channels + Subscribers */}
        <div className="bdt-right-col">
          {/* Channel Registry */}
          <div className="bdt-panel bdt-channels">
            <h2>Channel Registry</h2>
            <div className="bdt-channel-list">
              {diagnostics?.channels.length === 0 ? (
                <div className="bdt-empty">No Channels Registered</div>
              ) : (
                diagnostics?.channels.map((ch) => (
                  <div key={ch.key} className="bdt-channel-row">
                    <span
                      className="bdt-channel-dot"
                      style={{ background: STATE_COLORS[ch.state] || STATE_COLORS.unknown }}
                    />
                    <span className="bdt-channel-key">{ch.key}</span>
                    <span
                      className="bdt-channel-state"
                      style={{ color: STATE_COLORS[ch.state] || STATE_COLORS.unknown }}
                    >
                      {ch.state}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Subscriber Bar Chart */}
          <div className="bdt-panel bdt-subscribers">
            <h2>Subscribers Per Event</h2>
            <div className="bdt-sub-chart">
              {subscriberEntries.length === 0 ? (
                <div className="bdt-empty">No Subscribers</div>
              ) : (
                subscriberEntries.map(([event, count]) => (
                  <div key={event} className="bdt-sub-row">
                    <span className="bdt-sub-label">{event}</span>
                    <div className="bdt-sub-bar-bg">
                      <div
                        className="bdt-sub-bar-fill"
                        style={{ width: `${(count / maxSubscribers) * 100}%` }}
                      />
                    </div>
                    <span className="bdt-sub-count">{count}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Test Emitter */}
          <div className="bdt-panel bdt-test">
            <h2>Test Event Emitter</h2>
            <div className="bdt-test-grid">
              {TEST_EVENTS.map((te) => (
                <button
                  key={te.type}
                  className="bdt-btn bdt-btn-blue"
                  onClick={() => handleEmitTest(te.type)}
                >
                  Emit {te.label}
                </button>
              ))}
              <button
                className="bdt-btn bdt-btn-red"
                onClick={handleClearOfflineQueue}
                disabled={offlineCount === 0}
              >
                Clear Offline Queue ({offlineCount})
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
