import React from 'react';
import './Masonry.css';

interface MasonryProps {
  children: React.ReactNode;
  columns?: number;
  gap?: number;
}

export const Masonry: React.FC<MasonryProps> = ({ children, columns = 3, gap = 16 }) => {
  return (
    <div
      className="masonry"
      style={{
        columnCount: columns,
        columnGap: gap,
      }}
    >
      {React.Children.map(children, (child) => (
        <div className="masonry-item" style={{ marginBottom: gap }}>
          {child}
        </div>
      ))}
    </div>
  );
};

export default Masonry;
