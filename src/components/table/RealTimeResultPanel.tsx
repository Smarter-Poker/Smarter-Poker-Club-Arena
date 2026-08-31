/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REAL TIME RESULT — the in-game stats card (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, with a reference screenshot: "the stats card when you click the in game
 * stats card should look more like this and have these stats inside of it."
 *
 * The reference is a dense label/value ledger, not a dashboard, and that is the
 * point of it: a player opens this mid-session to answer flat factual questions
 * — how long has this table been running, what are the actual blinds, what have
 * I put in, what am I up or down — and every one of those is a row you can read
 * in a glance without parsing a chart.
 *
 * WHAT REPLACED WHAT
 *
 * SESSION_STATS used to open SessionAnalytics: a four-tab PokerCraft-style
 * panel with a P&L trajectory, position breakdowns and action-frequency pies.
 * That panel is good and it is still reachable — the "Detailed Analytics"
 * button at the foot of this card opens it. It is simply not the thing you want
 * first. This is.
 *
 * LIVE VALUES
 *
 * The clock, the running time and the extension countdown tick every second off
 * a single interval that only runs while the card is open. Everything else is
 * either static table metadata (fetched once on open) or session stats that
 * arrive on the bus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { readLocalSession } from '../../lib/authUtils';
import { reportError } from '../../utils/errorReporter';
import { sessionStatsService, type SessionStats } from '../../services/SessionStatsService';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './RealTimeResultPanel.css';

export interface RealTimeResultPanelProps {
  isOpen: boolean;
  onClose: () => void;
  tableId: string;
  userId: string;
  initialStack: number;
  bigBlind: number;
  /** Opens the deeper PokerCraft-style panel. Omit to hide the button. */
  onOpenDetailed?: () => void;
}

interface TableMeta {
  createdAt: number | null;
  variant: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  minBuyIn: number;
  maxBuyIn: number;
  gpsRestricted: boolean;
  ipRestricted: boolean;
  deviceRestricted: boolean;
  /** Scheduled table length in hours. null = runs until it empties. */
  lengthHours: number | null;
}

/** HH:MM:SS from a millisecond span. Never negative. */
function hhmmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** "2026-08-20 14:53:31" — the reference's creation-timestamp format. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "20-Aug" */
function dayMon(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${d.toLocaleString('en-US', { month: 'short' })}`;
}

/**
 * A short, stable, numeric-looking id for a uuid-keyed table.
 *
 * The reference shows "Game ID: 45933317" — players quote these in support
 * threads and screenshots, so it has to be short enough to read aloud and the
 * SAME every time for a given table. A uuid is neither. FNV-1a over the uuid
 * gives a deterministic 8-digit number with no storage and no migration.
 */
function gameIdFor(uuid: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i++) {
    h ^= uuid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(10_000_000 + (h % 90_000_000));
}

function money(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function RealTimeResultPanel({
  isOpen,
  onClose,
  tableId,
  userId,
  initialStack,
  bigBlind,
  onOpenDetailed,
}: RealTimeResultPanelProps) {
  const [meta, setMeta] = useState<TableMeta | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const initialStackRef = useRef(initialStack);

  /* Same lifecycle contract SessionHUD had: TablePage owns the session while
     hero is seated, and this only reads. startSession is still called
     defensively when none exists — a panel opened from an observer seat should
     render honest zeros, not a null. */
  useEffect(() => {
    if (!isOpen || !tableId) return;
    if (!sessionStatsService.getStats(tableId)) {
      sessionStatsService.startSession(tableId, userId, initialStackRef.current, bigBlind);
    }
    setStats(sessionStatsService.getStats(tableId));
  }, [isOpen, tableId, userId, bigBlind]);

  /* The bus types SESSION_STATS_UPDATE.stats as Record<string, unknown> — it is
     a generic envelope shared by several producers. The only producer of this
     event is SessionStatsService, which puts a SessionStats in it, so read it
     back through the service rather than casting a Record into a shape it was
     never checked against. The payload is the signal; the service is the data. */
  useMasterBusSubscription('SESSION_STATS_UPDATE', (payload) => {
    if (payload?.tableId === tableId) setStats(sessionStatsService.getStats(tableId));
  });

  useMasterBusSubscription('HAND_COMPLETED', (payload) => {
    if ((payload as { tableId?: string })?.tableId === tableId) {
      setStats(sessionStatsService.getStats(tableId));
    }
  });
  const [now, setNow] = useState(() => Date.now());
  const [observers, setObservers] = useState<{ id: string; name: string }[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ── Table metadata: fetched once per open ──
  useEffect(() => {
    if (!isOpen || !tableId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('tables')
          .select(
            'created_at, game_variant, small_blind, big_blind, max_players, min_buy_in, max_buy_in, gps_restriction, ip_restriction, restrict_device, game_length_hours'
          )
          .eq('id', tableId)
          .maybeSingle();
        if (cancelled || !data) return;
        setMeta({
          createdAt: data.created_at ? new Date(data.created_at).getTime() : null,
          variant: String(data.game_variant || '').toUpperCase() || 'NLH',
          smallBlind: Number(data.small_blind) || 0,
          bigBlind: Number(data.big_blind) || 0,
          maxPlayers: Number(data.max_players) || 0,
          minBuyIn: Number(data.min_buy_in) || 0,
          maxBuyIn: Number(data.max_buy_in) || 0,
          gpsRestricted: !!data.gps_restriction,
          ipRestricted: !!data.ip_restriction,
          deviceRestricted: !!data.restrict_device,
          lengthHours: data.game_length_hours != null ? Number(data.game_length_hours) : null,
        });
      } catch (e) {
        reportError(e, 'RealTimeResultPanel.loadMeta');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, tableId]);

  // ── One clock, only while the card is open ──
  useEffect(() => {
    if (!isOpen) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isOpen]);

  /* ── Observers ──
     Realtime presence on the table channel. Anyone watching this table with the
     card open is tracked; the roster is whoever presence reports minus the
     player themselves. A complete roster of every silent watcher needs TablePage
     to join presence on mount for all viewers, which is a table-level change —
     until then this counts the watchers we can actually see, and never invents
     a number. */
  useEffect(() => {
    if (!isOpen || !tableId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // readLocalSession, not a GoTrue round trip: the house rule (enforced
        // by .husky/pre-push) is that no component blocks on the auth server
        // for an id the JWT already sitting in localStorage carries. Same
        // value, no network, no hang when GoTrue is slow.
        const uid = readLocalSession()?.userId;
        if (!uid || cancelled) return;
        const ch = supabase.channel(`table-observers-${tableId}`, {
          config: { presence: { key: uid } },
        });
        ch.on('presence', { event: 'sync' }, () => {
          const state = ch.presenceState() as Record<string, Array<{ name?: string }>>;
          const list = Object.entries(state)
            .filter(([id]) => id !== uid)
            .map(([id, metas]) => ({ id, name: metas?.[0]?.name || 'Observer' }));
          setObservers(list);
        });
        await ch.subscribe(async (status: string) => {
          if (status === 'SUBSCRIBED') await ch.track({ name: 'Observer' });
        });
        channelRef.current = ch;
      } catch (e) {
        reportError(e, 'RealTimeResultPanel.presence');
      }
    })();
    return () => {
      cancelled = true;
      const ch = channelRef.current;
      channelRef.current = null;
      if (ch) {
        try {
          supabase.removeChannel(ch);
        } catch {
          /* already gone */
        }
      }
    };
  }, [isOpen, tableId]);

  // Escape closes, like every other panel here.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const rows = useMemo(() => {
    const created = meta?.createdAt ?? null;

    // "20-Aug 50↓200↑ 7MAX"
    const gameName = [
      created ? dayMon(created) : dayMon(now),
      meta && (meta.minBuyIn || meta.maxBuyIn) ? `${meta.minBuyIn}↓${meta.maxBuyIn}↑` : null,
      meta?.maxPlayers ? `${meta.maxPlayers}MAX` : null,
    ]
      .filter(Boolean)
      .join(' ');

    /* Extension: how much of the scheduled length is left, in minutes. A table
       with no scheduled length runs until it empties — say so rather than
       printing a countdown to a deadline that does not exist. */
    let extension = 'Unlimited';
    if (meta?.lengthHours && created) {
      const endsAt = created + meta.lengthHours * 3600_000;
      const minsLeft = Math.max(0, Math.ceil((endsAt - now) / 60000));
      extension = minsLeft > 0 ? `Remaining:(${minsLeft})` : 'Expired';
    }

    const restrictions =
      [
        meta?.gpsRestricted ? 'GPS' : null,
        meta?.ipRestricted ? 'IP' : null,
        meta?.deviceRestricted ? 'Device' : null,
      ]
        .filter(Boolean)
        .join('&') || 'None';

    return [
      { label: 'Game Name', value: gameName || '-' },
      { label: 'Game ID', value: tableId ? gameIdFor(tableId) : '-' },
      { label: 'Table creation', value: created ? stamp(created) : '-' },
      { label: 'Running Time', value: created ? hhmmss(now - created) : '-' },
      { label: 'Extension Time', value: extension },
      { label: 'Table', value: meta?.variant || '-' },
      {
        label: 'Blinds',
        value: meta && meta.bigBlind ? `${meta.smallBlind}/${meta.bigBlind}` : '-',
      },
      { label: 'Restriction', value: restrictions },
    ];
  }, [meta, now, tableId]);

  const handleDetailed = useCallback(() => {
    onOpenDetailed?.();
  }, [onOpenDetailed]);

  if (!isOpen) return null;

  const winnings = stats?.profitLoss ?? 0;
  const clock = new Date(now).toLocaleTimeString('en-GB', { hour12: false });

  return (
    <div className="rtr" role="dialog" aria-modal="true" aria-label="Real Time Result">
      <div className="rtr__backdrop" onClick={onClose} />

      <div className="rtr__panel">
        {/* ── Header: live clock left, title right ── */}
        <div className="rtr__head">
          <span className="rtr__clock">{clock}</span>
          <span className="rtr__title">REAL TIME RESULT</span>
          <button className="rtr__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* ── Table facts ── */}
        <div className="rtr__rows">
          {rows.map((r) => (
            <div className="rtr__row" key={r.label}>
              <span className="rtr__label">{r.label}:</span>
              <span className="rtr__value">{r.value}</span>
            </div>
          ))}
        </div>

        {/* ── Profile data ── */}
        <div className="rtr__section">Profile Data</div>
        <div className="rtr__rows rtr__rows--wide">
          <div className="rtr__row">
            <span className="rtr__label">Buy-In</span>
            <span className="rtr__value">{money(stats?.buyInTotal ?? 0)}</span>
          </div>
          <div className="rtr__row">
            <span className="rtr__label">Winnings</span>
            <span
              className={`rtr__value ${winnings > 0 ? 'rtr__value--up' : winnings < 0 ? 'rtr__value--down' : ''}`}
            >
              {winnings > 0 ? '+' : ''}
              {money(winnings)}
            </span>
          </div>
          <div className="rtr__row">
            <span className="rtr__label">Current Table VPIP</span>
            <span className="rtr__value">{Math.round(stats?.vpipPercent ?? 0)}%</span>
          </div>
          <div className="rtr__row">
            <span className="rtr__label">Hands Played</span>
            <span className="rtr__value">{stats?.handsPlayed ?? 0}</span>
          </div>
          <div className="rtr__row">
            <span className="rtr__label">Hands/Hour</span>
            <span className="rtr__value">{Math.round(stats?.handsPerHour ?? 0)}</span>
          </div>
          <div className="rtr__row">
            <span className="rtr__label">BB Won</span>
            <span className="rtr__value">{(stats?.bigBlindsWon ?? 0).toFixed(1)}</span>
          </div>
        </div>

        {/* ── Observers ── */}
        <div className="rtr__section">Observers ({observers.length})</div>
        <div className="rtr__observers">
          {observers.length === 0 ? (
            <span className="rtr__empty">No One Is Watching This Table</span>
          ) : (
            observers.map((o) => (
              <span className="rtr__observer" key={o.id}>
                {o.name}
              </span>
            ))
          )}
        </div>

        {onOpenDetailed && (
          <button className="rtr__detailed" onClick={handleDetailed}>
            Detailed Analytics
          </button>
        )}
      </div>
    </div>
  );
}
