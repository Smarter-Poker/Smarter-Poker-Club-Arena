/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SECURITY BADGE — Reusable trust signal component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Composable trust indicators: Funds Secured, Verified, Processed
 */

import './SecurityBadge.css';

type BadgeVariant = 'secured' | 'verified' | 'processed' | 'escrow' | 'pending';

interface SecurityBadgeProps {
  variant: BadgeVariant;
  label?: string;
  /** Pulse animation for active states (e.g., escrow lock active) */
  pulse?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const BADGE_CONFIG: Record<BadgeVariant, { icon: string; defaultLabel: string; color: string }> = {
  secured: { icon: '*', defaultLabel: 'Funds Secured', color: '#00c853' },
  verified: { icon: '+', defaultLabel: 'Verified', color: '#448aff' },
  processed: { icon: '-', defaultLabel: 'Processed', color: '#00e676' },
  escrow: { icon: '*', defaultLabel: 'In Escrow', color: '#ffa726' },
  pending: { icon: '...', defaultLabel: 'Pending', color: '#fbbf24' },
};

export default function SecurityBadge({
  variant,
  label,
  pulse = false,
  size = 'md',
}: SecurityBadgeProps) {
  const cfg = BADGE_CONFIG[variant];
  return (
    <div
      className={`security-badge sb-${variant} sb-${size} ${pulse ? 'sb-pulse' : ''}`}
      style={
        {
          '--sb-color': cfg.color,
          '--sb-bg': `${cfg.color}12`,
          '--sb-border': `${cfg.color}30`,
        } as React.CSSProperties
      }
    >
      <span className="sb-icon">{cfg.icon}</span>
      <span className="sb-label">{label || cfg.defaultLabel}</span>
    </div>
  );
}

export { BADGE_CONFIG };
export type { BadgeVariant };
