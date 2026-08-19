/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STATS EXPORT — Download Club / Player Statistics
 *
 *  2026-08-19 settings-page audit: this modal was labeled "Export Club Stats"
 *  but exported the CALLER'S OWN hand rows, platform-wide — hand_history RLS
 *  only lets a user read hands they played, and the query never scoped to the
 *  club at all. The "Include hand histories" checkbox was read by nothing.
 *
 *  Now there are two honest datasets:
 *    - "Member stats": the club roster with per-member lifetime aggregates
 *      (club_members is staff-readable under RLS: owner + club admins).
 *    - "My hand history": the caller's own hands, scoped to this club's
 *      tables when a club id is present.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import './StatsExport.css';

interface StatsExportProps {
  clubId?: string;
  isOpen: boolean;
  onClose: () => void;
}

type Dataset = 'members' | 'hands';

export function StatsExport({ clubId, isOpen, onClose }: StatsExportProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [dataset, setDataset] = useState<Dataset>(clubId ? 'members' : 'hands');
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [exporting, setExporting] = useState(false);
  const isMounted = useIsMounted();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  const rangeStart = (): Date | null => {
    const now = new Date();
    switch (dateRange) {
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case '90d':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      default:
        return null;
    }
  };

  /** Club roster with lifetime per-member aggregates. Staff-readable via RLS. */
  const fetchMemberStats = async (): Promise<any[]> => {
    if (!clubId) throw new Error('no club id');
    const resolvedId = await resolveClubUUID(clubId);
    const { data: members, error } = await supabase
      .from('club_members')
      .select(
        'user_id, role, status, joined_at, hands_played, sessions_played, total_rake_paid, chips_won, chips_lost, biggest_pot'
      )
      .eq('club_id', resolvedId)
      .order('hands_played', { ascending: false });
    if (error) throw error;

    const ids = [...new Set((members || []).map((m: any) => m.user_id).filter(Boolean))];
    const nameMap: Record<string, string> = {};
    if (ids.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .in('id', ids);
      (profiles || []).forEach((p: any) => {
        nameMap[p.id] = p.display_name || p.username || p.id.slice(0, 8);
      });
    }

    return (members || []).map((m: any) => ({
      player: nameMap[m.user_id] || (m.user_id || '').slice(0, 8),
      role: m.role || 'member',
      status: m.status || '',
      joined_at: m.joined_at || '',
      hands_played: m.hands_played ?? 0,
      sessions_played: m.sessions_played ?? 0,
      total_rake_paid: m.total_rake_paid ?? 0,
      chips_won: m.chips_won ?? 0,
      chips_lost: m.chips_lost ?? 0,
      biggest_pot: m.biggest_pot ?? 0,
    }));
  };

  /**
   * The caller's own hands (hand_history RLS caps reads at hands you played).
   * When a club id is present, scope through table_id -> tables.club_id.
   */
  const fetchOwnHands = async (): Promise<any[]> => {
    if (!user?.id) throw new Error('not signed in');
    let query = supabase.from('hand_history').select('*').contains('players', [{ userId: user.id }]);

    if (clubId) {
      const resolvedId = await resolveClubUUID(clubId);
      const { data: clubTables, error: tablesErr } = await supabase
        .from('tables')
        .select('id')
        .eq('club_id', resolvedId)
        .limit(1000);
      if (tablesErr) throw tablesErr;
      // No tables -> no hands in this club. An empty export is the honest
      // answer; silently widening to every club you ever played in is not.
      if (!clubTables || clubTables.length === 0) return [];
      query = query.in(
        'table_id',
        clubTables.map((t: any) => t.id)
      );
    }

    const startDate = rangeStart();
    if (startDate) {
      query = query.gte('created_at', startDate.toISOString());
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    return data || [];
  };

  const exportStats = async () => {
    if (!user?.id) return;

    setExporting(true);
    try {
      const rows = dataset === 'members' ? await fetchMemberStats() : await fetchOwnHands();
      const stamp = new Date().toISOString().slice(0, 10);
      const base = `${dataset === 'members' ? 'club-member-stats' : 'my-hand-history'}-${stamp}`;

      if (format === 'csv') {
        downloadFile(convertToCSV(rows), `${base}.csv`, 'text/csv');
      } else {
        downloadFile(JSON.stringify(rows, null, 2), `${base}.json`, 'application/json');
      }

      if (isMounted.current) toast.success('Stats exported successfully!');
      onClose();
    } catch (error) {
      reportError(error, 'StatsExport.Failed_to_export');
      if (isMounted.current) toast.error('Failed to export stats');
    }
    if (isMounted.current) setExporting(false);
  };

  const convertToCSV = (data: any[]) => {
    if (data.length === 0) return '';

    // Neutralize spreadsheet formula injection: a STRING cell beginning with
    // = + - or @ executes when the CSV is opened in Excel/Sheets, even when
    // the field is quoted. Numbers are inert — guarding them would corrupt
    // every negative value.
    const safeCell = (v: any) => {
      if (typeof v === 'string' && /^[=+\-@]/.test(v)) {
        return JSON.stringify(`'${v}`);
      }
      return JSON.stringify(v ?? '');
    };

    const headers = Object.keys(data[0]);
    const rows = data.map((row) => headers.map((h) => safeCell(row[h])).join(','));

    return [headers.join(','), ...rows].join('\n');
  };

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="stats-export-overlay" onClick={onClose}>
      <div
        className="stats-export"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="stats-export__header">
          <h3> Export Stats</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="stats-export__options">
          {clubId && (
            <div className="option-group">
              <label>Data</label>
              <div className="button-group">
                <button
                  className={dataset === 'members' ? 'active' : ''}
                  onClick={() => setDataset('members')}
                >
                  Member stats
                </button>
                <button
                  className={dataset === 'hands' ? 'active' : ''}
                  onClick={() => setDataset('hands')}
                >
                  My hands
                </button>
              </div>
            </div>
          )}

          <div className="option-group">
            <label>Format</label>
            <div className="button-group">
              <button className={format === 'csv' ? 'active' : ''} onClick={() => setFormat('csv')}>
                CSV
              </button>
              <button
                className={format === 'json' ? 'active' : ''}
                onClick={() => setFormat('json')}
              >
                JSON
              </button>
            </div>
          </div>

          {dataset === 'hands' && (
            <div className="option-group">
              <label>Date Range</label>
              <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)}>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
                <option value="all">All time</option>
              </select>
            </div>
          )}

          {dataset === 'members' && (
            <p className="option-hint" style={{ fontSize: '0.75rem', color: '#6a7a8a', margin: 0 }}>
              Full roster with lifetime hands, rake and win/loss per member.
            </p>
          )}
        </div>

        <button className="stats-export__button" onClick={exportStats} disabled={exporting}>
          {exporting ? 'Exporting...' : `Download ${format.toUpperCase()}`}
        </button>
      </div>
    </div>
  );
}

export default StatsExport;
