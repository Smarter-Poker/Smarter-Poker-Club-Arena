/**
 * ♠ CLUB ARENA — Audit Log
 * Track all admin actions in the club
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { formatDateTime as formatTime } from '../../lib/date';
import { supabase } from '../../lib/supabase';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { masterBus } from '../../core/MasterBus';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './AuditLog.css';
import { reportError } from '../../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

interface AuditEntry {
  id: string;
  action: string;
  actor: { id: string; username: string };
  target?: { type: string; id: string; name: string };
  details: string;
  ipAddress: string;
  timestamp: string;
}

type ActionType = 'all' | 'player' | 'table' | 'finance' | 'settings' | 'security';

/** Map filter category to action_type prefixes in the audit_logs table */
const FILTER_PREFIXES: Record<ActionType, string[]> = {
  all: [],
  // These are substring matches against the action name. The audit triggers
  // write update_club_settings / delete_club / role_change / banned /
  // unban_member / member_status_change / kick_member / member_left —
  // 'delete_club' and 'member_left' matched no category and were visible
  // only under All.
  player: [
    'player',
    'ban',
    'kick',
    'mute',
    'unmute',
    'role_change',
    'member_left',
    'member_status',
  ],
  table: ['table', 'seat', 'game'],
  finance: ['balance', 'deposit', 'withdraw', 'transfer', 'settlement', 'rake'],
  settings: ['settings', 'config', 'update_club', 'delete_club'],
  security: ['login', 'security', 'password', 'ip', 'auth'],
};

/** Rows fetched per page. The log used to stop dead at 200 with no way to
 *  reach anything older; now this is a page size and the UI offers Load more. */
const AUDIT_PAGE_SIZE = 200;

interface AuditLogProps {
  clubId: string;
}

export const AuditLog: React.FC<AuditLogProps> = ({ clubId }) => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<ActionType>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [hasMore, setHasMore] = useState(false);
  const [loadedLimit, setLoadedLimit] = useState(AUDIT_PAGE_SIZE);
  // loadAuditLog is a stable useCallback, so it cannot close over the current
  // page size. Without this ref every background refresh (realtime INSERT,
  // ADMIN_ACTION) re-fetched the default page and silently collapsed a list
  // the user had expanded with Load more.
  const loadedLimitRef = useRef(AUDIT_PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const loadAuditLog = useCallback(
    async (opts?: { silent?: boolean; limit?: number }) => {
      // A background refresh (realtime INSERT, ADMIN_ACTION bus event) must not
      // tear the rendered list down to skeleton rows — the log visibly flashed
      // every time an admin action landed.
      if (!opts?.silent) setLoading(true);
      // Clear any existing stagger timers
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];

      try {
        // club_id is a uuid column but the route param may be the 6-digit
        // integer club code — filtering the uuid column with it is a 22P02
        // error and the log silently rendered empty for those URLs.
        const resolvedId = await resolveClubUUID(clubId);
        const query = supabase
          .from('audit_trail')
          .select(
            'id, action, actor_id, target_type, target_id, before_state, details:after_state, ip_address, created_at'
          )
          .eq('club_id', resolvedId)
          .order('created_at', { ascending: false })
          .limit(opts?.limit ?? loadedLimitRef.current);

        const { data, error } = await query;
        if (error) {
          // Gracefully handle missing table or column errors
          if (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703') {
            console.debug('[AuditLog] audit_logs table/column not available yet.');
            if (isMounted.current) {
              setEntries([]);
              setLoading(false);
            }
            return;
          }
          throw error;
        }
        if (!isMounted.current) return;

        // Resolve usernames for actors and targets
        const userIds = [
          ...new Set(
            (data || []).flatMap((row: any) => [row.actor_id, row.target_id]).filter(Boolean)
          ),
        ];
        const profileMap: Record<string, string> = {};
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .in('id', userIds);
          if (!isMounted.current) return;
          (profiles || []).forEach((p: any) => {
            profileMap[p.id] = playerDisplayName(p);
          });
        }

        const mapped: AuditEntry[] = (data || []).map((row: any) => {
          const meta = row.details || {};
          const before = row.before_state || {};
          // 2026-08-19: settings rows carry the changed-fields diff in
          // before_state/after_state. Falling through to meta.description here
          // printed the club's new DESCRIPTION text as the log line.
          const fmtVal = (v: unknown) => {
            if (v === null || v === undefined) return 'unset';
            if (typeof v === 'boolean') return v ? 'on' : 'off';
            const str = String(v);
            return str.length > 24 ? `${str.slice(0, 24)}…` : str;
          };
          const diffLine = (keys: string[]) =>
            keys
              .map((k) => `${k.replace(/_/g, ' ')}: ${fmtVal(before[k])} → ${fmtVal(meta[k])}`)
              .join(', ');
          let detailStr: string;
          if (row.action === 'update_club_settings') {
            const keys = Object.keys(meta);
            const shown = keys.slice(0, 3);
            const extra = keys.length - shown.length;
            detailStr =
              keys.length > 0
                ? diffLine(shown) + (extra > 0 ? ` (+${extra} more)` : '')
                : 'Settings updated';
          } else if (row.action === 'role_change' || row.action === 'member_status_change') {
            detailStr = diffLine(Object.keys(meta)) || (row.action || '').replace(/_/g, ' ');
          } else if (row.action === 'kick_member' || row.action === 'member_left') {
            detailStr = before.role
              ? `was ${fmtVal(before.role)} (${fmtVal(before.status)})`
              : (row.action || '').replace(/_/g, ' ');
          } else {
            detailStr =
              meta.description ||
              meta.reason ||
              (meta.amount != null
                ? `Amount: ${meta.amount}`
                : (row.action || '').replace(/_/g, ' '));
          }
          return {
            id: row.id,
            action: row.action || '',
            actor: {
              id: row.actor_id || 'system',
              username: profileMap[row.actor_id] || 'System',
            },
            target:
              row.target_id && row.target_type !== 'club'
                ? {
                    type: row.target_type || 'user',
                    id: row.target_id,
                    name: profileMap[row.target_id] || row.target_id.slice(0, 8),
                  }
                : undefined,
            details: detailStr,
            ipAddress: row.ip_address || '',
            timestamp: row.created_at,
          };
        });

        if (!isMounted.current) return;
        // A full page back means there is probably another page behind it.
        const effectiveLimit = opts?.limit ?? loadedLimitRef.current;
        setHasMore(mapped.length >= effectiveLimit);
        loadedLimitRef.current = effectiveLimit;
        setLoadedLimit(effectiveLimit);
        setEntries(mapped);
        setVisibleItems(new Set());

        // Stagger visibility with cleanup
        staggerTimersRef.current = mapped.map((_, i) =>
          setTimeout(() => {
            if (isMounted.current) {
              setVisibleItems((prev) => new Set([...prev, i]));
            }
          }, i * 15)
        );
      } catch (error) {
        reportError(error, 'AuditLog.Failed_to_load_audit_log');
      } finally {
        if (isMounted.current) setLoading(false);
      }
    },
    [clubId, isMounted]
  );

  useEffect(() => {
    loadedLimitRef.current = AUDIT_PAGE_SIZE;
    loadAuditLog({ limit: AUDIT_PAGE_SIZE });
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, [loadAuditLog]);

  // Auto-refresh when admin actions fire from other components
  useMasterBusSubscription('ADMIN_ACTION', () => {
    if (isMounted.current) loadAuditLog({ silent: true });
  });

  // Realtime: rows written by other admins / other devices appear without a
  // manual refresh. audit_trail is in the supabase_realtime publication and
  // postgres_changes applies the owner-read RLS policy server-side.
  useEffect(() => {
    let cancelled = false;
    const channelKey = `audit-log-${clubId}`;
    (async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (cancelled) return;
      masterBus
        .getOrCreateChannel(channelKey)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'audit_trail',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            if (isMounted.current) loadAuditLog({ silent: true });
          }
        )
        .subscribe();
    })().catch((e) => console.warn('[AuditLog] Realtime setup failed:', e));
    return () => {
      cancelled = true;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadAuditLog, isMounted]);

  const getActionIcon = (action: string) => {
    if (action.includes('banned')) return '⊘';
    if (action.includes('table')) return '▦';
    if (action.includes('balance') || action.includes('finance')) return '◆';
    if (action.includes('settings')) return '◇';
    if (action.includes('security') || action.includes('login')) return '◈';
    return '▤';
  };

  const filteredEntries = entries.filter((entry) => {
    if (filter !== 'all') {
      const prefixes = FILTER_PREFIXES[filter] || [];
      const actionLower = entry.action.toLowerCase();
      const matchesFilter = prefixes.some((prefix) => actionLower.includes(prefix));
      if (!matchesFilter) return false;
    }
    if (search) {
      const searchLower = search.toLowerCase();
      return (
        entry.action.toLowerCase().includes(searchLower) ||
        entry.actor.username.toLowerCase().includes(searchLower) ||
        entry.details.toLowerCase().includes(searchLower) ||
        entry.target?.name?.toLowerCase()?.includes(searchLower)
      );
    }
    return true;
  });

  return (
    <div className="audit-log">
      <div className="log-header">
        <h2>Audit Log</h2>
      </div>

      {/* Filters */}
      <div className="log-filters">
        <div className="action-filters">
          {(['all', 'player', 'table', 'finance', 'settings', 'security'] as ActionType[]).map(
            (f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            )
          )}
        </div>
        <input
          type="text"
          placeholder="Search Logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
      </div>

      {/* Log Entries */}
      <div className="log-entries">
        {loading ? (
          <div className="loading-state">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton-row" />
            ))}
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="empty-state">
            <span>▤</span>
            <p>
              {entries.length === 0
                ? 'No Admin Actions Recorded Yet'
                : 'No Log Entries Match This Filter'}
            </p>
          </div>
        ) : (
          <>
            <p className="audit-log__summary">
              Showing {filteredEntries.length}
              {filteredEntries.length !== entries.length ? ` Of ${entries.length}` : ''} Entr
              {filteredEntries.length === 1 ? 'y' : 'ies'}
              {hasMore ? ' (Newest First)' : ''}
            </p>
            {filteredEntries.map((entry, i) => (
              <div
                key={entry.id}
                className="log-entry"
                style={{
                  opacity: visibleItems.has(i) ? 1 : 0,
                  transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <span className="entry-icon">{getActionIcon(entry.action)}</span>
                <div className="entry-content">
                  <div className="entry-header">
                    <span className="entry-action">{entry.action.replace(/_/g, ' ')}</span>
                    <span className="entry-time">{formatTime(entry.timestamp)}</span>
                  </div>
                  <p className="entry-details">{entry.details}</p>
                  <div className="entry-meta">
                    <span>
                      By: <strong>{entry.actor.username}</strong>
                    </span>
                    {entry.target && (
                      <span>
                        Target: <strong>{entry.target.name}</strong>
                      </span>
                    )}
                    <span className="entry-ip">{entry.ipAddress}</span>
                  </div>
                </div>
              </div>
            ))}
            {hasMore && (
              <button
                type="button"
                className="audit-log__more"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  await loadAuditLog({ silent: true, limit: loadedLimit + AUDIT_PAGE_SIZE });
                  if (isMounted.current) setLoadingMore(false);
                }}
              >
                {loadingMore ? 'Loading...' : `Load ${AUDIT_PAGE_SIZE} Older Entries`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AuditLog;
