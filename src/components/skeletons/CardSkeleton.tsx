import React from 'react';
import './CardSkeleton.css';

interface CardSkeletonProps {
  hasImage?: boolean;
  hasSubtitle?: boolean;
  lines?: number;
}

export const CardSkeleton: React.FC<CardSkeletonProps> = ({
  hasImage = true,
  hasSubtitle = true,
  lines = 2,
}) => {
  return (
    <div className="card-skeleton">
      {hasImage && <div className="skeleton-image shimmer" />}
      <div className="skeleton-content">
        <div className="skeleton-title shimmer" />
        {hasSubtitle && <div className="skeleton-subtitle shimmer" />}
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="skeleton-line shimmer" style={{ width: `${85 - i * 15}%` }} />
        ))}
      </div>
    </div>
  );
};

export default CardSkeleton;
