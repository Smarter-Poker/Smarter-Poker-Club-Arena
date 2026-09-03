import React from 'react';
import './ListSkeleton.css';

interface ListSkeletonProps {
  items?: number;
  hasAvatar?: boolean;
  hasAction?: boolean;
}

export const ListSkeleton: React.FC<ListSkeletonProps> = ({
  items = 5,
  hasAvatar = true,
  hasAction = false,
}) => {
  return (
    <div className="list-skeleton">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="skeleton-list-item">
          {hasAvatar && <div className="skeleton-avatar shimmer" />}
          <div className="skeleton-text">
            <div className="skeleton-primary shimmer" />
            <div className="skeleton-secondary shimmer" />
          </div>
          {hasAction && <div className="skeleton-action shimmer" />}
        </div>
      ))}
    </div>
  );
};

export default ListSkeleton;
