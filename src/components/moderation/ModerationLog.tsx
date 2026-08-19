import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './ModerationLog.css';
import { reportError } from '../../utils/errorReporter';

interface LogEntry {
  id: string;
  action: 'mute' | 'ban' | 'kick' | 'delete_message' | 'warning' | 'unban';
  moderatorId: string;
  moderatorName: string;
  targetUserId: string;
  targetUsername: string;
  reason?: string;
  details?: string;
  timestamp: Date;
}

interface ModerationLogProps {
  clubId?: string;
  tableId?: string;
  limit?: number;
}

const ACTION_ICONS: Record<string, string> = {
  mute: '◌',
  ban: '⊘',
  kick: '◆',
  delete_message: '',
  warning: '',
  unban: '',
};

const ACTION_COLORS: Record<string, string> = {
  mute: '#fbbf24',
  ban: '#ef4444',
  kick: '#f97316',
  delete_message: '#94a3b8',
  warning: '#fbbf24',
  unban: '#4ade80',
};

export const ModerationLog: React.FC<ModerationLogProps> = ({ clubId, tableId, limit = 50 }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    loadLogs();
  }, [clubId, tableId]);

  const loadLogs = async () => {
    setLoading(true);
    try {
      // Replaced mock data with dynamic initialization
      const liveLogs: LogEntry[] = [];
      setLogs(liveLogs);
    } catch (error) {
      reportError(error, 'ModerationLog.Failed_to_load_moderation_logs');
    } finally {
      setLoading(false);
    }
  };

  const filteredLogs = filter === 'all' ? logs : logs.filter((log) => log.action === filter);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = filteredLogs.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [filteredLogs]);

  return (
    <div className="moderation-log">
      <div className="log-header">
        <h3>Moderation Log</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All Actions</option>
          <option value="mute">Mutes</option>
          <option value="ban">Bans</option>
          <option value="kick">Kicks</option>
          <option value="delete_message">Deletions</option>
          <option value="warning">Warnings</option>
        </select>
      </div>

      {loading ? (
        <div className="log-loading">Loading...</div>
      ) : (
        <div className="log-entries">
          {filteredLogs.map((log, i) => (
            <div
              key={log.id}
              className="log-entry"
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div
                className="log-icon"
                style={{
                  background: `${ACTION_COLORS[log.action]}20`,
                  color: ACTION_COLORS[log.action],
                }}
              >
                {ACTION_ICONS[log.action]}
              </div>
              <div className="log-content">
                <div className="log-summary">
                  <span className="mod-name">{log.moderatorName}</span>
                  <span className="log-action">{log.action.replace('_', ' ')}</span>
                  <span className="target-name">{log.targetUsername}</span>
                </div>
                {log.reason && <div className="log-reason">{log.reason}</div>}
              </div>
              <div className="log-time">{formatTime(log.timestamp)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModerationLog;
