/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SKELETON LOADER — Loading State Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './Skeleton.css';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: 'text' | 'circular' | 'rectangular' | 'rounded';
  className?: string;
  animation?: 'pulse' | 'wave' | 'none';
}

/**
 * Base skeleton component for loading states
 */
export function Skeleton({
  width = '100%',
  height = '1rem',
  variant = 'text',
  className = '',
  animation = 'pulse',
}: SkeletonProps) {
  const style: React.CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
  };

  return (
    <div
      className={`skeleton skeleton-${variant} skeleton-${animation} ${className}`}
      style={style}
    />
  );
}

/**
 * Avatar skeleton
 */
export function SkeletonAvatar({ size = 40 }: { size?: number }) {
  return <Skeleton variant="circular" width={size} height={size} />;
}

/**
 * Text line skeleton
 */
export function SkeletonText({ width = '100%' }: { width?: string | number }) {
  return <Skeleton variant="text" width={width} height={16} />;
}

/**
 * Button skeleton
 */
export function SkeletonButton({ width = 100, height = 36 }: { width?: number; height?: number }) {
  return <Skeleton variant="rounded" width={width} height={height} />;
}

/**
 * Card skeleton
 */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`skeleton-card ${className}`}>
      <div className="skeleton-card-header">
        <SkeletonAvatar size={48} />
        <div className="skeleton-card-header-text">
          <Skeleton width="60%" height={16} />
          <Skeleton width="40%" height={12} />
        </div>
      </div>
      <Skeleton width="100%" height={120} variant="rectangular" />
      <div className="skeleton-card-content">
        <Skeleton width="100%" height={14} />
        <Skeleton width="80%" height={14} />
      </div>
    </div>
  );
}

/**
 * Table row skeleton
 */
export function SkeletonTableRow({ columns = 4 }: { columns?: number }) {
  return (
    <div className="skeleton-table-row">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} width={`${100 / columns}%`} height={16} />
      ))}
    </div>
  );
}

/**
 * Poker seat skeleton
 */
export function SkeletonPokerSeat() {
  return (
    <div className="skeleton-poker-seat">
      <SkeletonAvatar size={56} />
      <Skeleton width={80} height={14} />
      <Skeleton width={60} height={12} />
    </div>
  );
}

/**
 * Club card skeleton
 */
export function SkeletonClubCard() {
  return (
    <div className="skeleton-club-card">
      <Skeleton width="100%" height={100} variant="rectangular" />
      <div className="skeleton-club-card-content">
        <Skeleton width="70%" height={18} />
        <Skeleton width="50%" height={14} />
        <div className="skeleton-club-card-stats">
          <Skeleton width={60} height={12} />
          <Skeleton width={60} height={12} />
        </div>
      </div>
    </div>
  );
}

/**
 * Tournament card skeleton
 */
export function SkeletonTournamentCard() {
  return (
    <div className="skeleton-tournament-card">
      <div className="skeleton-tournament-header">
        <Skeleton width={60} height={60} variant="rounded" />
        <div className="skeleton-tournament-info">
          <Skeleton width="80%" height={16} />
          <Skeleton width="60%" height={12} />
        </div>
      </div>
      <div className="skeleton-tournament-details">
        <Skeleton width="100%" height={40} variant="rectangular" />
      </div>
      <SkeletonButton width={100} height={32} />
    </div>
  );
}

/**
 * List item skeleton
 */
export function SkeletonListItem() {
  return (
    <div className="skeleton-list-item">
      <SkeletonAvatar size={40} />
      <div className="skeleton-list-item-content">
        <Skeleton width="60%" height={14} />
        <Skeleton width="40%" height={12} />
      </div>
    </div>
  );
}

/**
 * Page skeleton with header
 */
export function SkeletonPage({ children }: { children?: React.ReactNode }) {
  return (
    <div className="skeleton-page">
      <div className="skeleton-page-header">
        <Skeleton width={200} height={28} />
        <Skeleton width={100} height={36} variant="rounded" />
      </div>
      {children || (
        <div className="skeleton-page-content">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}
    </div>
  );
}

export default Skeleton;
