/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL ACHIEVEMENT BADGE — Unlock badges for financial milestones
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import './FinancialAchievementBadge.css';

type BadgeType = 'first_cashout' | 'thousand_club' | 'perfect_settlement' | 'diamond_whale';

interface FinancialAchievementBadgeProps {
  type: BadgeType;
  unlocked: boolean;
  /** Whether to show the unlock pop animation */
  justUnlocked?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const BADGES: Record<
  BadgeType,
  { icon: string; title: string; description: string; color: string }
> = {
  first_cashout: {
    icon: '→',
    title: 'First Cashout',
    description: 'Completed Your First Successful Cashout',
    color: '#00c853',
  },
  thousand_club: {
    icon: '◆',
    title: '1,000 Club',
    description: 'Lifetime Earnings Exceeded 1,000 Chips',
    color: '#ffd700',
  },
  perfect_settlement: {
    icon: '★',
    title: 'Perfect Settlement',
    description: 'Zero-Debt Weekly Settlement Cycle',
    color: '#448aff',
  },
  diamond_whale: {
    icon: '◆',
    title: 'Diamond Whale',
    description: 'Accumulated 10,000+ Diamonds',
    color: '#c084fc',
  },
};

export default function FinancialAchievementBadge({
  type,
  unlocked,
  justUnlocked = false,
  size = 'md',
}: FinancialAchievementBadgeProps) {
  const badge = BADGES[type];

  return (
    <div
      className={`fab-card fab-${size} ${unlocked ? 'fab-unlocked' : 'fab-locked'} ${justUnlocked ? 'fab-just-unlocked' : ''}`}
      style={{ '--fab-color': badge.color } as React.CSSProperties}
    >
      <div className="fab-icon-wrap">
        <span className="fab-icon">{badge.icon}</span>
        {unlocked && <div className="fab-shimmer" />}
      </div>
      <div className="fab-content">
        <span className="fab-title">{badge.title}</span>
        <span className="fab-desc">{badge.description}</span>
      </div>
      {!unlocked && <span className="fab-lock">◈</span>}
    </div>
  );
}

export { BADGES };
export type { BadgeType };
