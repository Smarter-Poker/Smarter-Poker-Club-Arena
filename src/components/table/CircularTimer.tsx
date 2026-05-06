/**
 * ♠ CLUB ARENA — Circular Timer Arc
 * ═══════════════════════════════════════════════════════════════════════════════
 * premium-style SVG arc timer that wraps around the player's avatar.
 * Replaces the linear progress bar with a professional circular countdown.
 *
 * - Green (>50%) → Yellow (25-50%) → Orange (10-25%) → Red (<10%)
 * - Pulsing glow when below 15%
 * - Shows countdown number overlay when <5 seconds remaining
 */

import React, { memo } from 'react';

interface CircularTimerProps {
  progress: number; // 0-100 (100 = full, 0 = expired)
  size?: number; // Diameter in px (should match avatar + padding)
  strokeWidth?: number;
  showCountdown?: boolean; // Show seconds overlay in center
  secondsLeft?: number; // Actual seconds remaining (for countdown)
}

/** Returns the stroke color based on remaining progress */
function getTimerColor(progress: number): string {
  if (progress > 50) return '#22C55E'; // Green
  if (progress > 25) return '#EAB308'; // Yellow
  if (progress > 10) return '#F97316'; // Orange
  return '#EF4444'; // Red
}

/** Returns glow shadow color */
function getGlowColor(progress: number): string {
  if (progress > 50) return 'rgba(34, 197, 94, 0.5)';
  if (progress > 25) return 'rgba(234, 179, 8, 0.5)';
  if (progress > 10) return 'rgba(249, 115, 22, 0.5)';
  return 'rgba(239, 68, 68, 0.6)';
}

export const CircularTimer = memo(function CircularTimer({
  progress,
  size = 64,
  strokeWidth = 3,
  showCountdown = true,
  secondsLeft,
}: CircularTimerProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // Progress clamped 0-100
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const dashOffset = circumference * (1 - clampedProgress / 100);

  const color = getTimerColor(clampedProgress);
  const glowColor = getGlowColor(clampedProgress);
  const isPulsing = clampedProgress <= 15;
  const showSeconds = showCountdown && secondsLeft !== undefined && secondsLeft <= 5;

  return (
    <svg
      className={`circular-timer${isPulsing ? ' circular-timer--pulse' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%) rotate(-90deg)',
        pointerEvents: 'none',
        filter: isPulsing
          ? `drop-shadow(0 0 6px ${glowColor})`
          : `drop-shadow(0 0 3px ${glowColor})`,
      }}
    >
      {/* Background track */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="rgba(255, 255, 255, 0.08)"
        strokeWidth={strokeWidth}
      />

      {/* Progress arc */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        style={{
          transition: 'stroke-dashoffset 0.4s ease-out, stroke 0.3s ease',
        }}
      />

      {/* Countdown number */}
      {showSeconds && (
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize={size * 0.28}
          fontWeight="700"
          fontFamily="system-ui, -apple-system, sans-serif"
          style={{ transform: 'rotate(90deg)', transformOrigin: 'center' }}
        >
          {secondsLeft}
        </text>
      )}
    </svg>
  );
});

export default CircularTimer;
