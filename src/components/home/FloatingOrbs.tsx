import React, { useMemo } from 'react';
import styles from './FloatingOrbs.module.css';

interface FloatingOrbsProps {
  count?: number;
  color?: string; // e.g. 'rgba(0, 212, 255, 0.8)'
}

export default function FloatingOrbs({
  count = 20,
  color = 'rgba(0, 212, 255, 0.8)',
}: FloatingOrbsProps) {
  // Generate random properties for orbs on mount to prevent re-render jumping
  const orbs = useMemo(() => {
    return Array.from({ length: count }).map((_, i) => {
      // Random starting positions (0-100% of viewport)
      const left = Math.random() * 100;
      const top = Math.random() * 100;

      // Random sizes between 2px and 6px
      const size = 2 + Math.random() * 4;

      // Random animation duration (15s to 35s for slow drifting)
      const duration = 15 + Math.random() * 20;

      // Negative random delay so they are already moving when the page loads
      const delay = -(Math.random() * 40);

      // Random travel distances: up to +/- 50vh and +/- 50vw
      // Orbs should travel significant distances to "float around from different areas"
      const travelX = (Math.random() - 0.5) * 100; // -50vw to +50vw
      const travelY = (Math.random() - 0.5) * 100; // -50vh to +50vh

      // Random max opacity based on size (smaller = dimmer)
      const maxOpacity = 0.2 + (size / 6) * 0.6; // 0.2 to 0.8

      return {
        id: i,
        left: `${left}%`,
        top: `${top}%`,
        size: `${size}px`,
        duration: `${duration}s`,
        delay: `${delay}s`,
        tx: `${travelX}vw`,
        ty: `${travelY}vh`,
        maxOpacity,
      };
    });
  }, [count]);

  return (
    <div className={styles.container} aria-hidden="true">
      {orbs.map((orb) => (
        <div
          key={orb.id}
          className={styles.orb}
          style={
            {
              left: orb.left,
              top: orb.top,
              width: orb.size,
              height: orb.size,
              background: color,
              animationDuration: orb.duration,
              animationDelay: orb.delay,
              '--tx': orb.tx,
              '--ty': orb.ty,
              '--max-opacity': orb.maxOpacity,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
