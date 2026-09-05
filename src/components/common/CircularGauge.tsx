/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CircularGauge — Animated SVG Circular Progress Gauge
 *  Shows a metric as a percentage with animated fill and glow effects.
 *  Fully responsive, accent-color configurable, animated on mount.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';

interface CircularGaugeProps {
  value: number; // 0-100
  label: string;
  sublabel?: string;
  size?: number; // px (default 120)
  accent?: string; // color (default #00d4ff)
  strokeWidth?: number; // default 8
}

export default function CircularGauge({
  value,
  label,
  sublabel,
  size = 120,
  accent = '#00d4ff',
  strokeWidth = 8,
}: CircularGaugeProps) {
  const [animatedValue, setAnimatedValue] = useState(0);

  useEffect(() => {
    const timeout = setTimeout(() => setAnimatedValue(Math.min(100, Math.max(0, value))), 100);
    return () => clearTimeout(timeout);
  }, [value]);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (animatedValue / 100) * circumference;
  const offset = circumference - progress;
  const center = size / 2;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
      }}
    >
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          {/* Background track */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={strokeWidth}
          />
          {/* Progress arc */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={accent}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{
              transition: 'stroke-dashoffset 1s cubic-bezier(0.34, 1.56, 0.64, 1)',
              filter: `drop-shadow(0 0 6px ${accent}55)`,
            }}
          />
        </svg>
        {/* Center value */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
          }}
        >
          <span
            style={{
              fontSize: `${size * 0.2}px`,
              fontWeight: 700,
              fontFamily: "'Rajdhani', monospace",
              color: accent,
            }}
          >
            {/* Truncated, never rounded: STANDING_DIRECTIVES forbid rounding anywhere. */}
            {Math.trunc(animatedValue * 10) / 10}
          </span>
          <span
            style={{
              fontSize: `${size * 0.1}px`,
              color: accent,
              opacity: 0.7,
            }}
          >
            %
          </span>
        </div>
      </div>

      {/* Labels */}
      <span
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: '#fff',
          textAlign: 'center',
        }}
      >
        {label}
      </span>
      {sublabel && (
        <span
          style={{
            fontSize: '0.65rem',
            color: '#6a7a8a',
            textAlign: 'center',
            marginTop: '-0.25rem',
          }}
        >
          {sublabel}
        </span>
      )}
    </div>
  );
}
