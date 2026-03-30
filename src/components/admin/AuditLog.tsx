/**
 * ♠ CLUB ARENA — Audit Log
 * Track all admin actions in the club
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { formatDateTime as formatTime } from '../../lib/date';
import { supabase } from '../../lib/supabase';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './AuditLog.css';

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
  player: ['player', 'ban', 'kick', 'mute', 'unmute', 'role_change'],
  table: ['table', 'seat', 'game'],
  finance: ['balance', 'deposit', 'withdraw', 'transfer', 'settlement', 'rake'],
  settings: ['settings', 'config', 'update_club'],
  security: ['login', 'security', 'password', 'ip', 'auth'],
};

interface AuditLogProps {
  clubId: string;
}

export const AuditLog: React.FC<AuditLogProps> = ({ clubId }) => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<ActionType>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const loadAuditLog = useCallback(async () => {
    setLoading(true);
    // Clear any existing stagger timers
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = [];

    try {
      const query = supabase
        .from('club_arena_audit_logs')
        .select('id, action, actor_id, target_type, target_id, details, ip_address, created_at')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(200);

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
          .select('id, username, display_name')
          .in('id', userIds);
        if (!isMounted.current) return;
        (profiles || []).forEach((p: any) => {
          profileMap[p.id] = p.display_name || p.username || p.id.slice(0, 8);
        });
      }

      const mapped: AuditEntry[] = (data || []).map((row: any) => {
        const meta = row.details || {};
        const detailStr =
          meta.description ||
          meta.reason ||
          (meta.amount != null ? `Amount: ${meta.amount}` : (row.action || '').replace(/_/g, ' '));
        return {
          id: row.id,
          action: row.action || '',
          actor: {
            id: row.actor_id || 'system',
            username: profileMap[row.actor_id] || 'System',
          },
          target: row.target_id
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
      console.error('Failed to load audit log:', error);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, isMounted]);

  useEffect(() => {
    loadAuditLog();
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, [loadAuditLog]);

  // Auto-refresh when admin actions fire from other components
  useMasterBusSubscription('ADMIN_ACTION', () => {
    if (isMounted.current) loadAuditLog();
  });

  const getActionIcon = (action: string) => {
    if (action.includes('banned')) return '🚫';
    if (action.includes('table')) return '🎰';
    if (action.includes('balance') || action.includes('finance')) return '💰';
    if (action.includes('settings')) return '⚙️';
    if (action.includes('security') || action.includes('login')) return '🔐';
    return '📋';
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
        <h2>📋 Audit Log</h2>
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
          placeholder="Search logs..."
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
            <span>📋</span>
            <p>No log entries found</p>
          </div>
        ) : (
          filteredEntries.map((entry, i) => (
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
          ))
        )}
      </div>
    </div>
  );
};

export default AuditLog;
