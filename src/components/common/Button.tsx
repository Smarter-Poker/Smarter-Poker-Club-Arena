/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔘 BUTTON — Reusable Button Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { InlineLoader } from './LoadingSpinner';
import './Button.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warning' | 'gold';
type ButtonSize = 'small' | 'medium' | 'large';

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  className?: string;
}

/**
 * Main button component with variants and loading state
 */
export function Button({
  children,
  variant = 'primary',
  size = 'medium',
  loading = false,
  disabled = false,
  fullWidth = false,
  icon,
  iconPosition = 'left',
  className = '',
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <motion.button
      className={`btn btn-${variant} btn-${size} ${fullWidth ? 'btn-full' : ''} ${isDisabled ? 'btn-disabled' : ''} ${className}`}
      disabled={isDisabled}
      aria-busy={loading}
      aria-disabled={disabled}
      whileTap={!isDisabled ? { scale: 0.97 } : undefined}
      whileHover={!isDisabled ? { scale: 1.02 } : undefined}
      {...props}
    >
      {loading ? (
        <InlineLoader size={size === 'small' ? 14 : size === 'large' ? 20 : 16} />
      ) : (
        <>
          {icon && iconPosition === 'left' && (
            <span className="btn-icon btn-icon-left">{icon}</span>
          )}
          <span className="btn-text">{children}</span>
          {icon && iconPosition === 'right' && (
            <span className="btn-icon btn-icon-right">{icon}</span>
          )}
        </>
      )}
    </motion.button>
  );
}

/**
 * Icon-only button
 */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'medium',
  loading = false,
  disabled = false,
  className = '',
  ...props
}: {
  icon: React.ReactNode;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
} & Omit<HTMLMotionProps<'button'>, 'children'>) {
  return (
    <motion.button
      className={`icon-btn icon-btn-${variant} icon-btn-${size} ${disabled || loading ? 'btn-disabled' : ''} ${className}`}
      disabled={disabled || loading}
      aria-label={label}
      title={label}
      whileTap={!disabled && !loading ? { scale: 0.9 } : undefined}
      whileHover={!disabled && !loading ? { scale: 1.1 } : undefined}
      {...props}
    >
      {loading ? <InlineLoader size={size === 'small' ? 12 : size === 'large' ? 18 : 14} /> : icon}
    </motion.button>
  );
}

/**
 * Button group for related actions
 */
export function ButtonGroup({
  children,
  orientation = 'horizontal',
  spacing = 'normal',
}: {
  children: React.ReactNode;
  orientation?: 'horizontal' | 'vertical';
  spacing?: 'tight' | 'normal' | 'loose';
}) {
  return (
    <div className={`btn-group btn-group-${orientation} btn-group-${spacing}`}>{children}</div>
  );
}

/**
 * Poker action buttons (Fold, Call, Raise, etc.)
 */
export function PokerActionButton({
  action,
  amount,
  onClick,
  disabled = false,
  hotkey,
}: {
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
  amount?: number;
  onClick: () => void;
  disabled?: boolean;
  hotkey?: string;
}) {
  const config: Record<string, { variant: ButtonVariant; label: string }> = {
    fold: { variant: 'danger', label: 'Fold' },
    check: { variant: 'secondary', label: 'Check' },
    call: { variant: 'success', label: 'Call' },
    bet: { variant: 'primary', label: 'Bet' },
    raise: { variant: 'warning', label: 'Raise' },
    all_in: { variant: 'gold', label: 'All-In' },
  };

  const { variant, label } = config[action];

  return (
    <Button
      variant={variant}
      size="large"
      onClick={onClick}
      disabled={disabled}
      className="poker-action-btn"
    >
      <span className="poker-action-label">{label}</span>
      {amount !== undefined && amount > 0 && (
        <span className="poker-action-amount">{amount.toLocaleString()}</span>
      )}
      {hotkey && <span className="poker-action-hotkey">{hotkey}</span>}
    </Button>
  );
}

export default Button;
