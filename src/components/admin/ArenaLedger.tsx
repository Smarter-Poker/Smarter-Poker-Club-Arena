/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ARENA LEDGER — Admin Audit-Log Stream
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `components/commander/admin/ArenaLedger.jsx`.
 *
 * Displays a real-time feed of `audit_trail` and `club_arena_messages`
 * with filtering, search, and live streaming via Supabase Realtime.
 *
 * Used in: Commander admin panels, Financial Admin Hub
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { formatDateTime } from '../../lib/date';
import './ArenaLedger.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface LedgerEntry {
  id: string;
  type: 'audit' | 'message';
  action?: string;
  content?: string;
  userId?: string;
  userName?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface ArenaLedgerProps {
  clubId?: string;
  maxEntries?: number;
}

// Map actions to visual branding
const ACTION_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  chip_mint: { icon: '◉', color: '#22C55E', label: 'Chip Mint' },
  chip_transfer: { icon: '→', color: '#3B82F6', label: 'Chip Transfer' },
  chip_distribute: { icon: '◈', color: '#8B5CF6', label: 'Distribution' },
  buyin: { icon: '▦', color: '#F59E0B', label: 'Buy-In' },
  cashout: { icon: '◆', color: '#10B981', label: 'Cash-Out' },
  settlement: { icon: '▦', color: '#6366F1', label: 'Settlement' },
  rake: { icon: '▦', color: '#EC4899', label: 'Rake Collected' },
  promo: { icon: '★', color: '#A855F7', label: 'Promo' },
  commission: { icon: '▲', color: '#14B8A6', label: 'Commission' },
  member_join: { icon: '◉', color: '#06B6D4', label: 'Member Joined' },
  member_leave: { icon: '◆', color: '#EF4444', label: 'Member Left' },
  role_change: { icon: '◈', color: '#F97316', label: 'Role Change' },
  message: { icon: '◉', color: '#64748B', label: 'Message' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function ArenaLedger({ clubId, maxEntries = 200 }: ArenaLedgerProps) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLive, setIsLive] = useState(true);
  const isMounted = useIsMounted();

  // ── Fetch initial data ──────────────────────────────────────────────────────
  const fetchEntries = useCallback(async () => {
    if (!clubId) return;
    setLoading(true);

    try {
      // Fetch audit logs
      const { data: auditData } = await supabase
        .from('audit_trail')
        .select('id, action, actor_id, details:after_state, created_at')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(maxEntries);

      // Fetch messages
      const { data: msgData } = await supabase
        .from('messages')
        .select('id, content, sender_id, created_at')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(50);

      const auditEntries: LedgerEntry[] = (auditData || []).map((a) => ({
        id: `audit-${a.id}`,
        type: 'audit' as const,
        action: a.action,
        userId: a.actor_id,
        metadata:
          typeof a.details === 'object' ? (a.details as Record<string, unknown>) : undefined,
        createdAt: a.created_at,
      }));

      const msgEntries: LedgerEntry[] = (msgData || []).map((m) => ({
        id: `msg-${m.id}`,
        type: 'message' as const,
        content: m.content,
        userId: m.sender_id,
        createdAt: m.created_at,
      }));

      // Combine and sort by time (newest first)
      const combined = [...auditEntries, ...msgEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      if (isMounted.current) setEntries(combined.slice(0, maxEntries));
    } catch (err) {
      reportError(err, 'ArenaLedger.Fetch_error');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, maxEntries]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // ── Realtime subscriptions ──────────────────────────────────────────────────
  useEffect(() => {
    if (!clubId || !isLive) return;

    const channelKey = `arena-ledger-${clubId}`;
    const channel = masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'audit_trail',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          if (!isMounted.current) return;
          const a = payload.new;
          const entry: LedgerEntry = {
            id: `audit-${a.id}`,
            type: 'audit',
            action: a.action,
            userId: a.actor_id,
            metadata:
              typeof a.details === 'object' ? (a.details as Record<string, unknown>) : undefined,
            createdAt: a.created_at,
          };
          setEntries((prev) => [entry, ...prev].slice(0, maxEntries));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          if (!isMounted.current) return;
          const m = payload.new;
          const entry: LedgerEntry = {
            id: `msg-${m.id}`,
            type: 'message',
            content: m.content,
            userId: m.sender_id,
            createdAt: m.created_at,
          };
          setEntries((prev) => [entry, ...prev].slice(0, maxEntries));
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'ArenaLedger._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[ArenaLedger] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, isLive, maxEntries]);

  // ── Filtering ───────────────────────────────────────────────────────────────
  const filteredEntries = entries.filter((e) => {
    if (filter !== 'all') {
      if (filter === 'messages' && e.type !== 'message') return false;
      if (filter === 'audits' && e.type !== 'audit') return false;
      if (filter !== 'messages' && filter !== 'audits' && e.action !== filter) return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const searchable = [e.userName, e.action, e.content, JSON.stringify(e.metadata)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="arena-ledger">
      {/* Header */}
      <div className="arena-ledger__header">
        <div className="arena-ledger__title">
          <span className="arena-ledger__title-icon">▤</span>
          <span>Arena Ledger</span>
          {isLive && <span className="arena-ledger__live-dot" />}
        </div>
        <div className="arena-ledger__controls">
          <button
            className={`arena-ledger__toggle ${isLive ? 'arena-ledger__toggle--active' : ''}`}
            onClick={() => setIsLive(!isLive)}
          >
            {isLive ? 'Pause' : '▶ Live'}
          </button>
          <button className="arena-ledger__refresh" onClick={fetchEntries}>
            ↻
          </button>
        </div>
      </div>

      {/* Search + Filter */}
      <div className="arena-ledger__filters">
        <input
          className="arena-ledger__search"
          type="text"
          placeholder="Search Ledger..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select
          className="arena-ledger__filter-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All Events</option>
          <option value="audits">Audit Logs</option>
          <option value="messages">Messages</option>
          <option value="chip_mint">Chip Mints</option>
          <option value="chip_transfer">Transfers</option>
          <option value="buyin">Buy-Ins</option>
          <option value="cashout">Cash-Outs</option>
          <option value="settlement">Settlements</option>
          <option value="rake">Rake</option>
        </select>
      </div>

      {/* Entries */}
      <div className="arena-ledger__list">
        {loading ? (
          <div className="arena-ledger__loading">Loading Ledger...</div>
        ) : filteredEntries.length === 0 ? (
          <div className="arena-ledger__empty">No Matching Ledger Entries</div>
        ) : (
          filteredEntries.map((entry) => {
            const config =
              entry.type === 'message'
                ? ACTION_CONFIG.message
                : ACTION_CONFIG[entry.action || ''] || {
                    icon: '▤',
                    color: '#64748B',
                    label: entry.action || 'Event',
                  };

            return (
              <div key={entry.id} className="arena-ledger__entry">
                <div
                  className="arena-ledger__entry-icon"
                  style={{ backgroundColor: `${config.color}18` }}
                >
                  <span>{config.icon}</span>
                </div>
                <div className="arena-ledger__entry-body">
                  <div className="arena-ledger__entry-header">
                    <span className="arena-ledger__entry-label" style={{ color: config.color }}>
                      {config.label}
                    </span>
                    <span className="arena-ledger__entry-time">
                      {formatDateTime(entry.createdAt, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="arena-ledger__entry-detail">
                    {entry.userName && (
                      <span className="arena-ledger__entry-user">{entry.userName}</span>
                    )}
                    {entry.content && (
                      <span className="arena-ledger__entry-content">{entry.content}</span>
                    )}
                    {entry.metadata && typeof entry.metadata === 'object' && (
                      <span className="arena-ledger__entry-meta">
                        {Object.entries(entry.metadata)
                          .filter(([, v]) => v !== null && v !== undefined)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="arena-ledger__footer">
        {filteredEntries.length} Of {entries.length} Events
        {isLive && <span className="arena-ledger__footer-live"> · Live Streaming</span>}
      </div>
    </div>
  );
}
