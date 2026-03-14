/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STATS EXPORT — Download Player Statistics
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './StatsExport.css';

interface StatsExportProps {
  clubId?: string;
  isOpen: boolean;
  onClose: () => void;
}

export function StatsExport({ clubId, isOpen, onClose }: StatsExportProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [includeHands, setIncludeHands] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  const exportStats = async () => {
    if (!user?.id) return;

    setExporting(true);
    try {
      // Calculate date range
      const now = new Date();
      let startDate: Date | null = null;
      switch (dateRange) {
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
      }

      // Fetch stats
      let query = supabase.from('hand_history').select('*').eq('user_id', user.id);

      if (clubId) {
        query = query.eq('club_id', await resolveClubUUID(clubId));
      }
      if (startDate) {
        query = query.gte('created_at', startDate.toISOString());
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;

      // Format data
      if (format === 'csv') {
        const csv = convertToCSV(data || []);
        downloadFile(csv, 'stats.csv', 'text/csv');
      } else {
        const json = JSON.stringify(data || [], null, 2);
        downloadFile(json, 'stats.json', 'application/json');
      }

      toast.success('Stats exported successfully!');
      onClose();
    } catch (error) {
      toast.error('Failed to export stats');
    }
    setExporting(false);
  };

  const convertToCSV = (data: any[]) => {
    if (data.length === 0) return '';

    const headers = Object.keys(data[0]);
    const rows = data.map((row) => headers.map((h) => JSON.stringify(row[h] ?? '')).join(','));

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

          <div className="option-group">
            <label>Date Range</label>
            <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)}>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </div>

          <div className="option-group checkbox">
            <input
              type="checkbox"
              id="include-hands"
              checked={includeHands}
              onChange={(e) => setIncludeHands(e.target.checked)}
            />
            <label htmlFor="include-hands">Include hand histories</label>
          </div>
        </div>

        <button className="stats-export__button" onClick={exportStats} disabled={exporting}>
          {exporting ? 'Exporting...' : `Download ${format.toUpperCase()}`}
        </button>
      </div>
    </div>
  );
}

export default StatsExport;
