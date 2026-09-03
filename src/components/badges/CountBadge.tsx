import React from 'react';
import './CountBadge.css';

interface CountBadgeProps {
  count: number;
  max?: number;
  size?: 'small' | 'medium' | 'large';
  variant?: 'default' | 'primary' | 'danger';
}

export const CountBadge: React.FC<CountBadgeProps> = ({
  count,
  max = 99,
  size = 'medium',
  variant = 'default',
}) => {
  const displayCount = count > max ? `${max}+` : count.toString();

  if (count === 0) return null;

  return <span className={`count-badge size-${size} variant-${variant}`}>{displayCount}</span>;
};

export default CountBadge;
