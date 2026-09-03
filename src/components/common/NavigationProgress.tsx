/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NAVIGATION PROGRESS BAR — YouTube-style top loading bar
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows a thin gradient bar at the top of the viewport during Suspense loading.
 * Renders when `isLoading` is true (controlled by parent via Suspense fallback).
 */

import { useState, useEffect } from 'react';
import './NavigationProgress.css';

export default function NavigationProgress() {
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Animate progress quickly at first, then slow down
    const t1 = setTimeout(() => setProgress(30), 50);
    const t2 = setTimeout(() => setProgress(60), 300);
    const t3 = setTimeout(() => setProgress(80), 800);
    const t4 = setTimeout(() => setProgress(90), 1500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, []);

  // Auto-hide after reaching 90%+ (parent unmounts when loading completes)
  useEffect(() => {
    if (progress >= 90) {
      const hideTimer = setTimeout(() => {
        setProgress(100);
        setTimeout(() => setVisible(false), 200);
      }, 500);
      return () => clearTimeout(hideTimer);
    }
  }, [progress]);

  if (!visible) return null;

  return (
    <div className="nav-progress" role="progressbar" aria-valuenow={progress}>
      <div className="nav-progress__bar" style={{ width: `${progress}%` }} />
    </div>
  );
}
