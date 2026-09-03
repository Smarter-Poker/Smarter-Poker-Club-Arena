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

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { CSV_BOM, toCSV } from '../../utils/clubSettingsRules';
import { reportError } from '../../utils/errorReporter';
import './StatsExport.css';
import { clubGamesOrFilter } from '../../utils/unionScope';
import { fetchAllRows } from '../../utils/fetchAllRows';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

interface StatsExportProps {
  clubId?: string;
  isOpen: boolean;
  onClose: () => void;
}

type Dataset = 'members' | 'hands';

/**
 * How many of a club's tables the hand export can scope through in one go.
 *
 * NOT a preference and NOT a row cap that should be paged away: every id is
 * placed in the query string of the FOLLOWING request, and ~1000 uuids makes
 * a 37 KB URL that servers reject with 414. Busy clubs hold far more tables
 * than this (36,403 for the largest when this was written), so the scope is
 * genuinely narrower than "the whole club" and the export now says so rather
 * than reporting a row count that reads as complete.
 *
 * The real answer is a server-side export that never puts ids in a URL. Until
 * that exists, honesty is the fix.
 */
const CLUB_TABLE_SCAN_LIMIT = 200;

export function StatsExport({ clubId, isOpen, onClose }: StatsExportProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [dataset, setDataset] = useState<Dataset>(clubId ? 'members' : 'hands');
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [exporting, setExporting] = useState(false);
  /** Set by fetchOwnHands when the club had more tables than one scan covers. */
  const handScopeWasClipped = useRef(false);
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
    /* AN EXPORT MUST NOT BE SILENTLY SHORT (2026-08-27). This stopped at
       5,000 members, so a club with 5,001 got a file missing one - with
       nothing on screen or in the file to say so, and an export is precisely
       the artefact an owner trusts. Pages instead; a failed page throws
       rather than writing a partial roster to disk. */
    const members = await fetchAllRows<any>(
      (from, to) =>
        supabase
          .from('club_members')
          .select(
            'user_id, role, status, joined_at, hands_played, sessions_played, total_rake_paid, chips_won, chips_lost, biggest_pot'
          )
          .eq('club_id', resolvedId)
          .order('hands_played', { ascending: false })
          .range(from, to),
      { label: 'StatsExport.memberStats' }
    );

    const ids = [...new Set((members || []).map((m: any) => m.user_id).filter(Boolean))];
    const nameMap: Record<string, string> = {};
    if (ids.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}`)
        .in('id', ids);
      (profiles || []).forEach((p: any) => {
        nameMap[p.id] = playerDisplayName(p);
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
    let query = supabase
      .from('hand_history')
      .select('*')
      .contains('players', [{ userId: user.id }]);

    if (clubId) {
      const resolvedId = await resolveClubUUID(clubId);
      // Every id goes into the query string of the next request; 1000 uuids
      // is a ~37 KB URL and servers answer 414. Newest tables first.
      const { data: clubTables, error: tablesErr } = await supabase
        .from('tables')
        .select('id')
        // P2-1: union-aware — include tables the club's union created
        .or(await clubGamesOrFilter(resolvedId))
        .order('created_at', { ascending: false })
        .limit(CLUB_TABLE_SCAN_LIMIT);
      if (tablesErr) throw tablesErr;
      /* SAY SO WHEN THE SCOPE WAS CLIPPED (2026-08-27). The 200 above is a
         real constraint, not an oversight - the comment explains it: every id
         rides in the next request's query string and ~1000 uuids is a 37 KB
         URL that servers answer 414. But a club can hold far more than 200
         tables (36,403 for the busiest one when this was written), and the
         export used to report "Exported N rows" with no hint that it had
         looked at only the newest 200. A number a club owner trusts must not
         quietly mean something narrower than it says. */
      handScopeWasClipped.current = (clubTables?.length ?? 0) >= CLUB_TABLE_SCAN_LIMIT;
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

    const { data, error } = await query.order('created_at', { ascending: false }).limit(5000);
    if (error) throw error;
    return data || [];
  };

  const exportStats = async () => {
    if (!user?.id) return;

    setExporting(true);
    try {
      handScopeWasClipped.current = false;
      const rows = dataset === 'members' ? await fetchMemberStats() : await fetchOwnHands();
      // convertToCSV([]) returns an empty string, so "no data" used to
      // download a 0-byte file and report success. Say so instead.
      if (rows.length === 0) {
        if (isMounted.current) {
          toast.error(
            dataset === 'members'
              ? 'No members to export yet.'
              : 'No hands found for this club in the selected range.'
          );
          setExporting(false);
        }
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const base = `${dataset === 'members' ? 'club-member-stats' : 'my-hand-history'}-${stamp}`;

      if (format === 'csv') {
        // Excel only reads a UTF-8 CSV as UTF-8 when it starts with a byte
        // order mark; without it every accented player name arrived mojibake.
        downloadFile(CSV_BOM + convertToCSV(rows), `${base}.csv`, 'text/csv;charset=utf-8');
      } else {
        downloadFile(
          JSON.stringify(rows, null, 2),
          `${base}.json`,
          'application/json;charset=utf-8'
        );
      }

      if (isMounted.current) {
        toast.success(`Exported ${rows.length.toLocaleString()} rows`);
        /* The count above is true but narrower than it sounds when the scope
           was clipped, and a club owner has no other way to learn that. */
        if (handScopeWasClipped.current) {
          toast.info(
            `Scoped To This Club's ${CLUB_TABLE_SCAN_LIMIT} Most Recent Tables. ` +
              'Older Hands Are Not In This File.'
          );
        }
      }
      onClose();
    } catch (error) {
      reportError(error, 'StatsExport.Failed_to_export');
      if (isMounted.current) toast.error('Failed to export stats');
    }
    if (isMounted.current) setExporting(false);
  };

  // CSV encoding (including the formula-injection guard) lives in
  // utils/clubSettingsRules so it can be unit tested — the inline version
  // shipped a bug that corrupted every negative number.
  const convertToCSV = (data: any[]) => toCSV(data);

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Anchor must be in the document for the click to count in some browsers,
    // and revoking the URL synchronously can cancel the download before it
    // starts — release it on the next tick instead.
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
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
                  Member Stats
                </button>
                <button
                  className={dataset === 'hands' ? 'active' : ''}
                  onClick={() => setDataset('hands')}
                >
                  My Hands
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
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
                <option value="90d">Last 90 Days</option>
                <option value="all">All Time</option>
              </select>
            </div>
          )}

          {dataset === 'members' && (
            <p className="option-hint" style={{ fontSize: '0.75rem', color: '#6a7a8a', margin: 0 }}>
              Full Roster With Lifetime Hands, Rake And Win/Loss Per Member.
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
