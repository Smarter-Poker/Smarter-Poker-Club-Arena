import React from 'react';
import './Grid.css';

interface GridProps {
  children: React.ReactNode;
  columns?: number;
  gap?: number;
  minItemWidth?: number;
}

export const Grid: React.FC<GridProps> = ({ children, columns, gap = 16, minItemWidth = 240 }) => {
  const style: React.CSSProperties = columns
    ? {
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap,
      }
    : {
        gridTemplateColumns: `repeat(auto-fit, minmax(${minItemWidth}px, 1fr))`,
        gap,
      };

  return (
    <div className="responsive-grid" style={style}>
      {children}
    </div>
  );
};

export default Grid;
