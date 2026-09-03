import React from 'react';
import './TableRowSkeleton.css';

interface TableRowSkeletonProps {
  columns?: number;
  rows?: number;
}

export const TableRowSkeleton: React.FC<TableRowSkeletonProps> = ({ columns = 5, rows = 5 }) => {
  return (
    <div className="table-row-skeleton">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="skeleton-row">
          {Array.from({ length: columns }).map((_, colIndex) => (
            <div
              key={colIndex}
              className="skeleton-cell shimmer"
              style={{
                width: colIndex === 0 ? '30%' : `${60 / (columns - 1)}%`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

export default TableRowSkeleton;
