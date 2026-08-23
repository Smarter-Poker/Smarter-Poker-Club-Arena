/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PageSkeleton — Reusable Shimmer Loading States
 * ═══════════════════════════════════════════════════════════════════════════════
 * Replace "Loading..." text and spinner divs with professional shimmer states.
 *
 * @example
 * if (loading) return <PageSkeleton variant="settings" />;
 */

import React from 'react';

const shimmerStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  borderRadius: 8,
  animation: 'animationsPulse 1.5s ease-in-out infinite',
};

const containerStyle: React.CSSProperties = {
  padding: '24px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

// Common a11y attributes for all skeleton containers
const statusAttrs = { role: 'status' as const, 'aria-label': 'Loading content' };

function ShimmerBar({ width = '100%', height = 14 }: { width?: string | number; height?: number }) {
  return <div style={{ ...shimmerStyle, width, height }} />;
}

function ShimmerCircle({ size = 48 }: { size?: number }) {
  return <div style={{ ...shimmerStyle, width: size, height: size, borderRadius: '50%' }} />;
}

/** Card-shaped skeleton block */
function ShimmerCard({ height = 100 }: { height?: number }) {
  return <div style={{ ...shimmerStyle, width: '100%', height, borderRadius: 12 }} />;
}

interface PageSkeletonProps {
  variant?: 'default' | 'settings' | 'dashboard' | 'list' | 'stats' | 'financial';
}

export default function PageSkeleton({ variant = 'default' }: PageSkeletonProps) {
  if (variant === 'settings') {
    return (
      <div style={containerStyle} {...statusAttrs}>
        <ShimmerBar width="40%" height={24} />
        <ShimmerCard height={60} />
        <ShimmerBar width="35%" height={24} />
        <ShimmerCard height={80} />
        <ShimmerBar width="30%" height={24} />
        <ShimmerCard height={120} />
      </div>
    );
  }

  if (variant === 'dashboard') {
    return (
      <div style={containerStyle} {...statusAttrs}>
        {/* Stats row */}
        <div style={{ display: 'flex', gap: 12 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} style={{ flex: 1 }}>
              <ShimmerCard height={72} />
            </div>
          ))}
        </div>
        {/* Chart area */}
        <ShimmerCard height={180} />
        {/* Content rows */}
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <ShimmerCircle size={40} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ShimmerBar width={`${60 + i * 5}%`} height={14} />
              <ShimmerBar width={`${40 + i * 3}%`} height={10} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'list') {
    return (
      <div style={containerStyle} {...statusAttrs}>
        <ShimmerBar width="50%" height={20} />
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <ShimmerCircle size={44} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ShimmerBar width={`${50 + i * 8}%`} height={14} />
              <ShimmerBar width={`${30 + i * 5}%`} height={10} />
            </div>
            <ShimmerBar width={60} height={14} />
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'stats') {
    return (
      <div style={containerStyle} {...statusAttrs}>
        {/* Header */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ShimmerCircle size={56} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ShimmerBar width="60%" height={20} />
            <ShimmerBar width="40%" height={14} />
          </div>
        </div>
        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[1, 2, 3, 4].map((i) => (
            <ShimmerCard key={i} height={64} />
          ))}
        </div>
        {/* Chart */}
        <ShimmerCard height={200} />
      </div>
    );
  }

  if (variant === 'financial') {
    return (
      <div style={containerStyle} {...statusAttrs}>
        {/* Period tabs */}
        <div style={{ display: 'flex', gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <ShimmerBar key={i} width={80} height={32} />
          ))}
        </div>
        {/* Chart */}
        <ShimmerCard height={180} />
        {/* Summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[1, 2, 3, 4].map((i) => (
            <ShimmerCard key={i} height={60} />
          ))}
        </div>
        {/* Transactions */}
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <ShimmerCircle size={32} />
            <div style={{ flex: 1 }}>
              <ShimmerBar width={`${50 + i * 10}%`} height={14} />
            </div>
            <ShimmerBar width={60} height={14} />
          </div>
        ))}
      </div>
    );
  }

  // Default variant
  return (
    <div style={containerStyle} {...statusAttrs}>
      <ShimmerBar width="50%" height={20} />
      <ShimmerCard height={120} />
      <ShimmerCard height={80} />
      <ShimmerBar width="70%" height={14} />
      <ShimmerCard height={100} />
    </div>
  );
}

export { ShimmerBar, ShimmerCircle, ShimmerCard };
