/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE — Data Table Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './Table.css';

interface Column<T> {
  key: string;
  header: React.ReactNode;
  render?: (item: T, index: number) => React.ReactNode;
  width?: string | number;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
}

interface TableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T, index: number) => string;
  onRowClick?: (item: T, index: number) => void;
  emptyMessage?: string;
  loading?: boolean;
  striped?: boolean;
  hoverable?: boolean;
  compact?: boolean;
  className?: string;
}

/**
 * Data table component
 */
export function Table<T>({
  data,
  columns,
  keyExtractor,
  onRowClick,
  emptyMessage = 'No data available',
  loading = false,
  striped = false,
  hoverable = true,
  compact = false,
  className = '',
}: TableProps<T>) {
  const getCellValue = (item: T, column: Column<T>, index: number) => {
    if (column.render) {
      return column.render(item, index);
    }
    return (item as Record<string, unknown>)[column.key] as React.ReactNode;
  };

  return (
    <div className={`table-container ${className}`}>
      <table
        className={`table ${striped ? 'table-striped' : ''} ${hoverable ? 'table-hoverable' : ''} ${compact ? 'table-compact' : ''}`}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width, textAlign: column.align }}
                className={column.sortable ? 'sortable' : ''}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="table-loading">
                Loading...
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((item, index) => (
              <tr
                key={keyExtractor(item, index)}
                onClick={() => onRowClick?.(item, index)}
                className={onRowClick ? 'clickable' : ''}
              >
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align }}>
                    {getCellValue(item, column, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Simple table for basic layouts
 */
export function SimpleTable({
  children,
  striped = false,
  hoverable = true,
  compact = false,
  className = '',
}: {
  children: React.ReactNode;
  striped?: boolean;
  hoverable?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={`table-container ${className}`}>
      <table
        className={`table ${striped ? 'table-striped' : ''} ${hoverable ? 'table-hoverable' : ''} ${compact ? 'table-compact' : ''}`}
      >
        {children}
      </table>
    </div>
  );
}

/**
 * Leaderboard table (poker specific)
 */
export function LeaderboardTable({
  entries,
  showRankChange = true,
}: {
  entries: Array<{
    rank: number;
    name: string;
    avatar?: string;
    score: number;
    change?: number;
    extra?: React.ReactNode;
  }>;
  showRankChange?: boolean;
}) {
  const getRankBadge = (rank: number) => {
    if (rank === 1) return '1st';
    if (rank === 2) return '2nd';
    if (rank === 3) return '3rd';
    return `#${rank}`;
  };

  return (
    <div className="leaderboard-table">
      {entries.map((entry, index) => (
        <div
          key={index}
          className={`leaderboard-row ${entry.rank <= 3 ? `rank-${entry.rank}` : ''}`}
        >
          <div className="leaderboard-rank">{getRankBadge(entry.rank)}</div>
          <div className="leaderboard-player">
            {entry.avatar && (
              <img
                loading="lazy"
                decoding="async"
                src={entry.avatar}
                alt={entry.name}
                className="leaderboard-avatar"
              />
            )}
            <span className="leaderboard-name">{entry.name}</span>
          </div>
          <div className="leaderboard-score">{entry.score.toLocaleString()}</div>
          {showRankChange && entry.change !== undefined && (
            <div
              className={`leaderboard-change ${entry.change > 0 ? 'up' : entry.change < 0 ? 'down' : ''}`}
            >
              {entry.change > 0 && '▲'}
              {entry.change < 0 && '▼'}
              {entry.change !== 0 && Math.abs(entry.change)}
            </div>
          )}
          {entry.extra && <div className="leaderboard-extra">{entry.extra}</div>}
        </div>
      ))}
    </div>
  );
}

export default Table;
