import React from 'react';
import './ThumbRating.css';

interface ThumbRatingProps {
  value: 'up' | 'down' | null;
  onChange: (value: 'up' | 'down' | null) => void;
  counts?: { up: number; down: number };
}

export const ThumbRating: React.FC<ThumbRatingProps> = ({ value, onChange, counts }) => {
  return (
    <div className="thumb-rating">
      <button
        className={`thumb up ${value === 'up' ? 'active' : ''}`}
        onClick={() => onChange(value === 'up' ? null : 'up')}
      >
        {counts && <span>{counts.up}</span>}
      </button>
      <button
        className={`thumb down ${value === 'down' ? 'active' : ''}`}
        onClick={() => onChange(value === 'down' ? null : 'down')}
      >
        {counts && <span>{counts.down}</span>}
      </button>
    </div>
  );
};

export default ThumbRating;
