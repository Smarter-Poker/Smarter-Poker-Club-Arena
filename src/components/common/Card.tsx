/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD — Container & Layout Cards
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import './Card.css';

interface CardProps extends HTMLMotionProps<'div'> {
  children: React.ReactNode;
  variant?: 'default' | 'elevated' | 'outlined' | 'glass' | 'gradient';
  padding?: 'none' | 'small' | 'medium' | 'large';
  hoverable?: boolean;
  clickable?: boolean;
  className?: string;
}

/**
 * Base card component
 */
export function Card({
  children,
  variant = 'default',
  padding = 'medium',
  hoverable = false,
  clickable = false,
  className = '',
  ...props
}: CardProps) {
  return (
    <motion.div
      className={`card card-${variant} card-padding-${padding} ${hoverable ? 'card-hoverable' : ''} ${clickable ? 'card-clickable' : ''} ${className}`}
      whileHover={hoverable || clickable ? { y: -4, scale: 1.01 } : undefined}
      whileTap={clickable ? { scale: 0.99 } : undefined}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/**
 * Card header section
 */
export function CardHeader({
  title,
  subtitle,
  action,
  icon,
  className = '',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card-header ${className}`}>
      {icon && <div className="card-header-icon">{icon}</div>}
      <div className="card-header-content">
        <h3 className="card-title">{title}</h3>
        {subtitle && <p className="card-subtitle">{subtitle}</p>}
      </div>
      {action && <div className="card-header-action">{action}</div>}
    </div>
  );
}

/**
 * Card body/content section
 */
export function CardContent({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`card-content ${className}`}>{children}</div>;
}

/**
 * Card footer section
 */
export function CardFooter({
  children,
  align = 'right',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right' | 'space-between';
  className?: string;
}) {
  return <div className={`card-footer card-footer-${align} ${className}`}>{children}</div>;
}

/**
 * Stat card for displaying metrics
 */
export function StatCard({
  title,
  value,
  change,
  icon,
  trend,
  className = '',
}: {
  title: string;
  value: string | number;
  change?: string | number;
  icon?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}) {
  return (
    <Card variant="elevated" padding="medium" className={`card__stat-card ${className}`}>
      <div className="stat-card-header">
        <span className="stat-title">{title}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <div className="stat-value">{value}</div>
      {change !== undefined && (
        <div className={`stat-change stat-trend-${trend || 'neutral'}`}>
          {trend === 'up' && '↑'}
          {trend === 'down' && '↓'}
          {change}
        </div>
      )}
    </Card>
  );
}

/**
 * Feature card for showcasing features
 */
export function FeatureCard({
  icon,
  title,
  description,
  onClick,
  className = '',
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Card
      variant="glass"
      padding="large"
      clickable={!!onClick}
      onClick={onClick}
      className={`feature-card ${className}`}
    >
      <div className="card__feature-icon">{icon}</div>
      <h4 className="feature-title">{title}</h4>
      <p className="feature-description">{description}</p>
    </Card>
  );
}

export default Card;
