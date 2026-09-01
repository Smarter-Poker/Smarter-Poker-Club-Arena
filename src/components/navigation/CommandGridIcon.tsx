import { useId } from 'react';
import styles from './CommandGridIcon.module.css';

interface CommandGridIconProps {
  className?: string;
}

/**
 * Premium six-tile command grid used by every drawer trigger. It is deliberately
 * a two-dimensional command surface, never a stack of horizontal menu bars.
 */
export function CommandGridIcon({ className = '' }: CommandGridIconProps) {
  const gradientId = `command-grid-${useId().replace(/:/g, '')}`;

  return (
    <svg
      className={`${styles.root} ${className}`.trim()}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-command-grid="six-tile"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7fbff" />
          <stop offset="0.32" stopColor="#a8b3bf" />
          <stop offset="0.58" stopColor="#27313d" />
          <stop offset="0.8" stopColor="#36baff" />
          <stop offset="1" stopColor="#e7b95d" />
        </linearGradient>
      </defs>
      <rect className={styles.plate} x="3" y="3" width="42" height="42" rx="12" />
      {[7, 19, 31].flatMap((y) =>
        [8, 28].map((x) => (
          <rect
            key={`${x}-${y}`}
            className={styles.tile}
            x={x}
            y={y}
            width="12"
            height="10"
            rx="2.5"
            fill={`url(#${gradientId})`}
          />
        ))
      )}
    </svg>
  );
}
