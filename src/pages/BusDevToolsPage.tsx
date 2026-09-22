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
 *
 * #ClubArenaConsole: one console. The six figures print as rows on the black
 * glass (label in lit blue, value in silver), the live log, the channel
 * registry and the subscriber counts as rows between engraved rules, the
 * test emitters as lit words, and the two painted plates carry Pause /
 * Resume and Clear Log. Every timer, stream, filter, ref and handler of the
 * generic page is kept; only the paint changed.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { masterBus, type BusEventType } from '../core/MasterBus';
import { OfflineQueueService } from '../services/OfflineQueueService';
import { busEventLogger } from '../services/BusEventLogger';
import { formatRelativeShort as formatTime } from '@/lib/date';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { titleCase } from '../utils/titleCase';
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

/* A channel's state prints in the master's own ink: green while it is
   joined, red once it has closed or errored, gold while it is leaving. */
const STATE_INK: Record<string, string> = {
  joined: 'sc-ink--green',
  subscribed: 'sc-ink--green',
  closed: 'sc-ink--red',
  errored: 'sc-ink--red',
  leaving: 'sc-ink--gold',
  unknown: 'sc-ink--muted',
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

  const subscriberTotal = subscriberEntries.reduce((sum, [, v]) => sum + v, 0);
  const online = Boolean(diagnostics?.initialized);

  if (isAdmin === null)
    return (
      <div className="bus-devtools">
        <SpadeConsole
          className="bdt__console"
          eyebrow="Admin Diagnostics"
          title="MasterBus DevTools"
          titleId="bus-devtools-title"
          pill="Checking"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center bdt__state" aria-busy="true">
            Checking Access...
          </p>
        </SpadeConsole>
      </div>
    );
  if (!isAdmin)
    return (
      <div className="bus-devtools">
        <SpadeConsole
          className="bdt__console"
          eyebrow="Admin Diagnostics"
          title="Access Denied"
          titleId="bus-devtools-title"
          pill="Staff"
          pillInk="red"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center bdt__state">
            Admin Or Owner Role Required To View Bus DevTools.
          </p>
        </SpadeConsole>
      </div>
    );

  return (
    <div className="bus-devtools">
      <SpadeConsole
        className="bdt__console"
        eyebrow="Admin Diagnostics"
        title="MasterBus DevTools"
        titleId="bus-devtools-title"
        pill={online ? 'Online' : 'Offline'}
        pillInk={online ? 'green' : 'red'}
        plates={{
          secondary: {
            label: isPaused ? 'Resume' : 'Pause',
            ink: isPaused ? 'green' : 'gold',
            onClick: () => setIsPaused(!isPaused),
          },
          primary: { label: 'Clear Log', ink: 'red', onClick: handleClearLog },
        }}
      >
        {/* ═══ Figures: rows on the glass ═══ */}
        <section className="bdt__section" aria-label="Bus Figures">
          <div className="bdt__row">
            <span className="bdt__row-label sc-ink--blue">Active Channels</span>
            <span className="bdt__row-value sc-ink--silver">
              {diagnostics?.channels.length || 0}
            </span>
          </div>
          <div className="bdt__row">
            <span className="bdt__row-label sc-ink--blue">Event Subscribers</span>
            <span className="bdt__row-value sc-ink--silver">{subscriberTotal}</span>
          </div>
          <div className="bdt__row">
            <span className="bdt__row-label sc-ink--blue">Pending Debounce</span>
            <span className="bdt__row-value sc-ink--silver">{diagnostics?.pendingTimers || 0}</span>
          </div>
          <div className="bdt__row">
            <span className="bdt__row-label sc-ink--blue">Offline Queue</span>
            <span className="bdt__row-value sc-ink--silver">{offlineCount}</span>
          </div>
          <div className="bdt__row">
            <span className="bdt__row-label sc-ink--blue">Logger Batch</span>
            <span className="bdt__row-value sc-ink--silver">{loggerBatchSize}</span>
          </div>
          <div className="bdt__row">
            <span className="bdt__row-label sc-ink--blue">Recovery Factories</span>
            <span className="bdt__row-value sc-ink--silver">
              {diagnostics?.channelFactories || 0}
            </span>
          </div>
        </section>

        {/* ═══ Live Event Log ═══ */}
        <section className="bdt__section" aria-labelledby="bdt-log-title">
          <div className="bdt__section-head">
            <h2 id="bdt-log-title" className="bdt__section-title sc-label sc-ink--silver">
              Live Event Log
            </h2>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bdt__field bdt__field--select"
              aria-label="Filter Events By Type"
            >
              <option value="all">All Events ({eventLog.length})</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {t} ({eventLog.filter((e) => e.type === t).length})
                </option>
              ))}
            </select>
          </div>
          <div className="bdt__log" aria-live="off">
            {filteredLog.length === 0 ? (
              <p className="sc-copy sc-copy--center bdt__state">
                No Events Yet - Interact With The App To See Events Flow
              </p>
            ) : (
              filteredLog.map((entry) => (
                <div key={entry.id} className="bdt__entry">
                  <span className="bdt__entry-time sc-ink--muted">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span className="bdt__entry-type sc-ink--blue">{entry.type}</span>
                  <code className="bdt__entry-payload">
                    {JSON.stringify(entry.payload).slice(0, 120)}
                  </code>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </section>

        {/* ═══ Channel Registry ═══ */}
        <section className="bdt__section" aria-labelledby="bdt-channels-title">
          <h2 id="bdt-channels-title" className="bdt__section-title sc-label sc-ink--silver">
            Channel Registry
          </h2>
          {diagnostics?.channels.length === 0 ? (
            <p className="sc-copy sc-copy--center bdt__state">No Channels Registered</p>
          ) : (
            diagnostics?.channels.map((ch) => (
              <div key={ch.key} className="bdt__row">
                <span className="bdt__row-key sc-ink--silver">{titleCase(ch.key)}</span>
                <span className={`bdt__row-state ${STATE_INK[ch.state] || STATE_INK.unknown}`}>
                  {titleCase(ch.state)}
                </span>
              </div>
            ))
          )}
        </section>

        {/* ═══ Subscribers Per Event ═══ */}
        <section className="bdt__section" aria-labelledby="bdt-subs-title">
          <h2 id="bdt-subs-title" className="bdt__section-title sc-label sc-ink--silver">
            Subscribers Per Event
          </h2>
          {subscriberEntries.length === 0 ? (
            <p className="sc-copy sc-copy--center bdt__state">No Subscribers</p>
          ) : (
            subscriberEntries.map(([event, count]) => (
              <div key={event} className="bdt__row">
                <span className="bdt__row-key sc-ink--blue">{event}</span>
                <span className="bdt__row-value sc-ink--silver">{count}</span>
              </div>
            ))
          )}
        </section>

        {/* ═══ Test Emitter ═══ */}
        <section className="bdt__section" aria-labelledby="bdt-test-title">
          <h2 id="bdt-test-title" className="bdt__section-title sc-label sc-ink--silver">
            Test Event Emitter
          </h2>
          <div className="bdt__emitters">
            {TEST_EVENTS.map((te) => (
              <button
                key={te.type}
                type="button"
                className="bdt-word sc-ink--white"
                onClick={() => handleEmitTest(te.type)}
              >
                Emit {te.label}
              </button>
            ))}
            <button
              type="button"
              className="bdt-word sc-ink--red"
              onClick={handleClearOfflineQueue}
              disabled={offlineCount === 0}
            >
              Clear Offline Queue ({offlineCount})
            </button>
          </div>
        </section>
      </SpadeConsole>
    </div>
  );
}
