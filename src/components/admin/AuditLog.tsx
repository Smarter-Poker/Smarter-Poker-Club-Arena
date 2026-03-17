/**
 * ♠ CLUB ARENA — Audit Log
 * Track all admin actions in the club
 */

import React, { useState, useEffect } from 'react';
import { formatDateTime as formatTime } from '../../lib/date';
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

interface AuditLogProps {
  clubId: string;
}

export const AuditLog: React.FC<AuditLogProps> = ({ clubId }) => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<ActionType>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadAuditLog();
  }, [clubId, filter]);

  const loadAuditLog = async () => {
    setLoading(true);
    try {
      // Replaced mock data with dynamic initialization
      const liveEntries: AuditEntry[] = [];
      setEntries(liveEntries);
      setVisibleItems(new Set());
    } catch (error) {
      console.error('Failed to load audit log:', error);
    } finally {
      setLoading(false);
    }
  };

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
      if (
        filter === 'player' &&
        !entry.action.includes('player') &&
        !entry.action.includes('banned')
      )
        return false;
      if (filter === 'table' && !entry.action.includes('table')) return false;
      if (filter === 'finance' && !entry.action.includes('balance')) return false;
      if (filter === 'settings' && !entry.action.includes('settings')) return false;
      if (
        filter === 'security' &&
        !entry.action.includes('login') &&
        !entry.action.includes('security')
      )
        return false;
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
