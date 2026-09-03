import React, { useState } from 'react';
import './SortableTable.css';

interface Column<T> {
  key: keyof T;
  header: string;
  sortable?: boolean;
}

interface SortableTableProps<T> {
  columns: Column<T>[];
  data: T[];
}

export function SortableTable<T extends Record<string, unknown>>({
  columns,
  data,
}: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState<keyof T | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const handleSort = (key: keyof T) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('asc');
    }
  };

  const sortedData = [...data].sort((a, b) => {
    if (!sortKey) return 0;
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  return (
    <div className="sortable-table-container">
      <table className="sortable-table">
        <thead>
          <tr>
            {columns.map((col, idx) => (
              <th
                key={idx}
                onClick={() => col.sortable && handleSort(col.key)}
                className={col.sortable ? 'sortable' : ''}
              >
                {col.header}
                {col.sortable && sortKey === col.key && (
                  <span className="sort-icon">{sortOrder === 'asc' ? ' ↑' : ' ↓'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {columns.map((col, colIdx) => (
                <td key={colIdx}>{String(row[col.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default SortableTable;
