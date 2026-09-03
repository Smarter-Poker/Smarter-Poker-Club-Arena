/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROGRESS — Progress Bars & Indicators
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { motion } from 'framer-motion';
import './Progress.css';

interface ProgressProps {
  value: number;
  max?: number;
  size?: 'small' | 'medium' | 'large';
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'gradient';
  showLabel?: boolean;
  label?: string;
  animated?: boolean;
  className?: string;
}

/**
 * Linear progress bar
 */
export function Progress({
  value,
  max = 100,
  size = 'medium',
  variant = 'default',
  showLabel = false,
  label,
  animated = true,
  className = '',
}: ProgressProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className={`progress-wrapper ${className}`}>
      {(showLabel || label) && (
        <div className="progress-header">
          <span className="progress-label">{label}</span>
          {showLabel && <span className="progress-value">{Math.round(percentage)}%</span>}
        </div>
      )}
      <div className={`progress progress-${size}`}>
        <motion.div
          className={`progress-bar progress-${variant}`}
          initial={animated ? { width: 0 } : false}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

/**
 * Circular progress indicator
 */
export function CircularProgress({
  value,
  max = 100,
  size = 80,
  strokeWidth = 8,
  variant = 'default',
  showLabel = true,
  className = '',
}: {
  value: number;
  max?: number;
  size?: number;
  strokeWidth?: number;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'gradient';
  showLabel?: boolean;
  className?: string;
}) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className={`circular-progress ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          className="circular-progress-bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <motion.circle
          className={`circular-progress-bar circular-${variant}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          style={{
            strokeDasharray: circumference,
            strokeLinecap: 'round',
            transform: 'rotate(-90deg)',
            transformOrigin: 'center',
          }}
        />
      </svg>
      {showLabel && <div className="circular-progress-label">{Math.round(percentage)}%</div>}
    </div>
  );
}

/**
 * Step progress for multi-step flows
 */
export function StepProgress({
  steps,
  currentStep,
  orientation = 'horizontal',
  size = 'medium',
}: {
  steps: Array<{ label: string; description?: string }>;
  currentStep: number;
  orientation?: 'horizontal' | 'vertical';
  size?: 'small' | 'medium' | 'large';
}) {
  return (
    <div className={`step-progress step-progress-${orientation} step-progress-${size}`}>
      {steps.map((step, index) => (
        <div
          key={index}
          className={`step-item ${index < currentStep ? 'completed' : ''} ${index === currentStep ? 'current' : ''}`}
        >
          <div className="step-indicator">{index < currentStep ? '' : index + 1}</div>
          <div className="step-content">
            <span className="step-label">{step.label}</span>
            {step.description && <span className="step-description">{step.description}</span>}
          </div>
          {index < steps.length - 1 && <div className="step-connector" />}
        </div>
      ))}
    </div>
  );
}

/**
 * Poker blind level progress
 */
export function BlindLevelProgress({
  currentLevel,
  totalLevels,
  timeRemaining,
  smallBlind,
  bigBlind,
  ante,
}: {
  currentLevel: number;
  totalLevels: number;
  timeRemaining: number; // seconds
  smallBlind: number;
  bigBlind: number;
  ante?: number;
}) {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;

  return (
    <div className="blind-level-progress">
      <div className="blind-level-header">
        <span className="blind-level-number">Level {currentLevel}</span>
        <span className="blind-level-timer">
          {minutes}:{seconds.toString().padStart(2, '0')}
        </span>
      </div>
      <Progress value={currentLevel} max={totalLevels} size="small" variant="gradient" />
      <div className="blind-level-details">
        <span className="blinds">
          {smallBlind}/{bigBlind}
        </span>
        {ante && <span className="ante">Ante: {ante}</span>}
      </div>
    </div>
  );
}

export default Progress;
