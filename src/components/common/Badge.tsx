/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BADGE — Status & Label Badges
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './Badge.css';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'vip';
  size?: 'small' | 'medium' | 'large';
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

/**
 * Base badge component
 */
export function Badge({
  children,
  variant = 'default',
  size = 'medium',
  dot = false,
  pulse = false,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={`badge badge-${variant} badge-${size} ${pulse ? 'badge-pulse' : ''} ${className}`}
    >
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

/**
 * VIP level badge
 */
export function VIPBadge({
  level,
}: {
  level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | string;
}) {
  const icons: Record<string, string> = {
    bronze: '',
    silver: '',
    gold: '',
    platinum: '',
    diamond: '',
  };

  // Don't render badge for invalid/empty/none levels
  const validLevels = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  if (!level || !validLevels.includes(level.toLowerCase())) {
    return null;
  }

  const normalizedLevel = level.toLowerCase();

  return (
    <Badge variant="vip" className={`vip-${normalizedLevel}`}>
      {icons[normalizedLevel]} {normalizedLevel.toUpperCase()}
    </Badge>
  );
}

/**
 * Online/offline status badge
 */
export function StatusBadge({ online }: { online: boolean }) {
  return (
    <Badge variant={online ? 'success' : 'default'} size="small" dot pulse={online}>
      {online ? 'Online' : 'Offline'}
    </Badge>
  );
}

/**
 * Position badge for poker
 */
export function PositionBadge({
  position,
}: {
  position: 'BTN' | 'SB' | 'BB' | 'UTG' | 'CO' | 'HJ';
}) {
  const variants: Record<string, BadgeProps['variant']> = {
    BTN: 'primary',
    SB: 'warning',
    BB: 'warning',
    UTG: 'info',
    CO: 'info',
    HJ: 'info',
  };

  return (
    <Badge variant={variants[position]} size="small">
      {position}
    </Badge>
  );
}

/**
 * Tournament status badge
 */
export function TournamentStatusBadge({
  status,
}: {
  status:
    | 'registering'
    | 'running'
    | 'late_reg'
    | 'on_break'
    | 'final_table'
    | 'finished'
    | 'cancelled';
}) {
  const config: Record<string, { variant: BadgeProps['variant']; label: string; pulse?: boolean }> =
    {
      registering: { variant: 'info', label: 'Registering', pulse: true },
      running: { variant: 'success', label: 'In Progress', pulse: true },
      late_reg: { variant: 'warning', label: 'Late Registration' },
      on_break: { variant: 'secondary', label: 'On Break' },
      final_table: { variant: 'primary', label: 'Final Table', pulse: true },
      finished: { variant: 'default', label: 'Finished' },
      cancelled: { variant: 'error', label: 'Cancelled' },
    };

  const { variant, label, pulse } = config[status];

  return (
    <Badge variant={variant} pulse={pulse}>
      {label}
    </Badge>
  );
}

/**
 * Notification count badge
 */
export function CountBadge({ count, max = 99 }: { count: number; max?: number }) {
  if (count <= 0) return null;

  return <span className="count-badge">{count > max ? `${max}+` : count}</span>;
}

/**
 * New/updated indicator badge
 */
export function NewBadge() {
  return (
    <Badge variant="primary" size="small">
      NEW
    </Badge>
  );
}

/**
 * Pro/Premium badge
 */
export function ProBadge() {
  return (
    <Badge variant="vip" size="small">
      PRO
    </Badge>
  );
}

export default Badge;
