import React from 'react';
import './ProfileSkeleton.css';

interface ProfileSkeletonProps {
  variant?: 'full' | 'compact';
}

export const ProfileSkeleton: React.FC<ProfileSkeletonProps> = ({ variant = 'full' }) => {
  return (
    <div className={`profile-skeleton ${variant}`}>
      <div className="skeleton-avatar shimmer" />
      <div className="skeleton-info">
        <div className="skeleton-name shimmer" />
        <div className="skeleton-username shimmer" />
        {variant === 'full' && (
          <>
            <div className="skeleton-stats">
              <div className="skeleton-stat shimmer" />
              <div className="skeleton-stat shimmer" />
              <div className="skeleton-stat shimmer" />
            </div>
            <div className="skeleton-bio shimmer" />
          </>
        )}
      </div>
    </div>
  );
};

export default ProfileSkeleton;
