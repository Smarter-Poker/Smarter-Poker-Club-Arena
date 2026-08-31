/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STATS EXPORT BUTTON — CSV export for stats data
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useCallback } from 'react';
import './StatsExportButton.css';

interface StatsExportButtonProps {
  /** Column headers */
  headers: string[];
  /** Rows of data (each row is an array of values) */
  rows: (string | number)[][];
  /** Filename for the CSV download */
  filename?: string;
  /** Optional label override */
  label?: string;
}

export default function StatsExportButton({
  headers,
  rows,
  filename = 'stats-export',
  label = 'Export CSV',
}: StatsExportButtonProps) {
  const handleExport = useCallback(() => {
    if (rows.length === 0) return;

    // Build CSV content
    const escapeCSV = (val: string | number) => {
      const str = String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };

    const csvLines = [
      headers.map(escapeCSV).join(','),
      ...rows.map((row) => row.map(escapeCSV).join(',')),
    ];

    const csvContent = csvLines.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();

    // Cleanup
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }, [headers, rows, filename]);

  if (rows.length === 0) return null;

  return (
    <button
      className="stats-export-btn"
      onClick={handleExport}
      title="Download As CSV"
      aria-label={`Export ${filename} Data As CSV`}
    >
      {label}
    </button>
  );
}
