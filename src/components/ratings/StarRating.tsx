import React from 'react';
import './StarRating.css';

interface StarRatingProps {
  value: number;
  max?: number;
  onChange?: (rating: number) => void;
  readonly?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export const StarRating: React.FC<StarRatingProps> = ({
  value,
  max = 5,
  onChange,
  readonly = false,
  size = 'medium',
}) => {
  return (
    <div className={`star-rating size-${size} ${readonly ? 'readonly' : ''}`}>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={`star ${i < value ? 'filled' : ''}`}
          onClick={() => !readonly && onChange?.(i + 1)}
        >
          ★
        </span>
      ))}
    </div>
  );
};

export default StarRating;
