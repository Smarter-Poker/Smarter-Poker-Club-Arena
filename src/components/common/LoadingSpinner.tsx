/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOADING SPINNER — Various Loading Indicators
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './LoadingSpinner.css';

interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large';
  variant?: 'spinner' | 'dots' | 'pulse' | 'chips';
  label?: string;
  fullScreen?: boolean;
  className?: string;
}

/**
 * Main loading spinner component
 */
export function LoadingSpinner({
  size = 'medium',
  variant = 'spinner',
  label,
  fullScreen = false,
  className = '',
}: LoadingSpinnerProps) {
  const content = (
    <div className={`loading-spinner-container loading-${size} ${className}`}>
      {variant === 'spinner' && (
        <div className="spinner">
          <div className="spinner-ring" />
        </div>
      )}
      {variant === 'dots' && (
        <div className="loading-dots">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      )}
      {variant === 'pulse' && (
        <div className="loading-pulse">
          <div className="pulse-circle" />
        </div>
      )}
      {variant === 'chips' && (
        <div className="loading-chips">
          <span className="chip chip-1"></span>
          <span className="chip chip-2"></span>
          <span className="chip chip-3"></span>
        </div>
      )}
      {label && <span className="loading-label">{label}</span>}
    </div>
  );

  if (fullScreen) {
    return <div className="loading-fullscreen">{content}</div>;
  }

  return content;
}

/**
 * Inline loading indicator (for buttons, etc.)
 */
export function InlineLoader({ size = 16 }: { size?: number }) {
  return <span className="inline-loader" style={{ width: size, height: size }} />;
}

/**
 * Page loading overlay
 */
export function PageLoader({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="page-loader">
      <LoadingSpinner size="large" variant="spinner" />
      <p className="page-loader-message">{message}</p>
    </div>
  );
}

/**
 * Table loading state (poker table specific)
 */
export function TableLoader() {
  return (
    <div className="table-loader">
      <LoadingSpinner size="large" variant="chips" />
      <p className="table-loader-message">Setting Up Table...</p>
    </div>
  );
}

/**
 * Card loading placeholder
 */
export function CardLoader() {
  return (
    <div className="card-loader">
      <div className="card-loader-back">
        <span className="card-pattern">♠</span>
      </div>
    </div>
  );
}

export default LoadingSpinner;
